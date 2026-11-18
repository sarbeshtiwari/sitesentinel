/**
 * Page score (0–100) for the customer "Pages" list and page detail. Pure: the API feeds it the page's check state and
 * its OPEN deep-scan findings (subject = the page's display URL).
 *
 *   null  → "Not checked yet": the page is known (sitemap, link, queued by a scan) but no scan has fetched it yet, or
 *           the last scan skipped it (robots, unsafe route, scope) — we don't score what we haven't seen.
 *   0     → the page itself is broken: its last check failed (HTTP error / unreachable), or it has an open
 *           broken-page finding (BROKEN_PAGE, REDIRECT_LOOP).
 *   else  → 100 − Σ penalty(severity) over its OPEN findings, floored at 0.
 *           CRITICAL 25 · HIGH 15 · MEDIUM 8 · LOW 3 · INFO 0
 *
 * Bands: ≥ 90 good, 50–89 needs work, < 50 poor. Site-wide findings (subject "site", e.g. duplicate titles across
 * pages) and sitemap findings don't count against a single page.
 */
import type { Severity } from "./deepscan.js";

export const PAGE_SCORE_PENALTY: Record<Severity, number> = { CRITICAL: 25, HIGH: 15, MEDIUM: 8, LOW: 3, INFO: 0 };
/** Finding categories meaning "the page itself doesn't load" → score 0. */
export const PAGE_BROKEN_CATEGORIES = ["BROKEN_PAGE", "REDIRECT_LOOP"] as const;
export type PageCheckState = "CHECKED" | "FAILED" | "SKIPPED" | "NOT_CHECKED";
export type PageScoreBand = "GOOD" | "NEEDS_WORK" | "POOR";

export const PAGE_SCORE_FORMULA =
  "Not checked yet = no score. A page that fails to load (HTTP error, unreachable, redirect loop) scores 0. Otherwise 100 minus, for every open finding on the page: critical 25, high 15, medium 8, low 3, info 0 (never below 0). 90+ good, 50–89 needs work, below 50 poor.";

export interface PageScoreInput {
  state: PageCheckState;
  /** OPEN findings on this page */
  findings: Array<{ severity: string; category?: string }>;
}
export interface PageScore {
  score: number | null;
  band: PageScoreBand | null;
  /** why the score is what it is: "NOT_CHECKED" | "BROKEN" | "FINDINGS" */
  basis: "NOT_CHECKED" | "BROKEN" | "FINDINGS";
  /** total penalty from findings (before the floor); 0 when not checked */
  penalty: number;
  bySeverity: Record<Severity, number>;
}

const SEVERITIES: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];
export const emptySeverityCounts = (): Record<Severity, number> => ({ CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 });
const sev = (s: string): Severity => (SEVERITIES.includes(s as Severity) ? (s as Severity) : "INFO");

export function scoreBand(score: number | null): PageScoreBand | null {
  if (score === null) return null;
  return score >= 90 ? "GOOD" : score >= 50 ? "NEEDS_WORK" : "POOR";
}

export function pageScore(i: PageScoreInput): PageScore {
  const bySeverity = emptySeverityCounts();
  let penalty = 0;
  for (const f of i.findings) {
    const s = sev(f.severity);
    bySeverity[s] += 1;
    penalty += PAGE_SCORE_PENALTY[s];
  }
  if (i.state === "NOT_CHECKED" || i.state === "SKIPPED") return { score: null, band: null, basis: "NOT_CHECKED", penalty, bySeverity };
  const broken = i.state === "FAILED" || i.findings.some((f) => (PAGE_BROKEN_CATEGORIES as readonly string[]).includes(f.category ?? ""));
  if (broken) return { score: 0, band: "POOR", basis: "BROKEN", penalty, bySeverity };
  const score = Math.max(0, 100 - penalty);
  return { score, band: scoreBand(score), basis: "FINDINGS", penalty, bySeverity };
}

const SECRET_KEY = /pass(word)?|secret|token|cookie|authori[sz]ation|session|api[-_]?key|credential|signature|private/i;
const SECRET_VALUE = /\b(bearer|basic)\s+[a-z0-9._~+/=-]{8,}|\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}(?:\.[a-zA-Z0-9_-]*)?|(?:[?&](?:token|key|sig|signature|session|password|secret)=)[^&\s]+/gi;

/**
 * Evidence for display: bounded (depth 4, 50 array items, 40 keys, 500 chars per string) and scrubbed — keys that look
 * like credentials are dropped, bearer/JWT-like values and secret query values redacted. The worker already stores
 * display URLs (query values redacted); this is defence in depth for anything shown to customers.
 */
export function sanitizeEvidence(v: unknown, depth = 0): unknown {
  if (v === null || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.replace(SECRET_VALUE, (m) => (m.startsWith("?") || m.startsWith("&") ? `${m.slice(0, m.indexOf("=") + 1)}…` : "[redacted]"));
    return s.length > 500 ? `${s.slice(0, 500)}…` : s;
  }
  if (depth >= 4) return "…";
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => sanitizeEvidence(x, depth + 1));
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 40)) {
      if (SECRET_KEY.test(k)) continue;
      out[k] = sanitizeEvidence(x, depth + 1);
    }
    return out;
  }
  return null;
}
