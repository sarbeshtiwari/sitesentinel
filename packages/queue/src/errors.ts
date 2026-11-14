/**
 * Failure categories decide retry behaviour:
 *  TRANSIENT  — infrastructure hiccup: retried with backoff, then dead-lettered
 *  TIMEOUT    — exceeded the queue's job timeout: treated as transient
 *  PERMANENT  — validation / configuration problem that retrying can't fix: no retry
 *  SECURITY   — forged or inconsistent job (tenant/website mismatch, unknown type): no retry, no replay
 */
export type FailureCategory = "TRANSIENT" | "TIMEOUT" | "PERMANENT" | "SECURITY";

export class JobError extends Error {
  constructor(readonly category: FailureCategory, message: string) {
    super(message);
    this.name = `${category}Error`;
  }
}
export class TransientError extends JobError {
  constructor(message: string) { super("TRANSIENT", message); }
}
export class PermanentError extends JobError {
  constructor(message: string) { super("PERMANENT", message); }
}
export class SecurityError extends JobError {
  constructor(message: string) { super("SECURITY", message); }
}

export function categorize(e: unknown): FailureCategory {
  if (e instanceof JobError) return e.category;
  return "TRANSIENT"; // unknown errors are assumed infrastructural, bounded by max attempts
}
