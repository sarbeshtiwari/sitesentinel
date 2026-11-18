/**
 * TRUST_PROXY (api, ingest): which reverse proxies may set X-Forwarded-For (audit finding F-1).
 *
 *  - "false"            ignore X-Forwarded-For (req.ip = socket peer). Default.
 *  - "true"             trust every hop (req.ip = left-most value). Only safe when the single proxy in front
 *                       OVERWRITES X-Forwarded-For (as infra/oracle/nginx does) and nothing else can reach the app.
 *  - "<ip|cidr>[,…]"    trust only these proxy addresses, e.g. the nginx/app Docker network "10.253.10.0/24".
 *                       A forged left-most value from an untrusted peer is never used.
 *
 * The result is passed as-is to Fastify's `trustProxy` option.
 */
export type TrustProxy = boolean | string[];

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}(\/(3[0-2]|[12]?\d))?$/;
const IPV6 = /^[0-9a-fA-F:]+(\/(12[0-8]|1[01]\d|\d?\d))?$/;

export function parseTrustProxy(raw: string | undefined): TrustProxy {
  const v = (raw ?? "false").trim();
  if (v === "" || v === "false") return false;
  if (v === "true") return true;
  const list = v.split(",").map((s) => s.trim()).filter(Boolean);
  for (const item of list) {
    if (!IPV4.test(item) && !(item.includes(":") && IPV6.test(item))) {
      throw new Error("TRUST_PROXY must be true, false or a comma-separated list of IP addresses/CIDRs");
    }
  }
  return list;
}
