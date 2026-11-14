import type { Queue } from "bullmq";
import { loadSettings, withSystem, type Db } from "@wim/db";

/**
 * Transactional outbox relay: events committed with monitoring results become email jobs.
 * At-least-once into Redis (jobId = outbox id dedupes while the job is retained; worker-notify
 * additionally skips recipients already delivered for the same job), so a crash between
 * enqueue and marking never duplicates an email.
 */
export async function relayOutbox(db: Db, emailQueue: Queue, limit = 200): Promise<number> {
  return withSystem(db, async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: bigint; topic: string }>>`
      SELECT id, topic FROM outbox_events WHERE published_at IS NULL ORDER BY id LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
    if (!rows.length) return 0;
    const notify = rows.filter((r) => /^(incident\.(opened|resolved)|ssl\.expiring|monitoring\.interrupted)$/.test(r.topic));
    // Phase 4H: platform self-alerts use the same outbox → e-mail path (no second notification system)
    const alerts = rows.filter((r) => r.topic === "platform.alert");
    const delivery = alerts.length ? (await loadSettings(db))["ops.alerts.delivery"] : null;
    const jobs = [
      ...notify.map((r) => ({
        name: "MONITORING_NOTICE",
        data: { kind: "MONITORING_NOTICE", outboxId: String(r.id) },
        opts: { jobId: `outbox.${r.id}`, attempts: 6, backoff: { type: "exponential", delay: 30_000 }, removeOnComplete: { age: 7 * 86_400 }, removeOnFail: { age: 14 * 86_400 } },
      })),
      ...alerts.map((r) => ({
        name: "PLATFORM_ALERT",
        data: { kind: "PLATFORM_ALERT", outboxId: String(r.id) },
        opts: { jobId: `outbox.${r.id}`, attempts: delivery!.attempts, backoff: { type: "exponential", delay: delivery!.backoffMs }, removeOnComplete: { age: 7 * 86_400 }, removeOnFail: { age: 14 * 86_400 } },
      })),
    ];
    if (jobs.length) await emailQueue.addBulk(jobs);
    await tx.$executeRaw`UPDATE outbox_events SET published_at = now(), attempts = attempts + 1 WHERE id = ANY(${rows.map((r) => r.id)}::bigint[])`;
    return rows.length;
  });
}

/**
 * Partition maintenance (create upcoming partitions, drop expired ones per partitions.config).
 * Runs at most once per hour across all scheduler instances.
 */
export async function partitionMaintenance(db: Db): Promise<{ ran: boolean; dropped: string[] }> {
  try {
    return await partitionMaintenanceOnce(db);
  } catch (e) {
    // Phase 4H: a failed run is recorded (retention.failing alert), not only logged; retried next tick
    await withSystem(db, (tx) => tx.systemHealthLog.create({ data: { component: "maintenance", metric: "partitions_failed", value: 1 } })).catch(() => undefined);
    throw e;
  }
}
async function partitionMaintenanceOnce(db: Db): Promise<{ ran: boolean; dropped: string[] }> {
  return withSystem(db, async (tx) => {
    const [{ locked }] = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtext('wim.partition-maintenance')) AS locked`;
    if (!locked) return { ran: false, dropped: [] };
    const [{ due }] = await tx.$queryRaw<Array<{ due: boolean }>>`
      SELECT coalesce(max(recorded_at) < now() - interval '1 hour', true) AS due FROM system_health_logs
       WHERE component = 'maintenance' AND metric = 'partitions_ok' AND recorded_at > now() - interval '2 hours'`;
    if (!due) return { ran: false, dropped: [] };
    await tx.$queryRaw`SELECT partitions.ensure_all()`;
    const dropped = await tx.$queryRaw<Array<{ dropped: string }>>`SELECT dropped FROM partitions.apply_retention()`;
    await tx.systemHealthLog.create({ data: { component: "maintenance", metric: "partitions_ok", value: dropped.length } });
    return { ran: true, dropped: dropped.map((d) => d.dropped) };
  });
}
