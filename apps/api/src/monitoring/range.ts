import { AppError } from "../common/errors.js";

const MAX_RANGE_MS = 90 * 86_400_000;

/** Range [from, to): explicit ISO bounds, max 90 days, default the last 24 hours. */
export function rangeOf(q: { from?: string; to?: string }) {
  const to = q.to ? new Date(q.to) : new Date();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 86_400_000);
  if (!(from < to)) throw new AppError(400, "VALIDATION_FAILED", "`from` must be before `to`");
  if (to.getTime() - from.getTime() > MAX_RANGE_MS) throw new AppError(400, "VALIDATION_FAILED", "The time range can be at most 90 days");
  return { from, to };
}
