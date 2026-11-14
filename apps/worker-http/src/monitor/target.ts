import { isIP } from "node:net";
import { parseHttpCheckConfig, type HttpCheckConfig } from "@wim/core";
import type { Tx } from "@wim/db";

/**
 * Target resolution from TRUSTED records only. The queue payload carries an execution id;
 * the organisation, website, origin and configuration all come from here. The host is the
 * verified website's canonical origin — customers configure a path, never a host or URL.
 */
export interface HttpTarget {
  orgId: string;
  websiteId: string;
  url: string;
  host: string;
  https: boolean;
  config: HttpCheckConfig;
  scheduleId: string | null;
}

export type TargetProblem = "INVALID_TARGET" | "BLOCKED_PORT" | "BLOCKED_HOST";

export async function loadTarget(tx: Tx, orgId: string, websiteId: string): Promise<HttpTarget | { problem: TargetProblem; scheduleId: string | null }> {
  const [w] = await tx.$queryRaw<Array<{ origin: string; http_check: unknown; schedule_id: string | null }>>`
    SELECT w.canonical_origin AS origin, mc.http_check, s.id AS schedule_id
      FROM websites w
      LEFT JOIN monitoring_configurations mc ON mc.website_id = w.id
      LEFT JOIN monitoring_schedules s ON s.website_id = w.id AND s.tier = 'T1_HTTP' AND s.api_endpoint_id IS NULL
     WHERE w.id = ${websiteId}::uuid AND w.org_id = ${orgId}::uuid`;
  if (!w) return { problem: "INVALID_TARGET", scheduleId: null };
  let origin: URL;
  try {
    origin = new URL(w.origin);
  } catch {
    return { problem: "INVALID_TARGET", scheduleId: w.schedule_id };
  }
  if ((origin.protocol !== "https:" && origin.protocol !== "http:") || origin.username || origin.password) return { problem: "INVALID_TARGET", scheduleId: w.schedule_id };
  if (origin.port && origin.port !== "80" && origin.port !== "443") return { problem: "BLOCKED_PORT", scheduleId: w.schedule_id };
  if (isIP(origin.hostname.replace(/^\[|\]$/g, ""))) return { problem: "BLOCKED_HOST", scheduleId: w.schedule_id };
  const config = parseHttpCheckConfig(w.http_check);
  // Content assertions need a body: HEAD is only used when nothing reads the body.
  if (config.contentMarker && config.method === "HEAD") config.method = "GET";
  return {
    orgId, websiteId, url: new URL(config.path, origin.origin).toString(), host: origin.hostname.toLowerCase(), https: origin.protocol === "https:",
    config, scheduleId: w.schedule_id,
  };
}
