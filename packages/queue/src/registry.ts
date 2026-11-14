import { z } from "zod";
import { REVALIDATE_QUEUE } from "@wim/contracts";
import { backoffDelay, type MonitoringTier, type QueuePolicy, type SettingsSnapshot } from "@wim/core";

/**
 * Queue topology (PHASE4_PLAN §5.2). Names are defined once here.
 * The Phase 4A `revalidate` queue is the domain-revalidation queue (reused, not duplicated).
 */
export const QUEUES = {
  http: "http-monitoring",
  browser: "browser-monitoring",
  deepscan: "deep-scan",
  revalidation: REVALIDATE_QUEUE,
  deadLetter: "dead-letter",
} as const;

export const TIER_QUEUE_NAME: Record<MonitoringTier, string> = { HTTP: QUEUES.http, BROWSER: QUEUES.browser, DEEPSCAN: QUEUES.deepscan };

export function policyFor(s: SettingsSnapshot, queue: string): QueuePolicy {
  const key = `queue.${queue}` as const;
  const p = (s as Record<string, unknown>)[key] as QueuePolicy | undefined;
  if (!p) throw new Error(`no policy for queue ${queue}`);
  return p;
}

/** BullMQ job options for an execution job under a queue policy. jobId = executionId (Redis-level dedupe). */
export function jobOptions(executionId: string, p: QueuePolicy, priority = 5) {
  return {
    jobId: executionId,
    attempts: p.attempts,
    backoff: { type: "full-jitter" },
    priority,
    removeOnComplete: { age: p.keepCompletedHours * 3600, count: 100_000 },
    removeOnFail: { age: p.keepFailedDays * 86_400 },
  };
}

/** Custom BullMQ backoff strategy: exponential with full jitter, bounded by the queue policy. */
export function backoffStrategy(p: QueuePolicy) {
  return (attemptsMade: number) => Math.max(250, backoffDelay(attemptsMade, p.backoffBaseMs, p.backoffMaxMs));
}

/**
 * Execution job payload: identifiers only. Tenant, website, target URL and policy are
 * always re-read from trusted database rows by the consumer — never taken from here.
 */
export const ExecutionJob = z.object({
  v: z.literal(1),
  executionId: z.uuid(),
  windowStart: z.iso.datetime(),
}).strict();
export type ExecutionJob = z.infer<typeof ExecutionJob>;

export const DeadLetterJob = z.object({ v: z.literal(1), jobFailureId: z.uuid() }).strict();
