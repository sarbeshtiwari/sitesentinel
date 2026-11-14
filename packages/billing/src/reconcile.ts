import { applyBillingFact, expireIfDue, type SubStatus, type SubscriptionState } from "@wim/core";
import { withSystem, type Db } from "@wim/db";
import { createGateway, loadGatewayConfig, type GatewayEndpoints, type SecretOpener } from "./config.js";
import type { GatewayKind } from "./types.js";

export interface ReconcileReport {
  ran: boolean;
  reason?: string;
  expired: number;
  canceled: number;
  trialsConverted: number;
  checked: number;
  corrected: number;
  gatewayErrors: number;
}

const toState = (r: {
  status: string; planId: string; planPriceId: string | null; currentPeriodStart: Date | null; currentPeriodEnd: Date | null; cancelAtPeriodEnd: boolean;
  canceledAt: Date | null; graceEndsAt: Date | null; pendingPlanPriceId: string | null; gatewayUpdatedAt: Date | null;
}): SubscriptionState => ({ ...r, status: r.status as SubStatus });

/**
 * Daily billing maintenance (scheduler, wim_worker, system context). Idempotent and single-instance:
 *  - a transaction-scoped advisory lock admits one runner; a run marker in system_health_logs makes it once a day
 *  - time-based transitions: CANCELING past period end → CANCELED, PAST_DUE past grace → EXPIRED
 *  - trials of organisations that now pay are marked CONVERTED
 *  - when billing is enabled and a gateway is configured: compare each current gateway subscription with the gateway's
 *    view and apply it through the same state machine (gateway time = now, so it never overrides a newer webhook…
 *    except where the webhook was lost, which is the point)
 */
export async function runBillingReconciliation(db: Db, o: {
  now?: Date; billingEnabled: boolean; graceDays: number; open: SecretOpener | null; endpoints?: GatewayEndpoints; force?: boolean;
}): Promise<ReconcileReport> {
  const now = o.now ?? new Date();
  const report: ReconcileReport = { ran: false, expired: 0, canceled: 0, trialsConverted: 0, checked: 0, corrected: 0, gatewayErrors: 0 };
  const go = await withSystem(db, async (tx) => {
    const [lock] = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtext('wim.billing.reconcile')) AS locked`;
    if (!lock?.locked) return false;
    if (!o.force) {
      const [ran] = await tx.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*) AS n FROM system_health_logs WHERE component = 'billing' AND metric = 'reconcile_run' AND recorded_at > ${now}::timestamptz - interval '23 hours'`;
      if (Number(ran?.n ?? 0) > 0) return false;
    }
    await tx.systemHealthLog.create({ data: { component: "billing", metric: "reconcile_run", value: 1, recordedAt: now } });
    return true;
  });
  if (!go) return { ...report, reason: "already ran or running" };
  report.ran = true;

  // 1. time-based transitions
  await withSystem(db, async (tx) => {
    const due = await tx.subscription.findMany({
      where: { OR: [{ status: "CANCELING", currentPeriodEnd: { lte: now } }, { status: "PAST_DUE", graceEndsAt: { lte: now } }] },
    });
    for (const row of due) {
      const r = expireIfDue(toState(row), now);
      if (!r.applied) continue;
      const updated = await tx.subscription.updateMany({ where: { id: row.id, status: row.status }, data: { status: r.state.status, canceledAt: r.state.canceledAt, graceEndsAt: r.state.graceEndsAt } });
      if (updated.count) { if (r.to === "EXPIRED") report.expired++; else report.canceled++; }
    }
    // 2. trial conversion bookkeeping
    const converted = await tx.$executeRaw`
      UPDATE trials t SET status = 'CONVERTED'
       WHERE t.status = 'ACTIVE' AND EXISTS (SELECT 1 FROM subscriptions s WHERE s.org_id = t.org_id AND s.status IN ('ACTIVE', 'CANCELING') AND s.gateway IS NOT NULL)`;
    report.trialsConverted = Number(converted);
  });

  // 3. gateway comparison (never while billing is disabled)
  if (!o.billingEnabled || !o.open) return { ...report, reason: !o.billingEnabled ? "billing disabled: gateway comparison skipped" : "no key provider: gateway comparison skipped" };
  for (const kind of ["STRIPE", "RAZORPAY"] as GatewayKind[]) {
    const cfg = await withSystem(db, (tx) => loadGatewayConfig(tx, kind, o.open!)).catch(() => null);
    if (!cfg?.enabled || !cfg.credentials) continue;
    const gw = createGateway(kind, cfg.credentials, o.endpoints);
    const subs = await withSystem(db, (tx) => tx.subscription.findMany({
      where: { gateway: kind, gatewaySubscriptionId: { not: null }, status: { notIn: ["CANCELED", "EXPIRED"] } }, select: { id: true, gatewaySubscriptionId: true },
    }));
    for (const s of subs) {
      report.checked++;
      let snap;
      try { snap = await gw.getSubscription(s.gatewaySubscriptionId!); } catch { report.gatewayErrors++; continue; }
      if (snap.status === null) continue;
      await withSystem(db, async (tx) => {
        await tx.$queryRaw`SELECT id FROM subscriptions WHERE id = ${s.id}::uuid FOR UPDATE`;
        const row = await tx.subscription.findUniqueOrThrow({ where: { id: s.id } });
        const col = kind === "STRIPE" ? "stripePriceId" : "razorpayPlanId";
        const price = snap.priceRef ? await tx.planPrice.findFirst({ where: { [col]: snap.priceRef }, select: { id: true, planId: true } }) : null;
        const r = applyBillingFact(toState(row), {
          kind: "SNAPSHOT", at: now, status: snap.status!, currentPeriodStart: snap.currentPeriodStart, currentPeriodEnd: snap.currentPeriodEnd,
          cancelAtPeriodEnd: snap.cancelAtPeriodEnd, planId: price?.planId, planPriceId: price ? price.id : undefined, canceledAt: snap.canceledAt,
        }, { graceDays: o.graceDays });
        if (!r.applied) return;
        const differs = r.state.status !== row.status || r.state.planId !== row.planId || r.state.cancelAtPeriodEnd !== row.cancelAtPeriodEnd
          || r.state.currentPeriodEnd?.getTime() !== row.currentPeriodEnd?.getTime();
        if (!differs) return;
        await tx.subscription.update({ where: { id: row.id }, data: {
          status: r.state.status, planId: r.state.planId, planPriceId: r.state.planPriceId, currentPeriodStart: r.state.currentPeriodStart,
          currentPeriodEnd: r.state.currentPeriodEnd, cancelAtPeriodEnd: r.state.cancelAtPeriodEnd, canceledAt: r.state.canceledAt,
          graceEndsAt: r.state.graceEndsAt, gatewayUpdatedAt: r.state.gatewayUpdatedAt,
        } });
        await tx.systemHealthLog.create({ data: { component: "billing", metric: "reconcile_corrected", value: 1 } });
        report.corrected++;
      });
    }
  }
  return report;
}
