import { createHash } from "node:crypto";
import type { Tx } from "@wim/db";
import type { S3 } from "@wim/storage";

export interface PendingArtifact { key: string; viewport: string; purpose: "FAILURE" | "VIEWPORT" | "FULL_PAGE"; bytes: number; sha256: string }

/** Deterministic key per execution/viewport: a retried execution overwrites, never multiplies, its objects. */
export function artifactKey(orgId: string, websiteId: string, executionId: string, viewport: string, purpose: string) {
  return `orgs/${orgId}/websites/${websiteId}/executions/${executionId}/${viewport}-${purpose.toLowerCase()}.png`;
}

/** Bytes of screenshots stored by the org today (quota). */
export async function screenshotBytesToday(tx: Tx, orgId: string): Promise<number> {
  const [r] = await tx.$queryRaw<Array<{ v: bigint | null }>>`
    SELECT value AS v FROM usage_counters WHERE org_id = ${orgId}::uuid AND period_start = (now() AT TIME ZONE 'UTC')::date AND key = 'browser.screenshot_bytes'`;
  return Number(r?.v ?? 0);
}

export async function upload(s3: S3, key: string, png: Buffer): Promise<{ bytes: number; sha256: string }> {
  await s3.put(key, png, "image/png");
  return { bytes: png.length, sha256: createHash("sha256").update(png).digest("hex") };
}
