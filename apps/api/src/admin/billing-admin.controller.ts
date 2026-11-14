import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put } from "@nestjs/common";
import { z } from "zod";
import { ENTITLEMENT_KEY_TYPES, validateEntitlements } from "@wim/core";
import { gatewaySecretAad, GATEWAY_SECRET_PURPOSE, secretHint, type GatewayKind } from "@wim/billing";
import {
  AdminEntitlementOverrideInput, AdminGatewayConfigInput, AdminPlanCreateInput, AdminPlanEntitlementsInput, AdminPlanPatchInput, AdminPriceCreateInput,
  AdminPricePatchInput, AdminReason, Uuid, type AdminGatewayConfigDto, type DataEnvelope, type PlanDto,
} from "@wim/contracts";
import { sealedKeyVersion } from "@wim/crypto";
import type { Db, Tx } from "@wim/db";
import { ADMIN_DB } from "../infra/infra.module.js";
import { KeysService } from "../crypto/keys.service.js";
import { SettingsService } from "../settings/settings.service.js";
import { PLATFORM_STREAM } from "../audit/audit.service.js";
import { Errors } from "../common/errors.js";
import { AdminApi, Client, CurrentAdmin, parse, RequireAdminPermission, type AdminContext, type ClientInfo } from "../common/context.js";
import { loadPlans } from "../billing/billing.service.js";
import { WEBHOOK_PATH_PREFIX } from "../billing/billing.controller.js";

const GATEWAYS: GatewayKind[] = ["STRIPE", "RAZORPAY"];
const gatewayParam = (v: string): GatewayKind => {
  const g = v.toUpperCase();
  if (g !== "STRIPE" && g !== "RAZORPAY") throw Errors.notFound();
  return g;
};
const issues = (list: string[], path: string) => new z.ZodError(list.map((m) => ({ code: "custom" as const, path: [path], message: m, input: null })));

/**
 * Phase 8 Super Admin billing configuration: plans, immutable price versions, plan entitlements, per-organisation
 * entitlement overrides and payment-gateway configuration. Every mutation is audited (platform stream) with the
 * admin's reason in the same transaction. Gateway secrets are write-only: sealed with a platform data key on the way
 * in, never selected (global omit) and never returned — only "configured" and a short hint.
 */
@AdminApi()
@Controller("api/admin/v1")
export class BillingAdminController {
  constructor(@Inject(ADMIN_DB) private readonly db: Db, private readonly keys: KeysService, private readonly settings: SettingsService) {}

  private audit(tx: Tx, a: AdminContext, client: ClientInfo, action: string, target: { type: string; id: string }, reason: string, changes?: Record<string, unknown>) {
    return tx.auditLog.createMany({ data: {
      stream: PLATFORM_STREAM, actorType: "ADMIN", actorId: a.adminId, actorLabel: a.email, action, targetType: target.type, targetId: target.id,
      changes: (changes ?? undefined) as never, reason, ipPrefix: client.ipPrefix, requestId: client.requestId,
    } });
  }

  private async plan(id: string): Promise<PlanDto> {
    const p = (await loadPlans(this.db, { onlyPublic: false })).find((x) => x.id === id);
    if (!p) throw Errors.notFound();
    return p;
  }

  // ---------------------------------------------------------------- plans
  @Get("billing/plans")
  @RequireAdminPermission("admin:billing:read")
  async plans(): Promise<DataEnvelope<PlanDto[]>> {
    return { data: await loadPlans(this.db, { onlyPublic: false }) };
  }

  @Get("billing/entitlement-keys")
  @RequireAdminPermission("admin:billing:read")
  entitlementKeys() {
    return { data: ENTITLEMENT_KEY_TYPES };
  }

  @Post("billing/plans")
  @RequireAdminPermission("admin:billing:write")
  async createPlan(@CurrentAdmin() a: AdminContext, @Body() body: unknown, @Client() client: ClientInfo): Promise<DataEnvelope<PlanDto>> {
    const input = parse(AdminPlanCreateInput, body);
    const id = await this.db.$transaction(async (tx) => {
      if (await tx.subscriptionPlan.findUnique({ where: { key: input.key }, select: { id: true } })) throw Errors.conflict("A plan with this key already exists");
      const p = await tx.subscriptionPlan.create({ data: { key: input.key, name: input.name, description: input.description, visible: input.visible, trialEligible: input.trialEligible, sortOrder: input.sortOrder } });
      await this.audit(tx, a, client, "admin.plan_created", { type: "subscription_plan", id: p.id }, input.reason, { key: input.key, name: input.name });
      return p.id;
    });
    return { data: await this.plan(id) };
  }

  @Patch("billing/plans/:planId")
  @RequireAdminPermission("admin:billing:write")
  async patchPlan(@CurrentAdmin() a: AdminContext, @Param("planId") planId: string, @Body() body: unknown, @Client() client: ClientInfo): Promise<DataEnvelope<PlanDto>> {
    const id = parse(Uuid, planId);
    const { reason, ...changes } = parse(AdminPlanPatchInput, body);
    await this.db.$transaction(async (tx) => {
      const before = await tx.subscriptionPlan.findUnique({ where: { id } });
      if (!before) throw Errors.notFound();
      await tx.subscriptionPlan.update({ where: { id }, data: { ...changes, archivedAt: changes.active === false ? before.archivedAt ?? new Date() : changes.active === true ? null : undefined } });
      const from = Object.fromEntries(Object.keys(changes).map((k) => [k, (before as Record<string, unknown>)[k]]));
      await this.audit(tx, a, client, "admin.plan_updated", { type: "subscription_plan", id }, reason, { from, to: changes });
    });
    return { data: await this.plan(id) };
  }

  /** Full replacement of the plan's entitlements. Applies to every subscriber within one scheduler cycle (no redeploy). */
  @Put("billing/plans/:planId/entitlements")
  @RequireAdminPermission("admin:billing:write")
  async putEntitlements(@CurrentAdmin() a: AdminContext, @Param("planId") planId: string, @Body() body: unknown, @Client() client: ClientInfo): Promise<DataEnvelope<PlanDto>> {
    const id = parse(Uuid, planId);
    const input = parse(AdminPlanEntitlementsInput, body);
    const problems = validateEntitlements(input.entitlements);
    if (problems.length) throw issues(problems, "entitlements");
    await this.db.$transaction(async (tx) => {
      if (!(await tx.subscriptionPlan.findUnique({ where: { id }, select: { id: true } }))) throw Errors.notFound();
      const before = await tx.planEntitlement.findMany({ where: { planId: id } });
      await tx.planEntitlement.deleteMany({ where: { planId: id } });
      if (Object.keys(input.entitlements).length) {
        await tx.planEntitlement.createMany({ data: Object.entries(input.entitlements).map(([key, value]) => ({ planId: id, key, value })) });
      }
      await this.audit(tx, a, client, "admin.plan_entitlements_replaced", { type: "subscription_plan", id }, input.reason, {
        from: Object.fromEntries(before.map((e) => [e.key, e.value])), to: input.entitlements,
      });
    });
    return { data: await this.plan(id) };
  }

  /** Prices are immutable versions: a new amount is a new version; the previous active one for the same interval+currency is retired. */
  @Post("billing/plans/:planId/prices")
  @RequireAdminPermission("admin:billing:write")
  async createPrice(@CurrentAdmin() a: AdminContext, @Param("planId") planId: string, @Body() body: unknown, @Client() client: ClientInfo): Promise<DataEnvelope<PlanDto>> {
    const id = parse(Uuid, planId);
    const input = parse(AdminPriceCreateInput, body);
    await this.db.$transaction(async (tx) => {
      if (!(await tx.subscriptionPlan.findUnique({ where: { id }, select: { id: true } }))) throw Errors.notFound();
      await this.assertUnlinked(tx, input.stripePriceId, input.razorpayPlanId);
      const last = await tx.planPrice.findFirst({ where: { planId: id, interval: input.interval, currency: input.currency }, orderBy: { version: "desc" }, select: { version: true } });
      await tx.planPrice.updateMany({ where: { planId: id, interval: input.interval, currency: input.currency, active: true }, data: { active: false } });
      const p = await tx.planPrice.create({ data: {
        planId: id, interval: input.interval, currency: input.currency, amountMinor: input.amountMinor, version: (last?.version ?? 0) + 1, active: true,
        stripePriceId: input.stripePriceId ?? null, razorpayPlanId: input.razorpayPlanId ?? null,
      } });
      await this.audit(tx, a, client, "admin.plan_price_created", { type: "plan_price", id: p.id }, input.reason, {
        planId: id, interval: input.interval, currency: input.currency, amountMinor: input.amountMinor, version: p.version,
        stripePriceId: input.stripePriceId ?? null, razorpayPlanId: input.razorpayPlanId ?? null,
      });
    });
    return { data: await this.plan(id) };
  }

  @Patch("billing/prices/:priceId")
  @RequireAdminPermission("admin:billing:write")
  async patchPrice(@CurrentAdmin() a: AdminContext, @Param("priceId") priceId: string, @Body() body: unknown, @Client() client: ClientInfo): Promise<DataEnvelope<PlanDto>> {
    const id = parse(Uuid, priceId);
    const input = parse(AdminPricePatchInput, body);
    const planId = await this.db.$transaction(async (tx) => {
      const before = await tx.planPrice.findUnique({ where: { id } });
      if (!before) throw Errors.notFound();
      if (input.stripePriceId && before.stripePriceId) throw Errors.conflict("This price is already linked to a Stripe price; create a new version instead");
      if (input.razorpayPlanId && before.razorpayPlanId) throw Errors.conflict("This price is already linked to a Razorpay plan; create a new version instead");
      await this.assertUnlinked(tx, input.stripePriceId, input.razorpayPlanId);
      if (input.active === true) {
        await tx.planPrice.updateMany({ where: { planId: before.planId, interval: before.interval, currency: before.currency, active: true, NOT: { id } }, data: { active: false } });
      }
      await tx.planPrice.update({ where: { id }, data: { active: input.active, stripePriceId: input.stripePriceId, razorpayPlanId: input.razorpayPlanId } });
      await this.audit(tx, a, client, "admin.plan_price_updated", { type: "plan_price", id }, input.reason, {
        active: input.active ?? null, stripePriceId: input.stripePriceId ?? null, razorpayPlanId: input.razorpayPlanId ?? null,
      });
      return before.planId;
    });
    return { data: await this.plan(planId) };
  }

  private async assertUnlinked(tx: Tx, stripePriceId?: string, razorpayPlanId?: string) {
    if (stripePriceId && await tx.planPrice.findFirst({ where: { stripePriceId }, select: { id: true } })) throw Errors.conflict("That Stripe price is already linked to another price version");
    if (razorpayPlanId && await tx.planPrice.findFirst({ where: { razorpayPlanId }, select: { id: true } })) throw Errors.conflict("That Razorpay plan is already linked to another price version");
  }

  // ---------------------------------------------------------------- per-organisation entitlement overrides
  @Get("customers/:orgId/entitlement-overrides")
  @RequireAdminPermission("admin:billing:read")
  async overrides(@Param("orgId") orgId: string) {
    const id = parse(Uuid, orgId);
    const rows = await this.db.entitlementOverride.findMany({ where: { orgId: id }, orderBy: { key: "asc" } });
    return { data: rows.map((r) => ({ key: r.key, value: r.value, reason: r.reason, expiresAt: r.expiresAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString() })) };
  }

  @Put("customers/:orgId/entitlement-overrides")
  @RequireAdminPermission("admin:billing:write")
  async putOverride(@CurrentAdmin() a: AdminContext, @Param("orgId") orgId: string, @Body() body: unknown, @Client() client: ClientInfo) {
    const id = parse(Uuid, orgId);
    const input = parse(AdminEntitlementOverrideInput, body);
    const problems = validateEntitlements({ [input.key]: input.value });
    if (problems.length) throw issues(problems, "key");
    await this.db.$transaction(async (tx) => {
      const org = await tx.organization.findUnique({ where: { id }, select: { id: true } });
      if (!org) throw Errors.notFound();
      const before = await tx.entitlementOverride.findUnique({ where: { orgId_key: { orgId: id, key: input.key } } });
      const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
      await tx.entitlementOverride.upsert({
        where: { orgId_key: { orgId: id, key: input.key } },
        create: { orgId: id, key: input.key, value: input.value, reason: input.reason, expiresAt, createdById: a.adminId },
        update: { value: input.value, reason: input.reason, expiresAt, createdById: a.adminId },
      });
      await this.audit(tx, a, client, "admin.entitlement_override_set", { type: "organization", id }, input.reason, { key: input.key, from: before?.value ?? null, to: input.value, expiresAt: input.expiresAt ?? null });
    });
    return this.overrides(id);
  }

  @Post("customers/:orgId/entitlement-overrides/remove")
  @RequireAdminPermission("admin:billing:write")
  @HttpCode(200)
  async removeOverride(@CurrentAdmin() a: AdminContext, @Param("orgId") orgId: string, @Body() body: unknown, @Client() client: ClientInfo) {
    const id = parse(Uuid, orgId);
    const input = parse(z.object({ key: z.string().min(1).max(80), reason: AdminReason }).strict(), body);
    await this.db.$transaction(async (tx) => {
      const before = await tx.entitlementOverride.findUnique({ where: { orgId_key: { orgId: id, key: input.key } } });
      if (!before) throw Errors.notFound();
      await tx.entitlementOverride.delete({ where: { orgId_key: { orgId: id, key: input.key } } });
      await this.audit(tx, a, client, "admin.entitlement_override_removed", { type: "organization", id }, input.reason, { key: input.key, from: before.value });
    });
    return this.overrides(id);
  }

  // ---------------------------------------------------------------- payment gateways (write-only secrets)
  private async gatewayDtos(): Promise<AdminGatewayConfigDto[]> {
    // the global omit (packages/db SECRET_OMIT) keeps secrets_enc out of this query; presence is checked in SQL
    const rows = await this.db.paymentGatewayConfig.findMany();
    const present = await this.db.$queryRaw<Array<{ gateway: string }>>`SELECT gateway::text AS gateway FROM payment_gateway_configs WHERE secrets_enc IS NOT NULL`;
    return GATEWAYS.map((g) => {
      const r = rows.find((x) => x.gateway === g);
      return {
        gateway: g, enabled: r?.enabled ?? false, mode: r?.mode === "live" ? "live" : "test", publicKey: r?.publicKey ?? null, currencies: r?.currencies ?? [],
        secretsConfigured: present.some((p) => p.gateway === g), secretHint: r?.secretHint ?? null, updatedAt: r?.updatedAt.toISOString() ?? null,
        webhookPath: `${WEBHOOK_PATH_PREFIX}${g.toLowerCase()}`,
      };
    });
  }

  @Get("billing/gateways")
  @RequireAdminPermission("admin:billing:read")
  async gateways(): Promise<DataEnvelope<AdminGatewayConfigDto[]>> {
    return { data: await this.gatewayDtos() };
  }

  @Put("billing/gateways/:gateway")
  @RequireAdminPermission("admin:gateways:write")
  async putGateway(@CurrentAdmin() a: AdminContext, @Param("gateway") gw: string, @Body() body: unknown, @Client() client: ClientInfo): Promise<DataEnvelope<AdminGatewayConfigDto>> {
    const g = gatewayParam(gw);
    const input = parse(AdminGatewayConfigInput, body);
    if ((input.secretKey === undefined) !== (input.webhookSecret === undefined)) throw issues(["secretKey and webhookSecret are replaced together"], "secretKey");
    if (g === "RAZORPAY" && input.enabled && !input.publicKey) throw issues(["Razorpay needs the key id (publicKey) for API calls"], "publicKey");
    await this.db.$transaction(async (tx) => {
      const [existing] = await tx.$queryRaw<Array<{ has_secrets: boolean; enabled: boolean; mode: string }>>`
        SELECT secrets_enc IS NOT NULL AS has_secrets, enabled, mode FROM payment_gateway_configs WHERE gateway = ${g}::"GatewayKind" FOR UPDATE`;
      const replacing = input.secretKey !== undefined;
      if (input.enabled && !replacing && !existing?.has_secrets) throw issues(["Store the secret key and webhook secret before enabling the gateway"], "secretKey");
      const sealed = replacing
        ? await this.keys.sealPlatform(tx, GATEWAY_SECRET_PURPOSE, JSON.stringify({ secretKey: input.secretKey, webhookSecret: input.webhookSecret }), gatewaySecretAad(g))
        : undefined;
      const data = {
        enabled: input.enabled, mode: input.mode, publicKey: input.publicKey ?? null, currencies: input.currencies, updatedById: a.adminId,
        ...(sealed ? { secretsEnc: sealed, keyVersion: sealedKeyVersion(Buffer.from(sealed)), secretHint: secretHint(input.secretKey!) } : {}),
      };
      await tx.paymentGatewayConfig.upsert({ where: { gateway: g }, create: { gateway: g, ...data }, update: data, select: { gateway: true } });
      // the audit entry records THAT secrets changed, never their values
      await this.audit(tx, a, client, "admin.gateway_config_changed", { type: "payment_gateway", id: g }, input.reason, {
        enabled: { from: existing?.enabled ?? false, to: input.enabled }, mode: { from: existing?.mode ?? null, to: input.mode },
        currencies: input.currencies, secretsReplaced: replacing,
      });
    });
    this.settings.invalidate();
    return { data: (await this.gatewayDtos()).find((x) => x.gateway === g)! };
  }
}
