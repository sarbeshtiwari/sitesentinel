import { decideTrial, type SettingsSnapshot, type TrialOutcome } from "@wim/core";
import type { Tx } from "@wim/db";

/**
 * Evaluate and (if eligible) activate the org's trial at first verification of
 * a website. Must run inside the verification transaction (system context).
 *
 * Race safety:
 *  - the org row is locked, so two websites of one org verifying at the same time serialize;
 *  - the ledger row for the registrable domain is locked, so two orgs can't both trial it;
 *  - trials.org_id is UNIQUE (one trial per org, ever) and the insert is ON CONFLICT DO NOTHING.
 */
export async function evaluateTrial(tx: Tx, orgId: string, registrableDomain: string, s: SettingsSnapshot): Promise<TrialOutcome> {
  await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${orgId}::uuid FOR UPDATE`;
  await tx.$executeRaw`
    INSERT INTO domain_trial_ledger (registrable_domain, updated_at) VALUES (${registrableDomain}, now())
    ON CONFLICT (registrable_domain) DO NOTHING`;
  const [ledger] = await tx.$queryRaw<Array<{ trial_consumed_at: Date | null }>>`
    SELECT trial_consumed_at FROM domain_trial_ledger WHERE registrable_domain = ${registrableDomain} FOR UPDATE`;
  const orgTrial = await tx.trial.findUnique({ where: { orgId }, select: { status: true, endsAt: true } });
  const decision = decideTrial({
    trialsEnabled: s["trial.enabled"],
    domainTrialConsumed: ledger?.trial_consumed_at != null,
    orgTrial,
    now: new Date(),
  });

  if (decision.outcome === "ACTIVATED") {
    const inserted = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO trials (org_id, registrable_domain, status, starts_at, ends_at)
      VALUES (${orgId}::uuid, ${registrableDomain}, 'ACTIVE', now(), now() + make_interval(days => ${s["trial.days"]}))
      ON CONFLICT (org_id) DO NOTHING RETURNING id`;
    if (!inserted.length) return "ORG_TRIAL_ALREADY_USED"; // unreachable while the org row is locked; kept as a guard
  }
  if (decision.markDomainConsumed) {
    await tx.$executeRaw`
      UPDATE domain_trial_ledger
         SET trial_consumed_at = coalesce(trial_consumed_at, now()), trial_count = trial_count + 1, updated_at = now()
       WHERE registrable_domain = ${registrableDomain}`;
  }
  return decision.outcome;
}
