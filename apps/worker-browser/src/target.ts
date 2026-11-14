import { isIP } from "node:net";
import { parseBrowserCheckConfig, type BrowserCheckConfig } from "@wim/core";
import type { Tx } from "@wim/db";

/** Target from TRUSTED rows only: verified origin + registrable domain + the customer's path. */
export interface BrowserTarget { url: string; host: string; registrableDomain: string; config: BrowserCheckConfig }

export async function loadBrowserTarget(tx: Tx, orgId: string, websiteId: string): Promise<BrowserTarget | { problem: "INVALID_TARGET" | "BLOCKED_PORT" | "BLOCKED_HOST" }> {
  const [w] = await tx.$queryRaw<Array<{ origin: string; registrable: string; browser_check: unknown }>>`
    SELECT w.canonical_origin AS origin, r.registrable_domain AS registrable, mc.browser_check
      FROM websites w
      JOIN domain_claims c ON c.id = w.domain_claim_id
      JOIN domain_registry r ON r.id = c.domain_registry_id
      LEFT JOIN monitoring_configurations mc ON mc.website_id = w.id
     WHERE w.id = ${websiteId}::uuid AND w.org_id = ${orgId}::uuid`;
  if (!w) return { problem: "INVALID_TARGET" };
  let origin: URL;
  try { origin = new URL(w.origin); } catch { return { problem: "INVALID_TARGET" }; }
  if ((origin.protocol !== "https:" && origin.protocol !== "http:") || origin.username || origin.password) return { problem: "INVALID_TARGET" };
  if (origin.port && origin.port !== "80" && origin.port !== "443") return { problem: "BLOCKED_PORT" };
  if (isIP(origin.hostname.replace(/^\[|\]$/g, ""))) return { problem: "BLOCKED_HOST" };
  const config = parseBrowserCheckConfig(w.browser_check);
  return { url: new URL(config.path, origin.origin).toString(), host: origin.hostname.toLowerCase(), registrableDomain: w.registrable, config };
}
