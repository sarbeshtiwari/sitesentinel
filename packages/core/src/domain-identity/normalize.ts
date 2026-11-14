import { domainToUnicode } from "node:url";
import { parse as parseDomain } from "tldts";

/**
 * Website identity (ARCHITECTURE.md §11.1). Scheme, port, path, query, fragment
 * and alias labels ("www" by default) never change identity:
 *   http://WWW.Example.com:443/shop?x#y  →  identityKey "example.com"
 * IDNs are converted to punycode (UTS-46 via WHATWG URL). The registrable domain
 * comes from the Public Suffix List INCLUDING private suffixes, so
 * alice.github.io and bob.github.io are different owners.
 */
export interface DomainIdentity {
  /** URL as typed (trimmed). */
  input: string;
  /** https://<host as typed, punycode, port dropped> — the URL we contact. */
  canonicalOrigin: string;
  /** Lower-case punycode host exactly as entered (may include "www"). */
  host: string;
  /** Host with leading alias labels removed — the identity of the website. */
  hostKey: string;
  /** PSL eTLD+1 (with platform-added suffixes applied). */
  registrableDomain: string;
  /** Unicode form for display. */
  displayHost: string;
  /** hostKey === registrableDomain */
  isRoot: boolean;
  identityKey: string;
}

export type DomainErrorCode =
  | "EMPTY" | "INVALID_URL" | "UNSUPPORTED_SCHEME" | "IP_ADDRESS" | "RESERVED_NAME" | "NON_DEFAULT_PORT"
  | "NO_REGISTRABLE_DOMAIN" | "CREDENTIALS_IN_URL" | "TOO_LONG";

export class DomainError extends Error {
  constructor(readonly code: DomainErrorCode, message: string) {
    super(message);
    this.name = "DomainError";
  }
}

/** Special-use and internal names that can never be a customer's public website. */
const RESERVED_TLDS = new Set(["local", "localhost", "internal", "intranet", "lan", "home", "corp", "invalid", "test", "example", "onion", "arpa", "localdomain", "home.arpa"]);
const RESERVED_DOMAINS = new Set(["example.com", "example.net", "example.org"]);

export interface NormalizeOptions {
  /** Leading labels treated as aliases of the same site (setting domain.aliasLabels). */
  aliasLabels?: readonly string[];
  /** Extra suffixes the platform treats as public (domain_policy_suffixes). */
  extraSuffixes?: readonly string[];
  /** Test-only: accept reserved TLDs such as .test (never enabled in production). */
  allowReservedForTests?: boolean;
}

export function normalizeWebsiteUrl(raw: string, opts: NormalizeOptions = {}): DomainIdentity {
  const input = (raw ?? "").trim();
  if (!input) throw new DomainError("EMPTY", "Enter your website address");
  if (input.length > 2048) throw new DomainError("TOO_LONG", "That address is too long");
  if (/[\s\u0000-\u001f\u007f]/.test(input)) throw new DomainError("INVALID_URL", "The address contains spaces or control characters");

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new DomainError("INVALID_URL", "That doesn't look like a website address");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new DomainError("UNSUPPORTED_SCHEME", "Only http and https websites are supported");
  if (url.username || url.password) throw new DomainError("CREDENTIALS_IN_URL", "Remove the username or password from the address");
  if (url.port) throw new DomainError("NON_DEFAULT_PORT", "Websites must be served on the standard port (80 or 443)");

  // WHATWG URL already lower-cases, applies IDNA/UTS-46 and canonicalises IPv4 forms (e.g. 0x7f.1 → 127.0.0.1).
  let host = url.hostname.replace(/\.$/, "");
  if (!host) throw new DomainError("INVALID_URL", "That doesn't look like a website address");
  if (host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) throw new DomainError("IP_ADDRESS", "Register a domain name, not an IP address");
  if (host.length > 253 || host.split(".").some((l) => l.length === 0 || l.length > 63)) throw new DomainError("INVALID_URL", "That domain name is not valid");
  if (!host.includes(".")) throw new DomainError("RESERVED_NAME", "Use a public domain name (for example shop.example.co.in)");

  const labels = host.split(".");
  const tld = labels[labels.length - 1]!;
  const lastTwo = labels.slice(-2).join(".");
  if (!opts.allowReservedForTests && (RESERVED_TLDS.has(tld) || RESERVED_TLDS.has(lastTwo) || RESERVED_DOMAINS.has(lastTwo))) {
    throw new DomainError("RESERVED_NAME", "Reserved and internal domain names can't be monitored");
  }

  let registrableDomain = registrable(host, opts.extraSuffixes ?? []);
  if (!registrableDomain && opts.allowReservedForTests && labels.length >= 2) registrableDomain = lastTwo;
  if (!registrableDomain) throw new DomainError("NO_REGISTRABLE_DOMAIN", "That address is a public suffix, not a website domain");

  // Strip alias labels only while something remains above the registrable domain.
  const aliases = new Set((opts.aliasLabels ?? ["www"]).map((a) => a.toLowerCase()));
  let hostKey = host;
  while (hostKey !== registrableDomain) {
    const [first, ...rest] = hostKey.split(".");
    if (!first || !aliases.has(first)) break;
    hostKey = rest.join(".");
  }

  return {
    input,
    canonicalOrigin: `https://${host}`,
    host,
    hostKey,
    registrableDomain,
    displayHost: domainToUnicode(hostKey) || hostKey,
    isRoot: hostKey === registrableDomain,
    identityKey: hostKey,
  };
}

function registrable(host: string, extraSuffixes: readonly string[]): string | null {
  // Platform-added public suffixes take precedence over the PSL (longest match).
  const extra = [...extraSuffixes].map((s) => s.toLowerCase().replace(/^\.|\.$/g, "")).sort((a, b) => b.length - a.length)
    .find((s) => host === s || host.endsWith(`.${s}`));
  if (extra) {
    if (host === extra) return null;
    const above = host.slice(0, -(extra.length + 1)).split(".");
    return `${above[above.length - 1]}.${extra}`;
  }
  const parsed = parseDomain(host, { allowPrivateDomains: true });
  if (parsed.isIp) return null;
  return parsed.domain ?? null;
}

/** Same website identity for an Origin header value (used by SDK ingest origin checks). */
export function originHostKey(origin: string, opts: NormalizeOptions = {}): string | null {
  try {
    const u = new URL(origin);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return normalizeWebsiteUrl(`${u.protocol}//${u.hostname}`, opts).hostKey;
  } catch {
    return null;
  }
}
