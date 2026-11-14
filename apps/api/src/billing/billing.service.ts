import { Inject, Injectable } from "@nestjs/common";
import {
  applyBillingFact, classifyPlanChange, type BillingFact, type SettingsSnapshot, type SubStatus, type SubscriptionState,
} from "@wim/core";
import {
  createGateway, GatewayError, loadGatewayConfig, type GatewayEndpoints, type GatewayKind, type GatewaySubscriptionSnapshot, type LoadedGateway,
  type PaymentGateway,
} from "@wim/billing";
import { withTenant, type Db, type Tx } from "@wim/db";
import { loadOrgContexts, loadWebsiteFacts } from "@wim/queue";
import type {
  BillingGateway, BillingOverviewDto, BillingSubscriptionDto, InvoiceDto, PlanDto,
} from "@wim/contracts";
import { APP_DB } from "../infra/infra.module.js";
import { ENV, type Env } from "../config/env.js";
import { KeysService } from "../crypto/keys.service.js";
import { SettingsService } from "../settings/settings.service.js";
import { AuditService, orgStream } from "../audit/audit.service.js";
import { RateLimitService } from "../common/rate-limit.service.js";
import { AppError, Errors } from "../common/errors.js";
import type { ClientInfo, OrgContext, SessionContext } from "../common/context.js";

export const GATEWAY_KINDS: GatewayKind[] = ["STRIPE", "RAZORPAY"];

/** Plans with their prices and entitlements (shared by the customer and admin APIs). */
export async function loadPlans(db: Db | Tx, opts: { onlyPublic: boolean }): Promise<PlanDto[]> {
  const plans = await db.subscriptionPlan.findMany({
    where: opts.onlyPublic ? { visible: true, active: true, archivedAt: null } : {},
    orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
    include: { prices: { where: opts.onlyPublic ? { active: true } : {}, orderBy: [{ currency: "asc" }, { interval: "asc" }, { version: "desc" }] }, entitlements: true },
  });
  return plans.map((p) => ({
    id: p.id, key: p.key, name: p.name, description: p.description, visible: p.visible, active: p.active, trialEligible: p.trialEligible, sortOrder: p.sortOrder,
    prices: p.prices.map((x) => ({
      id: x.id, interval: x.interval, currency: x.currency, amountMinor: x.amountMinor, version: x.version, active: x.active,
      stripeLinked: Boolean(x.stripePriceId), razorpayLinked: Boolean(x.razorpayPlanId),
    })),
    entitlements: Object.fromEntries(p.entitlements.map((e) => [e.key, e.value])),
  }));
}

const providerFailed = () => new AppError(502, "FEATURE_UNAVAILABLE", "The payment provider could not complete the request. Nothing was changed; try again later");

/**
 * Phase 8 customer billing. Every gateway call is refused unless billing.enabled is on AND the gateway is enabled
 * with secrets configured. Gateway secrets are decrypted per request (platform DEK, cached briefly by KeysService)
 * and never leave this process.
 */
@Injectable()
export class BillingService {
  constructor(
    @Inject(APP_DB) readonly db: Db,
    @Inject(ENV) private readonly env: Env,
    private readonly keys: KeysService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /** Test-only gateway endpoints (a local fake). Never honoured in production. */
  endpoints(): GatewayEndpoints {
    if (this.env.NODE_ENV === "production") return {};
    return { stripeBaseUrl: process.env.BILLING_STRIPE_API_URL || undefined, razorpayBaseUrl: process.env.BILLING_RAZORPAY_API_URL || undefined };
  }

  async gatewayConfig(kind: GatewayKind): Promise<LoadedGateway | null> {
    return loadGatewayConfig(this.db, kind, (blob, aad) => this.keys.openPlatform(this.db, "platform-config", blob, aad));
  }

  /** A usable gateway or null (billing disabled, gateway disabled or not configured). */
  async usableGateway(kind: GatewayKind, s?: SettingsSnapshot): Promise<PaymentGateway | null> {
    const settings = s ?? (await this.settings.get());
    if (!settings["billing.enabled"]) return null;
    const cfg = await this.gatewayConfig(kind);
    if (!cfg?.enabled || !cfg.credentials) return null;
    return createGateway(kind, cfg.credentials, this.endpoints());
  }

  async availableGateways(s: SettingsSnapshot): Promise<Array<{ kind: GatewayKind; currencies: string[] }>> {
    if (!s["billing.enabled"]) return [];
    const out: Array<{ kind: GatewayKind; currencies: string[] }> = [];
    for (const kind of GATEWAY_KINDS) {
      const cfg = await this.gatewayConfig(kind).catch(() => null);
      if (cfg?.enabled && cfg.credentials) out.push({ kind, currencies: cfg.currencies });
    }
    return out;
  }

  /** Writes hold the subscription row lock across one gateway call (15 s client timeout), hence the longer budget. */
  private tenant<T>(o: OrgContext, fn: (tx: Tx) => Promise<T>) {
    return withTenant(this.db, o.orgId, fn, { timeout: 40_000 });
  }

  // ---------------------------------------------------------------- read
  async overview(o: OrgContext): Promise<BillingOverviewDto> {
    const s = await this.settings.get();
    const gateways = await this.availableGateways(s);
    const checkoutCurrencies = Object.entries(s["billing.gatewayByCurrency"])
      .filter(([cur, g]) => gateways.some((x) => x.kind === g && (!x.currencies.length || x.currencies.includes(cur))))
      .map(([currency, gateway]) => ({ currency, gateway: gateway as BillingGateway }));
    return this.tenant(o, async (tx) => {
      const ctx = (await loadOrgContexts(tx, [o.orgId], s)).get(o.orgId)!;
      const facts = await loadWebsiteFacts(tx);
      const mine = facts.filter((f) => f.orgId === o.orgId);
      const sub = await this.currentSubscription(tx, o.orgId);
      const trial = await tx.trial.findUnique({ where: { orgId: o.orgId } });
      const plan = ctx.planId ? await tx.subscriptionPlan.findUnique({ where: { id: ctx.planId }, select: { key: true } }) : null;
      const trialPlanKey = trial?.planId ? (await tx.subscriptionPlan.findUnique({ where: { id: trial.planId }, select: { key: true } }))?.key ?? null : s["billing.enabled"] ? s["trial.planKey"] : null;
      const now = Date.now();
      return {
        billingEnabled: s["billing.enabled"],
        gatewaysAvailable: gateways.map((g) => g.kind),
        checkoutCurrencies,
        intervals: s["billing.intervals"],
        taxMode: s["billing.tax.mode"],
        subscription: sub,
        trial: trial ? {
          status: trial.status, startsAt: trial.startsAt.toISOString(), endsAt: trial.endsAt.toISOString(),
          daysLeft: Math.max(0, Math.ceil((trial.endsAt.getTime() - now) / 86_400_000)), planKey: trialPlanKey,
        } : null,
        entitlement: { entitled: ctx.entitled, reason: ctx.entitlementReason, source: ctx.planSource, planKey: plan?.key ?? null },
        limits: {
          maxWebsites: ctx.limits.maxWebsites,
          http: { enabled: ctx.limits.tiers.HTTP.enabled, minIntervalSec: ctx.limits.tiers.HTTP.intervalSec },
          browser: { enabled: ctx.limits.tiers.BROWSER.enabled, entitled: ctx.limits.browser.entitled, maxWebsites: Math.min(ctx.limits.maxWebsites, ctx.limits.browser.maxWebsites) },
          deepscan: { enabled: ctx.limits.tiers.DEEPSCAN.enabled, entitled: ctx.limits.deepscan.entitled, maxWebsites: Math.min(ctx.limits.maxWebsites, ctx.limits.deepscan.maxWebsites) },
        },
        usage: { websites: mine.filter((f) => f.rank > 0).length, browserWebsites: mine.filter((f) => f.browserRank > 0).length, deepscanWebsites: mine.filter((f) => f.deepRank > 0).length },
      };
    });
  }

  private async currentSubscription(tx: Tx, orgId: string): Promise<BillingSubscriptionDto | null> {
    const sub = await tx.subscription.findFirst({ where: { orgId, status: { notIn: ["CANCELED", "EXPIRED"] } }, include: { planPrice: true } });
    if (!sub) return null;
    const plan = await tx.subscriptionPlan.findUnique({ where: { id: sub.planId }, select: { key: true, name: true } });
    const pending = sub.pendingPlanPriceId ? await tx.planPrice.findUnique({ where: { id: sub.pendingPlanPriceId }, select: { planId: true } }) : null;
    const pendingPlan = pending ? await tx.subscriptionPlan.findUnique({ where: { id: pending.planId }, select: { key: true } }) : null;
    return {
      id: sub.id, status: sub.status, planKey: plan?.key ?? "unknown", planName: plan?.name ?? "Unknown plan",
      interval: sub.planPrice?.interval ?? null, currency: sub.planPrice?.currency ?? null, amountMinor: sub.planPrice?.amountMinor ?? null,
      gateway: sub.gateway, currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null, cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      graceEndsAt: sub.graceEndsAt?.toISOString() ?? null, pendingPlanKey: pendingPlan?.key ?? null,
    };
  }

  async plans(): Promise<PlanDto[]> {
    return loadPlans(this.db, { onlyPublic: true });
  }

  async invoices(o: OrgContext): Promise<InvoiceDto[]> {
    return this.tenant(o, async (tx) => {
      const rows = await tx.invoice.findMany({ where: { orgId: o.orgId }, orderBy: { issuedAt: "desc" }, take: 100 });
      return rows.map((r) => ({
        id: r.id, number: r.number, status: r.status, currency: r.currency, subtotalMinor: r.subtotalMinor, taxMinor: r.taxMinor, totalMinor: r.totalMinor,
        periodStart: r.periodStart?.toISOString() ?? null, periodEnd: r.periodEnd?.toISOString() ?? null, issuedAt: r.issuedAt.toISOString(),
        paidAt: r.paidAt?.toISOString() ?? null, gateway: r.gateway,
      }));
    });
  }

  // ---------------------------------------------------------------- write (gateway calls)
  private async requireEnabled(): Promise<SettingsSnapshot> {
    const s = await this.settings.get();
    if (!s["billing.enabled"]) throw Errors.conflict("Billing is not enabled on this platform yet");
    return s;
  }

  async checkout(sess: SessionContext, o: OrgContext, input: { planKey: string; interval: "MONTH" | "YEAR"; currency: string }, client: ClientInfo): Promise<{ url: string }> {
    const s = await this.requireEnabled();
    await this.rateLimit.hit("billing-checkout", o.orgId, 10, 3600);
    if (!s["billing.intervals"].includes(input.interval)) throw Errors.conflict("This billing interval is not offered");
    const kind = s["billing.gatewayByCurrency"][input.currency] as GatewayKind | undefined;
    if (!kind) throw Errors.conflict(`Payments in ${input.currency} are not available`);
    const cfg = await this.gatewayConfig(kind);
    if (!cfg?.enabled || !cfg.credentials || (cfg.currencies.length && !cfg.currencies.includes(input.currency))) throw Errors.conflict(`Payments in ${input.currency} are not available yet`);
    const gw = createGateway(kind, cfg.credentials, this.endpoints());

    const { price, customerId } = await this.tenant(o, async (tx) => {
      const current = await tx.subscription.findFirst({ where: { orgId: o.orgId, status: { notIn: ["CANCELED", "EXPIRED"] } }, select: { id: true } });
      if (current) throw Errors.conflict("This organization already has a subscription. Change the plan instead");
      const price = await this.priceFor(tx, input.planKey, input.interval, input.currency, kind);
      const customer = await tx.gatewayCustomer.findUnique({ where: { orgId_gateway: { orgId: o.orgId, gateway: kind } } });
      return { price, customerId: customer?.gatewayCustomerId ?? null };
    });
    const base = `${this.env.APP_URL}/o/${o.orgId}/settings/billing`;
    let session;
    try {
      session = await gw.createCheckout({
        orgId: o.orgId, priceRef: price.ref, interval: input.interval, customerId, successUrl: `${base}?checkout=success`, cancelUrl: `${base}?checkout=cancelled`,
        idempotencyKey: `checkout-${o.orgId}-${price.id}-${Math.floor(Date.now() / 600_000)}`, automaticTax: s["billing.tax.mode"] === "GATEWAY",
      });
    } catch (e) {
      if (e instanceof GatewayError) throw providerFailed();
      throw e;
    }
    await this.audit.record({
      stream: orgStream(o.orgId), orgId: o.orgId, actorType: "USER", actorId: sess.userId, actorLabel: sess.email, action: "billing.checkout_started",
      targetType: "plan_price", targetId: price.id, changes: { planKey: input.planKey, interval: input.interval, currency: input.currency, gateway: kind }, client,
    });
    return { url: session.url };
  }

  private async priceFor(tx: Tx, planKey: string, interval: "MONTH" | "YEAR", currency: string, kind: GatewayKind) {
    const plan = await tx.subscriptionPlan.findFirst({ where: { key: planKey, active: true, visible: true, archivedAt: null }, select: { id: true } });
    if (!plan) throw Errors.notFound();
    const price = await tx.planPrice.findFirst({ where: { planId: plan.id, interval, currency, active: true }, orderBy: { version: "desc" } });
    if (!price) throw Errors.conflict("This plan has no price for that interval and currency");
    const ref = kind === "STRIPE" ? price.stripePriceId : price.razorpayPlanId;
    if (!ref) throw Errors.conflict("This plan is not available for online payment yet");
    return { id: price.id, planId: plan.id, ref, amountMinor: price.amountMinor };
  }

  /** The current gateway subscription row, locked for the duration of the caller's transaction. */
  private async lockedSubscription(tx: Tx, orgId: string) {
    const sub = await tx.subscription.findFirst({ where: { orgId, status: { notIn: ["CANCELED", "EXPIRED"] } }, include: { planPrice: true } });
    if (!sub || !sub.gateway || !sub.gatewaySubscriptionId) throw Errors.conflict("This organization has no paid subscription");
    await tx.$queryRaw`SELECT id FROM subscriptions WHERE id = ${sub.id}::uuid FOR UPDATE`;
    return sub;
  }

  /**
   * Apply the gateway's answer to our row optimistically, WITHOUT advancing gatewayUpdatedAt: the gateway's own
   * webhook for the same change (and any later one) must still apply.
   */
  private async applyLocal(tx: Tx, sub: { id: string } & Parameters<typeof toState>[0], snap: GatewaySubscriptionSnapshot, extra: Partial<SubscriptionState>) {
    const prev = toState(sub);
    const at = prev.gatewayUpdatedAt ?? new Date(0);
    const fact: BillingFact = { kind: "SNAPSHOT", at, status: snap.status ?? prev.status, cancelAtPeriodEnd: snap.cancelAtPeriodEnd, currentPeriodEnd: snap.currentPeriodEnd ?? prev.currentPeriodEnd };
    const r = applyBillingFact(prev, fact, { graceDays: (await this.settings.get())["billing.graceDays"] });
    const next = { ...(r.applied ? r.state : prev), ...extra, gatewayUpdatedAt: prev.gatewayUpdatedAt };
    await tx.subscription.update({ where: { id: sub.id }, data: {
      status: next.status, planId: next.planId, planPriceId: next.planPriceId, cancelAtPeriodEnd: next.cancelAtPeriodEnd, currentPeriodEnd: next.currentPeriodEnd,
      graceEndsAt: next.graceEndsAt, pendingPlanPriceId: next.pendingPlanPriceId, canceledAt: next.canceledAt,
    } });
  }

  async setCancel(sess: SessionContext, o: OrgContext, cancel: boolean, client: ClientInfo): Promise<BillingSubscriptionDto> {
    const s = await this.requireEnabled();
    await this.rateLimit.hit("billing-change", o.orgId, 20, 3600);
    const result = await this.tenant(o, async (tx) => {
      const sub = await this.lockedSubscription(tx, o.orgId);
      const gw = await this.usableGateway(sub.gateway as GatewayKind, s);
      if (!gw) throw Errors.conflict("The payment provider for this subscription is not available");
      if (!cancel && !gw.supports.resume) throw Errors.conflict("This payment provider cannot undo a cancellation. Subscribe again after the current period ends");
      if (cancel && sub.cancelAtPeriodEnd) throw Errors.conflict("The subscription is already set to end");
      if (!cancel && !sub.cancelAtPeriodEnd) throw Errors.conflict("The subscription is not set to end");
      let snap: GatewaySubscriptionSnapshot;
      try { snap = await gw.setCancelAtPeriodEnd(sub.gatewaySubscriptionId!, cancel); } catch (e) { if (e instanceof GatewayError) throw providerFailed(); throw e; }
      await this.applyLocal(tx, sub, { ...snap, cancelAtPeriodEnd: cancel }, {});
      await this.audit.record({
        stream: orgStream(o.orgId), orgId: o.orgId, actorType: "USER", actorId: sess.userId, actorLabel: sess.email,
        action: cancel ? "billing.subscription_cancel_requested" : "billing.subscription_resumed", targetType: "subscription", targetId: sub.id, client,
      }, tx);
      return this.currentSubscription(tx, o.orgId);
    });
    return result!;
  }

  async changePlan(sess: SessionContext, o: OrgContext, input: { planKey: string; interval: "MONTH" | "YEAR" }, client: ClientInfo): Promise<BillingSubscriptionDto> {
    const s = await this.requireEnabled();
    await this.rateLimit.hit("billing-change", o.orgId, 20, 3600);
    const result = await this.tenant(o, async (tx) => {
      const sub = await this.lockedSubscription(tx, o.orgId);
      if (sub.status === "PAST_DUE") throw Errors.conflict("Settle the outstanding payment before changing plans");
      if (!sub.planPrice) throw Errors.conflict("The current subscription has no price");
      const kind = sub.gateway as GatewayKind;
      const gw = await this.usableGateway(kind, s);
      if (!gw) throw Errors.conflict("The payment provider for this subscription is not available");
      const price = await this.priceFor(tx, input.planKey, input.interval, sub.planPrice.currency, kind);
      const change = classifyPlanChange(sub.planPrice, { amountMinor: price.amountMinor, interval: input.interval, currency: sub.planPrice.currency });
      if (price.id === sub.planPriceId || change === "SAME") throw Errors.conflict("That is already the current plan");
      const when = change === "DOWNGRADE" && gw.supports.scheduledDowngrade ? "period_end" : "now";
      let snap: GatewaySubscriptionSnapshot;
      try { snap = await gw.changePrice(sub.gatewaySubscriptionId!, price.ref, when); } catch (e) { if (e instanceof GatewayError) throw providerFailed(); throw e; }
      await this.applyLocal(tx, sub, snap, when === "now" ? { planId: price.planId, planPriceId: price.id, pendingPlanPriceId: null } : { pendingPlanPriceId: price.id });
      await this.audit.record({
        stream: orgStream(o.orgId), orgId: o.orgId, actorType: "USER", actorId: sess.userId, actorLabel: sess.email, action: "billing.plan_changed",
        targetType: "subscription", targetId: sub.id, changes: { to: input.planKey, interval: input.interval, change, effective: when }, client,
      }, tx);
      return this.currentSubscription(tx, o.orgId);
    });
    return result!;
  }
}

function toState(r: {
  status: string; planId: string; planPriceId: string | null; currentPeriodStart: Date | null; currentPeriodEnd: Date | null; cancelAtPeriodEnd: boolean;
  canceledAt: Date | null; graceEndsAt: Date | null; pendingPlanPriceId: string | null; gatewayUpdatedAt: Date | null;
}): SubscriptionState {
  return {
    status: r.status as SubStatus, planId: r.planId, planPriceId: r.planPriceId, currentPeriodStart: r.currentPeriodStart, currentPeriodEnd: r.currentPeriodEnd,
    cancelAtPeriodEnd: r.cancelAtPeriodEnd, canceledAt: r.canceledAt, graceEndsAt: r.graceEndsAt, pendingPlanPriceId: r.pendingPlanPriceId, gatewayUpdatedAt: r.gatewayUpdatedAt,
  };
}
