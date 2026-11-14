import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { signRazorpayPayload, signStripePayload, runBillingReconciliation, platformSecretOpener } from "@wim/billing";
import { LocalKeyProvider } from "@wim/crypto";
import { createDb, loadSettings, withSystem, type Db } from "@wim/db";
import { loadOrgContexts } from "@wim/queue";
import { Client, createAdmin, inviteAndAccept, totpCode, userWithOrg, verifiedUser } from "../helpers/harness.js";
import { startWebsiteHarness, uniqueDomain, verifiedWebsite, type WebsiteHarness } from "../helpers/websites.js";
import { SettingsService } from "../../src/settings/settings.service.js";

/**
 * Phase 8 billing, end to end through the real API, Postgres (RLS, grants), Redis and the verification worker.
 * The payment gateways are LOCAL FAKES (node:http) speaking the Stripe / Razorpay REST shapes: no external account,
 * no network call to a payment provider, no card data. Webhook secrets and API keys are generated per run.
 */
let h: WebsiteHarness;
let worker: Db;
let sa: Client;
const STRIPE_WH = `whsec_${randomBytes(20).toString("hex")}`;
const STRIPE_SK = `sk_test_${randomBytes(16).toString("hex")}`;
const RZP_WH = randomBytes(20).toString("hex");
const RZP_SK = randomBytes(16).toString("hex");
const PRICE = { proMonthUsd: `price_pro${randomBytes(4).toString("hex")}`, bizMonthUsd: `price_biz${randomBytes(4).toString("hex")}`, proMonthInr: `plan_pro${randomBytes(4).toString("hex")}` };

// ---------------------------------------------------------------- fake gateways
interface FakeSub { id: string; status: string; cancel_at_period_end: boolean; customer: string; price: string; metadata: Record<string, string>; start: number; end: number }
const stripeSubs = new Map<string, FakeSub>();
const stripeCalls: Array<{ method: string; path: string; body: string; auth: string | undefined }> = [];
const rzpCalls: Array<{ method: string; path: string; body: string }> = [];
let stripeServer: Server, rzpServer: Server;

const readBody = (req: IncomingMessage) => new Promise<string>((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });
const stripeSubJson = (s: FakeSub) => ({
  id: s.id, object: "subscription", status: s.status, cancel_at_period_end: s.cancel_at_period_end, customer: s.customer, metadata: s.metadata,
  items: { data: [{ id: `si_${s.id}`, price: { id: s.price }, current_period_start: s.start, current_period_end: s.end }] },
});

async function startFakes() {
  stripeServer = createServer(async (req, res) => {
    const body = await readBody(req);
    stripeCalls.push({ method: req.method!, path: req.url!, body, auth: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization !== `Bearer ${STRIPE_SK}`) { res.statusCode = 401; res.end(JSON.stringify({ error: { type: "invalid_request_error" } })); return; }
    const m = /^\/v1\/subscriptions\/([^/]+)$/.exec(req.url!);
    if (req.method === "POST" && req.url === "/v1/checkout/sessions") { res.end(JSON.stringify({ id: "cs_test_1", url: "https://checkout.stripe.test/c/pay/cs_test_1" })); return; }
    if (m && stripeSubs.has(m[1]!)) {
      const s = stripeSubs.get(m[1]!)!;
      if (req.method === "POST") {
        const p = new URLSearchParams(body);
        if (p.has("cancel_at_period_end")) s.cancel_at_period_end = p.get("cancel_at_period_end") === "true";
        if (p.has("items[0][price]")) s.price = p.get("items[0][price]")!;
      }
      res.end(JSON.stringify(stripeSubJson(s)));
      return;
    }
    res.statusCode = 404; res.end(JSON.stringify({ error: { code: "resource_missing" } }));
  });
  rzpServer = createServer(async (req, res) => {
    const body = await readBody(req);
    rzpCalls.push({ method: req.method!, path: req.url!, body });
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/v1/subscriptions") { res.end(JSON.stringify({ id: "sub_RZP1", short_url: "https://rzp.test/i/abc", status: "created" })); return; }
    res.statusCode = 404; res.end(JSON.stringify({ error: { code: "BAD_REQUEST_ERROR" } }));
  });
  await new Promise<void>((r) => stripeServer.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => rzpServer.listen(0, "127.0.0.1", r));
  process.env.BILLING_STRIPE_API_URL = `http://127.0.0.1:${(stripeServer.address() as { port: number }).port}`;
  process.env.BILLING_RAZORPAY_API_URL = `http://127.0.0.1:${(rzpServer.address() as { port: number }).port}`;
}

// ---------------------------------------------------------------- helpers
async function setSetting(key: string, value: unknown) {
  await h.owner.query("UPDATE platform_settings SET value = $2::jsonb WHERE key = $1", [key, JSON.stringify(value)]);
  h.app.get(SettingsService).invalidate();
}
const nowSec = () => Math.floor(Date.now() / 1000);
function stripeEvent(type: string, object: Record<string, unknown>, created = nowSec(), id = `evt_${randomBytes(8).toString("hex")}`) {
  return { raw: JSON.stringify({ id, object: "event", type, created, livemode: false, data: { object } }), id };
}
async function postStripe(raw: string, sig?: string) {
  const r = await h.app.inject({ method: "POST", url: "/api/v1/billing/webhooks/stripe", payload: raw, headers: { "content-type": "application/json", ...(sig ? { "stripe-signature": sig } : {}) } });
  return { status: r.statusCode, body: JSON.parse(r.body || "{}") };
}
const signedStripe = (raw: string, t = nowSec(), secret = STRIPE_WH) => postStripe(raw, signStripePayload(raw, secret, t));
async function postRzp(raw: string, eventId: string, sig = signRazorpayPayload(raw, RZP_WH)) {
  const r = await h.app.inject({ method: "POST", url: "/api/v1/billing/webhooks/razorpay", payload: raw, headers: { "content-type": "application/json", "x-razorpay-signature": sig, "x-razorpay-event-id": eventId } });
  return { status: r.statusCode, body: JSON.parse(r.body || "{}") };
}
const subRow = async (orgId: string) => (await h.owner.query("SELECT * FROM subscriptions WHERE org_id = $1 ORDER BY created_at DESC LIMIT 1", [orgId])).rows[0];
const count = async (sql: string, params: unknown[]) => (await h.owner.query(sql, params)).rows[0].n as number;

async function planPrice(planKey: string, interval: string, currency: string) {
  return (await h.owner.query(
    "SELECT pp.id FROM plan_prices pp JOIN subscription_plans p ON p.id = pp.plan_id WHERE p.key = $1 AND pp.interval = $2 AND pp.currency = $3 AND pp.active ORDER BY version DESC LIMIT 1",
    [planKey, interval, currency])).rows[0].id as string;
}

/** A Stripe subscription that exists at the fake gateway and has been announced by webhook. */
async function subscribedViaStripe(orgId: string, price = PRICE.proMonthUsd) {
  const id = `sub_${randomBytes(6).toString("hex")}`;
  const s: FakeSub = { id, status: "active", cancel_at_period_end: false, customer: `cus_${randomBytes(6).toString("hex")}`, price, metadata: { org_id: orgId }, start: nowSec() - 60, end: nowSec() + 30 * 86400 };
  stripeSubs.set(id, s);
  const done = await signedStripe(stripeEvent("checkout.session.completed", { id: "cs_x", object: "checkout.session", client_reference_id: orgId, customer: s.customer, subscription: id, metadata: { org_id: orgId } }, nowSec() - 30).raw);
  expect(done.status).toBe(200);
  const created = await signedStripe(stripeEvent("customer.subscription.created", stripeSubJson(s), nowSec() - 20).raw);
  expect(created.body.result).toBe("PROCESSED");
  return s;
}

beforeAll(async () => {
  await startFakes();
  h = await startWebsiteHarness();
  worker = createDb({ url: process.env.WORKER_DATABASE_URL!, max: 2, omitSecrets: true });
  const admin = await createAdmin("SUPER_ADMIN");
  sa = Client.admin(h.app);
  const login = await sa.post("/api/admin/v1/auth/login", { email: admin.email, password: admin.password, code: await totpCode(admin.secret) });
  expect(login.status).toBe(200);
});
afterAll(async () => {
  await setSetting("billing.enabled", false);
  await worker.$disconnect();
  await h.stopAll();
  stripeServer.close(); rzpServer.close();
});

// =============================================================================================================
describe("billing disabled (the default): nothing can reach a gateway", () => {
  it("is off by default; overview is honest; checkout and webhooks are refused", async () => {
    const o = await userWithOrg(h.app, "billoff");
    const ov = await o.client.get(`/api/v1/orgs/${o.orgId}/billing`);
    expect(ov.status).toBe(200);
    expect(ov.body.data).toMatchObject({ billingEnabled: false, gatewaysAvailable: [], checkoutCurrencies: [], subscription: null });
    const plans = await o.client.get(`/api/v1/orgs/${o.orgId}/billing/plans`);
    expect(plans.body.data.map((p: { key: string }) => p.key)).toEqual(expect.arrayContaining(["free", "starter", "pro", "business"]));
    expect(plans.body.data.find((p: { key: string }) => p.key === "pro").description).toMatch(/^Example pricing/);
    const co = await o.client.post(`/api/v1/orgs/${o.orgId}/billing/checkout`, { planKey: "pro", interval: "MONTH", currency: "USD" });
    expect(co.status).toBe(409);
    const wh = await signedStripe(stripeEvent("customer.subscription.updated", {}).raw);
    expect(wh.status).toBe(503);
    expect(stripeCalls.length).toBe(0);
  });

  it("entitlement resolution is unchanged while billing is disabled (trial → platform defaults, no plan)", async () => {
    const s = await loadSettings(worker);
    expect(s["billing.enabled"]).toBe(false);
    const o = await userWithOrg(h.app, "billoff2");
    await h.owner.query("INSERT INTO trials (org_id, registrable_domain, status, starts_at, ends_at) VALUES ($1, 'x.example', 'ACTIVE', now(), now() + interval '10 days')", [o.orgId]);
    const ctx = (await withSystem(worker, (tx) => loadOrgContexts(tx, [o.orgId], s))).get(o.orgId)!;
    expect(ctx).toMatchObject({ entitled: true, entitlementReason: "TRIAL", planSource: "PLATFORM_DEFAULTS", planId: null });
    expect(ctx.limits.maxWebsites).toBe(s["monitoring.limits.maxWebsites"]);
  });
});

// =============================================================================================================
describe("admin: plans, prices, entitlements and write-only gateway secrets", () => {
  it("stores gateway secrets encrypted; no admin endpoint ever returns them; the change is audited without values", async () => {
    const put = await sa.put("/api/admin/v1/billing/gateways/stripe", { enabled: true, mode: "test", publicKey: "pk_test_x", currencies: ["USD"], secretKey: STRIPE_SK, webhookSecret: STRIPE_WH, reason: "Phase 8 test configuration" });
    expect(put.status).toBe(200);
    expect(put.body.data).toMatchObject({ gateway: "STRIPE", enabled: true, secretsConfigured: true, webhookPath: "/api/v1/billing/webhooks/stripe" });
    expect(put.body.data.secretHint).toBe(`sk_test_…${STRIPE_SK.slice(-4)}`);
    const rzp = await sa.put("/api/admin/v1/billing/gateways/razorpay", { enabled: true, mode: "test", publicKey: "rzp_test_key1", currencies: ["INR"], secretKey: RZP_SK, webhookSecret: RZP_WH, reason: "Phase 8 test configuration" });
    expect(rzp.status).toBe(200);
    // ciphertext at rest, not the secret
    const row = (await h.owner.query("SELECT secrets_enc FROM payment_gateway_configs WHERE gateway = 'STRIPE'")).rows[0];
    expect(Buffer.from(row.secrets_enc).toString("latin1")).not.toContain(STRIPE_SK);
    // every parameterless admin GET (plus the billing ones) is free of secret material
    const paths = ["/api/admin/v1/billing/gateways", "/api/admin/v1/billing/plans", "/api/admin/v1/billing/entitlement-keys", "/api/admin/v1/settings", "/api/admin/v1/overview", "/api/admin/v1/audit-logs", "/api/admin/v1/customers"];
    for (const p of paths) {
      const r = await sa.get(p);
      expect(r.status, p).toBe(200);
      const text = JSON.stringify(r.body);
      for (const secret of [STRIPE_SK, STRIPE_WH, RZP_SK, RZP_WH]) expect(text.includes(secret), p).toBe(false);
    }
    const audit = (await h.owner.query("SELECT reason, changes::text AS c FROM audit_logs WHERE action = 'admin.gateway_config_changed' ORDER BY id DESC LIMIT 2")).rows;
    expect(audit).toHaveLength(2);
    for (const a of audit) { expect(a.reason).toBe("Phase 8 test configuration"); for (const s of [STRIPE_SK, STRIPE_WH, RZP_SK, RZP_WH]) expect(a.c.includes(s)).toBe(false); }
  });

  it("gateway writes need admin:gateways:write and a reason; enabling without secrets is refused", async () => {
    const billingAdmin = await createAdmin("ADMIN_BILLING");
    const c = Client.admin(h.app);
    expect((await c.post("/api/admin/v1/auth/login", { email: billingAdmin.email, password: billingAdmin.password, code: await totpCode(billingAdmin.secret) })).status).toBe(200);
    expect((await c.get("/api/admin/v1/billing/gateways")).status).toBe(200);
    expect((await c.put("/api/admin/v1/billing/gateways/stripe", { enabled: false, mode: "test", reason: "should be refused" })).status).toBe(403);
    expect((await sa.put("/api/admin/v1/billing/gateways/stripe", { enabled: true, mode: "test" })).status).toBe(400);
    expect((await sa.put("/api/admin/v1/billing/gateways/stripe", { enabled: true, mode: "test", secretKey: "sk_test_only_one", reason: "half a secret pair" })).status).toBe(400);
  });

  it("links gateway prices to example price versions (audited); a linked id can't be re-pointed", async () => {
    const link = async (planKey: string, currency: string, body: Record<string, string>) =>
      sa.patch(`/api/admin/v1/billing/prices/${await planPrice(planKey, "MONTH", currency)}`, { ...body, reason: "link test-mode gateway price" });
    expect((await link("pro", "USD", { stripePriceId: PRICE.proMonthUsd })).status).toBe(200);
    expect((await link("business", "USD", { stripePriceId: PRICE.bizMonthUsd })).status).toBe(200);
    expect((await link("pro", "INR", { razorpayPlanId: PRICE.proMonthInr })).status).toBe(200);
    expect((await link("pro", "USD", { stripePriceId: `price_other${randomBytes(3).toString("hex")}` })).status).toBe(409);
    expect(await count("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'admin.plan_price_updated'", [])).toBeGreaterThanOrEqual(3);
  });

  it("validates entitlement keys and types", async () => {
    const pro = (await sa.get("/api/admin/v1/billing/plans")).body.data.find((p: { key: string }) => p.key === "pro");
    expect((await sa.put(`/api/admin/v1/billing/plans/${pro.id}/entitlements`, { entitlements: { "not.a.key": 1 }, reason: "invalid key test" })).status).toBe(400);
    expect((await sa.put(`/api/admin/v1/billing/plans/${pro.id}/entitlements`, { entitlements: { "monitoring.browser.entitled": 3 }, reason: "invalid type test" })).status).toBe(400);
  });
});

// =============================================================================================================
describe("checkout, RBAC and tenant isolation (billing enabled)", () => {
  beforeAll(async () => { await setSetting("billing.enabled", true); });

  it("an owner starts a gateway-hosted checkout bound to their org; a member can't; currencies follow the gateways", async () => {
    const o = await userWithOrg(h.app, "checkout");
    const ov = await o.client.get(`/api/v1/orgs/${o.orgId}/billing`);
    expect(ov.body.data.billingEnabled).toBe(true);
    expect(ov.body.data.gatewaysAvailable.sort()).toEqual(["RAZORPAY", "STRIPE"]);
    expect(ov.body.data.checkoutCurrencies).toEqual(expect.arrayContaining([{ currency: "USD", gateway: "STRIPE" }, { currency: "INR", gateway: "RAZORPAY" }]));
    const before = stripeCalls.length;
    const co = await o.client.post(`/api/v1/orgs/${o.orgId}/billing/checkout`, { planKey: "pro", interval: "MONTH", currency: "USD" });
    expect(co.status).toBe(200);
    expect(co.body.data.url).toBe("https://checkout.stripe.test/c/pay/cs_test_1");
    const call = stripeCalls[before]!;
    const p = new URLSearchParams(call.body);
    expect(p.get("client_reference_id")).toBe(o.orgId);
    expect(p.get("line_items[0][price]")).toBe(PRICE.proMonthUsd);
    expect(p.get("automatic_tax[enabled]")).toBe("true"); // billing.tax.mode = GATEWAY (B4b default)
    // a price without a gateway link is honest about it
    const starter = await o.client.post(`/api/v1/orgs/${o.orgId}/billing/checkout`, { planKey: "starter", interval: "MONTH", currency: "USD" });
    expect(starter.status).toBe(409);
    const eur = await o.client.post(`/api/v1/orgs/${o.orgId}/billing/checkout`, { planKey: "pro", interval: "MONTH", currency: "EUR" });
    expect(eur.status).toBe(409);
    // Razorpay checkout for INR
    const inr = await o.client.post(`/api/v1/orgs/${o.orgId}/billing/checkout`, { planKey: "pro", interval: "MONTH", currency: "INR" });
    expect(inr.status).toBe(200);
    expect(inr.body.data.url).toBe("https://rzp.test/i/abc");
    expect(JSON.parse(rzpCalls.at(-1)!.body)).toMatchObject({ plan_id: PRICE.proMonthInr, notes: { org_id: o.orgId } });

    const member = await verifiedUser(h.app, "billmember");
    await inviteAndAccept(o.client, o.orgId, member, "ADMIN");
    expect((await member.client.get(`/api/v1/orgs/${o.orgId}/billing`)).status).toBe(200);
    expect((await member.client.post(`/api/v1/orgs/${o.orgId}/billing/checkout`, { planKey: "pro", interval: "MONTH", currency: "USD" })).status).toBe(403);
    expect((await member.client.post(`/api/v1/orgs/${o.orgId}/billing/cancel`, {})).status).toBe(403);
  });

  it("billing endpoints are tenant-isolated (404 to non-members; invoices never cross orgs)", async () => {
    const a = await userWithOrg(h.app, "isoA");
    const b = await userWithOrg(h.app, "isoB");
    await subscribedViaStripe(a.orgId);
    const inv = stripeEvent("invoice.paid", {
      id: `in_${randomBytes(5).toString("hex")}`, number: "TEST-0001", status: "paid", currency: "usd", subtotal: 3900, total: 3900, amount_paid: 3900, created: nowSec(),
      customer: null, parent: { subscription_details: { subscription: [...stripeSubs.values()].find((s) => s.metadata.org_id === a.orgId)!.id, metadata: { org_id: a.orgId } } },
      payment_intent: `pi_${randomBytes(5).toString("hex")}`, status_transitions: { paid_at: nowSec() },
    });
    expect((await signedStripe(inv.raw)).body.result).toBe("PROCESSED");
    expect((await a.client.get(`/api/v1/orgs/${a.orgId}/billing/invoices`)).body.data).toHaveLength(1);
    expect((await b.client.get(`/api/v1/orgs/${b.orgId}/billing/invoices`)).body.data).toHaveLength(0);
    for (const path of ["billing", "billing/invoices", "billing/plans"]) expect((await b.client.get(`/api/v1/orgs/${a.orgId}/${path}`)).status).toBe(404);
    for (const path of ["billing/checkout", "billing/cancel", "billing/resume", "billing/change-plan"]) expect((await b.client.post(`/api/v1/orgs/${a.orgId}/${path}`, {})).status).toBe(404);
    // RLS, as the API's own role: in org B's context A's subscription, payments and invoices don't exist
    const app = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await app.connect();
    try {
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.current_org_id', $1, true)", [b.orgId]);
      for (const t of ["subscriptions", "payments", "invoices", "gateway_customers"]) {
        expect((await app.query(`SELECT count(*)::int AS n FROM ${t} WHERE org_id = $1`, [a.orgId])).rows[0].n, t).toBe(0);
      }
      await app.query("ROLLBACK");
    } finally { await app.end(); }
  });
});

// =============================================================================================================
describe("webhooks: spoofing, replay, idempotency, ordering", () => {
  beforeAll(async () => { await setSetting("billing.enabled", true); });

  it("rejects unsigned, wrong-secret, tampered, stale and malformed deliveries without touching data", async () => {
    const o = await userWithOrg(h.app, "spoof");
    const sub = { id: `sub_${randomBytes(6).toString("hex")}`, status: "active", cancel_at_period_end: false, customer: "cus_spoof", price: PRICE.proMonthUsd, metadata: { org_id: o.orgId }, start: nowSec(), end: nowSec() + 86400 * 30 };
    const ev = stripeEvent("customer.subscription.created", stripeSubJson(sub));
    const secEventsBefore = await count("SELECT count(*)::int AS n FROM security_events WHERE kind = 'WEBHOOK_SIG_INVALID'", []);
    expect((await postStripe(ev.raw)).status).toBe(400);                                               // no signature
    expect((await signedStripe(ev.raw, nowSec(), `whsec_${randomBytes(20).toString("hex")}`)).status).toBe(400); // wrong secret
    const sig = signStripePayload(ev.raw, STRIPE_WH, nowSec());
    expect((await postStripe(ev.raw.replace(o.orgId, randomUUID()), sig)).status).toBe(400);            // tampered body
    expect((await signedStripe(ev.raw, nowSec() - 3600)).status).toBe(400);                             // replayed outside the window
    expect((await signedStripe(ev.raw, nowSec() + 3600)).status).toBe(400);                             // from the future
    expect((await signedStripe("not json at all")).status).toBe(400);                                    // malformed (signed garbage)
    expect((await postRzp(JSON.stringify({ entity: "event", event: "subscription.activated", created_at: nowSec(), payload: {} }), "evt_rzp_spoof", "0".repeat(64))).status).toBe(400);
    expect(await count("SELECT count(*)::int AS n FROM subscriptions WHERE org_id = $1", [o.orgId])).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM payment_webhook_events WHERE event_id = $1", [ev.id])).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM security_events WHERE kind = 'WEBHOOK_SIG_INVALID'", [])).toBeGreaterThanOrEqual(secEventsBefore + 6);
    // the genuine delivery is then accepted
    expect((await signedStripe(ev.raw)).body.result).toBe("PROCESSED");
    expect((await subRow(o.orgId)).status).toBe("ACTIVE");
  });

  it("a replayed event id (even freshly re-signed) is processed once: no duplicate payment, invoice or transition", async () => {
    const o = await userWithOrg(h.app, "replay");
    const s = await subscribedViaStripe(o.orgId);
    const failed = stripeEvent("invoice.payment_failed", {
      id: `in_${randomBytes(5).toString("hex")}`, status: "open", currency: "usd", subtotal: 3900, total: 3900, amount_due: 3900, created: nowSec(),
      subscription: s.id, customer: s.customer, payment_intent: `pi_${randomBytes(5).toString("hex")}`,
    });
    expect((await signedStripe(failed.raw)).body.result).toBe("PROCESSED");
    const after1 = await subRow(o.orgId);
    expect(after1.status).toBe("PAST_DUE");
    const again = await signedStripe(failed.raw, nowSec() + 1);
    expect(again).toMatchObject({ status: 200, body: { result: "DUPLICATE" } });
    expect(await count("SELECT count(*)::int AS n FROM payments WHERE org_id = $1", [o.orgId])).toBe(1);
    expect(await count("SELECT count(*)::int AS n FROM invoices WHERE org_id = $1", [o.orgId])).toBe(1);
    expect((await h.owner.query("SELECT attempts, status FROM payment_webhook_events WHERE gateway = 'STRIPE' AND event_id = $1", [failed.id])).rows[0]).toMatchObject({ attempts: 1, status: "PROCESSED" });
    expect((await subRow(o.orgId)).grace_ends_at.getTime()).toBe(after1.grace_ends_at.getTime());
  });

  it("out-of-order delivery: an older failure arriving after a newer recovery does not flip the subscription", async () => {
    const o = await userWithOrg(h.app, "ooo");
    const s = await subscribedViaStripe(o.orgId);
    const t = nowSec();
    const inv = (type: string, created: number) => stripeEvent(type, {
      id: `in_${randomBytes(5).toString("hex")}`, status: type === "invoice.paid" ? "paid" : "open", currency: "usd", subtotal: 3900, total: 3900, amount_paid: 3900, amount_due: 3900,
      created, subscription: s.id, customer: s.customer, payment_intent: `pi_${randomBytes(5).toString("hex")}`,
    }, created);
    expect((await signedStripe(inv("invoice.payment_failed", t + 10).raw)).body.result).toBe("PROCESSED");
    expect((await subRow(o.orgId)).status).toBe("PAST_DUE");
    expect((await signedStripe(inv("invoice.paid", t + 30).raw)).body.result).toBe("PROCESSED");
    expect((await subRow(o.orgId)).status).toBe("ACTIVE");
    // the delayed failure from t+20 arrives last
    expect((await signedStripe(inv("invoice.payment_failed", t + 20).raw)).body.result).toBe("PROCESSED");
    const row = await subRow(o.orgId);
    expect(row.status).toBe("ACTIVE");
    expect(row.grace_ends_at).toBeNull();
    expect(row.gateway_updated_at.getTime()).toBe((t + 30) * 1000);
  });

  it("an event whose metadata names another org than the gateway object's owner is refused", async () => {
    const a = await userWithOrg(h.app, "mixA");
    const b = await userWithOrg(h.app, "mixB");
    const s = await subscribedViaStripe(a.orgId);
    const forged = stripeEvent("customer.subscription.updated", stripeSubJson({ ...s, status: "canceled", metadata: { org_id: b.orgId } }));
    expect((await signedStripe(forged.raw)).body.result).toBe("FAILED");
    expect((await subRow(a.orgId)).status).toBe("ACTIVE");
    expect(await count("SELECT count(*)::int AS n FROM subscriptions WHERE org_id = $1", [b.orgId])).toBe(0);
  });

  it("Razorpay: signed charge creates the subscription, payment and a numbered invoice; the event id is idempotent", async () => {
    await setSetting("billing.tax.mode", "GST");
    const o = await userWithOrg(h.app, "rzp");
    const subId = `sub_${randomBytes(6).toString("hex")}`;
    const body = (status: string) => JSON.stringify({
      entity: "event", event: "subscription.charged", created_at: nowSec(), contains: ["subscription", "payment"],
      payload: {
        subscription: { entity: { id: subId, plan_id: PRICE.proMonthInr, customer_id: `cust_${randomBytes(4).toString("hex")}`, status, current_start: nowSec(), current_end: nowSec() + 30 * 86400, notes: { org_id: o.orgId } } },
        payment: { entity: { id: `pay_${randomBytes(6).toString("hex")}`, amount: 249900, currency: "INR", status: "captured", created_at: nowSec() } },
      },
    });
    const raw = body("active");
    const evId = `evt_${randomBytes(8).toString("hex")}`;
    expect((await postRzp(raw, evId)).body.result).toBe("PROCESSED");
    const row = await subRow(o.orgId);
    expect(row).toMatchObject({ status: "ACTIVE", gateway: "RAZORPAY", gateway_subscription_id: subId });
    const inv = (await h.owner.query("SELECT number, total_minor, tax_minor, status FROM invoices WHERE org_id = $1", [o.orgId])).rows;
    expect(inv).toHaveLength(1);
    expect(inv[0].number).toMatch(/^INV-\d{4}-\d{6}$/);
    expect(inv[0]).toMatchObject({ total_minor: 249900, tax_minor: Math.round(249900 * 18 / 118), status: "PAID" });
    expect((await postRzp(raw, evId)).body.result).toBe("DUPLICATE");
    const tampered = raw.replace("249900", "1");
    expect((await postRzp(tampered, `evt_${randomBytes(8).toString("hex")}`, signRazorpayPayload(raw, RZP_WH))).status).toBe(400);
    // resume isn't something Razorpay can do: refused before any gateway call
    expect((await o.client.post(`/api/v1/orgs/${o.orgId}/billing/resume`, {})).status).toBe(409);
    await setSetting("billing.tax.mode", "GATEWAY");
  });
});

// =============================================================================================================
describe("subscription lifecycle through the API", () => {
  beforeAll(async () => { await setSetting("billing.enabled", true); });

  it("cancel at period end → CANCELING, resume → ACTIVE, upgrade → new plan limits immediately", async () => {
    const o = await userWithOrg(h.app, "life");
    await subscribedViaStripe(o.orgId);
    const ov = (await o.client.get(`/api/v1/orgs/${o.orgId}/billing`)).body.data;
    expect(ov.subscription).toMatchObject({ status: "ACTIVE", planKey: "pro", gateway: "STRIPE", interval: "MONTH", currency: "USD", amountMinor: 3900 });
    expect(ov.entitlement).toMatchObject({ entitled: true, source: "SUBSCRIPTION", planKey: "pro" });
    expect(ov.limits.maxWebsites).toBe(10);

    const cancel = await o.client.post(`/api/v1/orgs/${o.orgId}/billing/cancel`, {});
    expect(cancel.status).toBe(200);
    expect(cancel.body.data).toMatchObject({ status: "CANCELING", cancelAtPeriodEnd: true });
    expect((await o.client.post(`/api/v1/orgs/${o.orgId}/billing/cancel`, {})).status).toBe(409);
    const resume = await o.client.post(`/api/v1/orgs/${o.orgId}/billing/resume`, {});
    expect(resume.body.data).toMatchObject({ status: "ACTIVE", cancelAtPeriodEnd: false });

    const up = await o.client.post(`/api/v1/orgs/${o.orgId}/billing/change-plan`, { planKey: "business", interval: "MONTH" });
    expect(up.status).toBe(200);
    expect(up.body.data).toMatchObject({ planKey: "business", status: "ACTIVE" });
    expect((await o.client.get(`/api/v1/orgs/${o.orgId}/billing`)).body.data.limits.maxWebsites).toBe(50);
    expect(await count("SELECT count(*)::int AS n FROM audit_logs WHERE stream = $1 AND action LIKE 'billing.%'", [`org:${o.orgId}`])).toBe(3);
    // a second checkout while subscribed is refused (one current subscription per org)
    expect((await o.client.post(`/api/v1/orgs/${o.orgId}/billing/checkout`, { planKey: "pro", interval: "MONTH", currency: "USD" })).status).toBe(409);
  });

  it("an admin entitlement change applies on the next resolution (no cache, no redeploy)", async () => {
    const o = await userWithOrg(h.app, "entl");
    await subscribedViaStripe(o.orgId, PRICE.bizMonthUsd);
    const biz = (await sa.get("/api/admin/v1/billing/plans")).body.data.find((p: { key: string }) => p.key === "business");
    const original = biz.entitlements;
    const s = await loadSettings(worker);
    const t0 = Date.now();
    expect((await sa.put(`/api/admin/v1/billing/plans/${biz.id}/entitlements`, { entitlements: { ...original, "monitoring.maxWebsites": 77 }, reason: "raise limit for test" })).status).toBe(200);
    const ctx = (await withSystem(worker, (tx) => loadOrgContexts(tx, [o.orgId], s))).get(o.orgId)!;
    expect(ctx.limits.maxWebsites).toBe(77);
    expect(Date.now() - t0).toBeLessThan(60_000);
    expect((await o.client.get(`/api/v1/orgs/${o.orgId}/billing`)).body.data.limits.maxWebsites).toBe(77);
    expect((await sa.put(`/api/admin/v1/billing/plans/${biz.id}/entitlements`, { entitlements: original, reason: "restore after test" })).status).toBe(200);
  });

  it("daily reconciliation: grace expiry, period-end cancellation, gateway drift correction; once a day, advisory-locked", async () => {
    const pd = await userWithOrg(h.app, "reconPD");
    const cn = await userWithOrg(h.app, "reconCN");
    const dr = await userWithOrg(h.app, "reconDR");
    await subscribedViaStripe(pd.orgId);
    await subscribedViaStripe(cn.orgId);
    const drift = await subscribedViaStripe(dr.orgId);
    await h.owner.query("UPDATE subscriptions SET status = 'PAST_DUE', grace_ends_at = now() - interval '1 minute' WHERE org_id = $1", [pd.orgId]);
    await h.owner.query("UPDATE subscriptions SET status = 'CANCELING', cancel_at_period_end = true, current_period_end = now() - interval '1 minute' WHERE org_id = $1", [cn.orgId]);
    drift.status = "past_due"; // the gateway knows something our webhooks missed
    const s = await loadSettings(worker);
    const open = platformSecretOpener(worker, LocalKeyProvider.fromEnv());
    const endpoints = { stripeBaseUrl: process.env.BILLING_STRIPE_API_URL, razorpayBaseUrl: process.env.BILLING_RAZORPAY_API_URL };
    // two schedulers race for the daily run: exactly one runs (advisory lock + daily run marker)
    await h.owner.query("DELETE FROM system_health_logs WHERE component = 'billing' AND metric = 'reconcile_run'");
    const [r1, r2] = await Promise.all([
      runBillingReconciliation(worker, { billingEnabled: true, graceDays: s["billing.graceDays"], open, endpoints }),
      runBillingReconciliation(worker, { billingEnabled: true, graceDays: s["billing.graceDays"], open, endpoints }),
    ]);
    expect([r1.ran, r2.ran].filter(Boolean)).toHaveLength(1);
    const r = r1.ran ? r1 : r2;
    expect(r.expired).toBeGreaterThanOrEqual(1);
    expect(r.canceled).toBeGreaterThanOrEqual(1);
    expect(r.corrected).toBeGreaterThanOrEqual(1);
    expect((await subRow(pd.orgId)).status).toBe("EXPIRED");
    expect((await subRow(cn.orgId)).status).toBe("CANCELED");
    expect((await subRow(dr.orgId)).status).toBe("PAST_DUE");
    // not forced: already ran today
    expect((await runBillingReconciliation(worker, { billingEnabled: true, graceDays: 7, open, endpoints })).ran).toBe(false);
    // expired org is no longer entitled; a new checkout is possible again
    expect((await pd.client.get(`/api/v1/orgs/${pd.orgId}/billing`)).body.data.subscription).toBeNull();
  });
});

// =============================================================================================================
describe("trials (rule #2: the domain ledger survives account deletion)", () => {
  beforeAll(async () => { await setSetting("billing.enabled", true); });

  it("trial uses the trial plan's entitlements; delete account → new account → same domain → no trial, not entitled", async () => {
    const a = await userWithOrg(h.app, "trialA");
    const d = uniqueDomain("trial");
    const w = await verifiedWebsite(h, a.client, a.orgId, d);
    expect(w.verification.trialOutcome).toBe("ACTIVATED");
    const ov = (await a.client.get(`/api/v1/orgs/${a.orgId}/billing`)).body.data;
    expect(ov.trial).toMatchObject({ status: "ACTIVE", planKey: "pro" });
    expect(ov.trial.daysLeft).toBeGreaterThan(0);
    expect(ov.entitlement).toMatchObject({ entitled: true, source: "TRIAL", planKey: "pro" });
    expect(ov.limits.maxWebsites).toBe(10);
    expect(ov.usage.websites).toBe(1);

    // the account (organisation) is deleted for good, then the same person signs up again
    expect((await a.client.post(`/api/v1/orgs/${a.orgId}/websites/${w.id}/delete`, { confirmHost: d })).status).toBe(204);
    await h.owner.query("DELETE FROM organizations WHERE id = $1", [a.orgId]);
    const b = await userWithOrg(h.app, "trialB");
    const again = await verifiedWebsite(h, b.client, b.orgId, d);
    expect(again.verification.trialOutcome).toBe("DOMAIN_PREVIOUSLY_TRIALED");
    const ovB = (await b.client.get(`/api/v1/orgs/${b.orgId}/billing`)).body.data;
    expect(ovB.trial).toBeNull();
    expect(ovB.entitlement).toMatchObject({ entitled: false, source: "PLATFORM_DEFAULTS" });
    // with a free plan configured, the same org falls back to it (still no trial)
    await setSetting("billing.freePlanKey", "free");
    const ovF = (await b.client.get(`/api/v1/orgs/${b.orgId}/billing`)).body.data;
    expect(ovF.entitlement).toMatchObject({ entitled: true, source: "FREE", planKey: "free" });
    expect(ovF.limits.maxWebsites).toBe(1);
    await setSetting("billing.freePlanKey", null);
  });
});
