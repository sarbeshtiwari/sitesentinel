import { Body, Controller, Get, HttpCode, Param, Post, Req, Res, type RawBodyRequest } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createGateway, handleWebhook, type GatewayKind } from "@wim/billing";
import {
  ChangePlanInput, CheckoutInput, type BillingOverviewDto, type BillingSubscriptionDto, type DataEnvelope, type InvoiceDto, type PlanDto,
} from "@wim/contracts";
import { createLogger } from "@wim/logger";
import { Client, clientInfo, CurrentOrg, CurrentSession, Infra, parse, RequirePermission, type ClientInfo, type OrgContext, type SessionContext } from "../common/context.js";
import { RateLimitService } from "../common/rate-limit.service.js";
import { Errors } from "../common/errors.js";
import { SettingsService } from "../settings/settings.service.js";
import { BillingService } from "./billing.service.js";

/** Customer billing (Phase 8). Reads need billing:read; anything that can cost money needs billing:manage (owners). */
@Controller("api/v1/orgs/:orgId/billing")
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get()
  @RequirePermission("billing:read")
  async overview(@CurrentOrg() o: OrgContext): Promise<DataEnvelope<BillingOverviewDto>> {
    return { data: await this.billing.overview(o) };
  }

  @Get("plans")
  @RequirePermission("billing:read")
  async plans(): Promise<DataEnvelope<PlanDto[]>> {
    return { data: await this.billing.plans() };
  }

  @Get("invoices")
  @RequirePermission("billing:read")
  async invoices(@CurrentOrg() o: OrgContext): Promise<DataEnvelope<InvoiceDto[]>> {
    return { data: await this.billing.invoices(o) };
  }

  @Post("checkout")
  @RequirePermission("billing:manage")
  @HttpCode(200)
  async checkout(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Body() body: unknown, @Client() c: ClientInfo): Promise<DataEnvelope<{ url: string }>> {
    return { data: await this.billing.checkout(s, o, parse(CheckoutInput, body), c) };
  }

  @Post("change-plan")
  @RequirePermission("billing:manage")
  @HttpCode(200)
  async changePlan(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Body() body: unknown, @Client() c: ClientInfo): Promise<DataEnvelope<BillingSubscriptionDto>> {
    return { data: await this.billing.changePlan(s, o, parse(ChangePlanInput, body), c) };
  }

  @Post("cancel")
  @RequirePermission("billing:manage")
  @HttpCode(200)
  async cancel(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Client() c: ClientInfo): Promise<DataEnvelope<BillingSubscriptionDto>> {
    return { data: await this.billing.setCancel(s, o, true, c) };
  }

  @Post("resume")
  @RequirePermission("billing:manage")
  @HttpCode(200)
  async resume(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Client() c: ClientInfo): Promise<DataEnvelope<BillingSubscriptionDto>> {
    return { data: await this.billing.setCancel(s, o, false, c) };
  }
}

export const WEBHOOK_PATH_PREFIX = "/api/v1/billing/webhooks/";
const log = createLogger("billing-webhook");

/**
 * Payment-gateway webhooks: public (no session, no CSRF — authenticity is the gateway's signature over the RAW body),
 * strictly rate limited per source address. Responds 400 to anything unsigned, tampered, stale or malformed; 200 to
 * processed, ignored and duplicate events (re-deliveries are no-ops); 503 while billing or the gateway is off (the
 * gateway retries later); 500 when processing must be retried.
 */
@Controller("api/v1/billing/webhooks")
export class BillingWebhookController {
  constructor(private readonly billing: BillingService, private readonly settings: SettingsService, private readonly rateLimit: RateLimitService) {}

  @Infra()
  @Post(":gateway")
  @HttpCode(200)
  async receive(@Param("gateway") gatewayParam: string, @Req() req: RawBodyRequest<FastifyRequest>, @Res({ passthrough: true }) reply: FastifyReply) {
    const kind: GatewayKind | null = gatewayParam === "stripe" ? "STRIPE" : gatewayParam === "razorpay" ? "RAZORPAY" : null;
    if (!kind) throw Errors.notFound();
    const client = clientInfo(req);
    await this.rateLimit.hit("billing-webhook", `${kind}:${client.ipPrefix ?? "unknown"}`, 300, 60);
    const s = await this.settings.get();
    const cfg = s["billing.enabled"] ? await this.billing.gatewayConfig(kind) : null;
    if (!cfg?.enabled || !cfg.credentials) {
      reply.status(503);
      return { received: false, reason: "billing is not accepting events" };
    }
    const raw = req.rawBody;
    if (!raw || !raw.length) {
      reply.status(400);
      return { received: false };
    }
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v])) as Record<string, string | undefined>;
    const out = await handleWebhook({
      db: this.billing.db, gateway: createGateway(kind, cfg.credentials, this.billing.endpoints()), credentials: cfg.credentials, rawBody: raw, headers,
      now: new Date(), toleranceSec: s["billing.webhookToleranceSec"],
      policy: { graceDays: s["billing.graceDays"], taxMode: s["billing.tax.mode"], gstRatePct: s["billing.tax.gstRatePct"] },
    });
    if (out.result === "REJECTED") {
      await this.billing.db.securityEvent.createMany({ data: { kind: "WEBHOOK_SIG_INVALID", severity: "MEDIUM", ipPrefix: client.ipPrefix, details: { gateway: kind, reason: out.reason } } }).catch(() => undefined);
      log.warn({ gateway: kind, reason: out.reason, requestId: client.requestId }, "webhook rejected");
    } else {
      log.info({ gateway: kind, eventId: out.eventId, result: out.result, requestId: client.requestId }, "webhook");
    }
    reply.status(out.httpStatus);
    return { received: out.httpStatus === 200, result: out.result };
  }
}
