"use client";
import { useQuery } from "@tanstack/react-query";
import type { DataEnvelope, WebsiteDetailDto, WebsiteSummaryDto } from "@wim/contracts";
import type { InstallationState } from "@wim/core";
import { get } from "./api";
import { fmtTime, localDay } from "./monitoring";

export const wk = {
  list: (orgId: string) => ["org", orgId, "websites"] as const,
  detail: (orgId: string, id: string) => ["org", orgId, "websites", id] as const,
  verifications: (orgId: string, id: string) => ["org", orgId, "websites", id, "verifications"] as const,
  history: (orgId: string, id: string) => ["org", orgId, "websites", id, "history"] as const,
  audit: (orgId: string, id: string) => ["org", orgId, "websites", id, "audit"] as const,
  transfers: (orgId: string) => ["org", orgId, "transfers"] as const,
  incoming: (orgId: string) => ["org", orgId, "transfers", "incoming"] as const,
};

export function useWebsites(orgId: string) {
  return useQuery({
    queryKey: wk.list(orgId),
    queryFn: () => get<DataEnvelope<WebsiteSummaryDto[]>>(`/orgs/${orgId}/websites`).then((r) => r.data),
    enabled: Boolean(orgId),
  });
}

export function useWebsite(orgId: string, id: string, refetchInterval?: number | false) {
  return useQuery({
    queryKey: wk.detail(orgId, id),
    queryFn: () => get<DataEnvelope<WebsiteDetailDto>>(`/orgs/${orgId}/websites/${id}`).then((r) => r.data),
    enabled: Boolean(orgId && id),
    refetchInterval,
  });
}

export const CATEGORIES: Array<{ value: string; label: string }> = [
  { value: "ECOMMERCE", label: "E-commerce" },
  { value: "SAAS", label: "SaaS / web app" },
  { value: "CORPORATE", label: "Corporate / marketing" },
  { value: "BLOG_MEDIA", label: "Blog / media" },
  { value: "EDUCATION", label: "Education" },
  { value: "GOVERNMENT", label: "Government" },
  { value: "NONPROFIT", label: "Non-profit" },
  { value: "PORTFOLIO", label: "Portfolio" },
  { value: "OTHER", label: "Other" },
];
export const categoryLabel = (v: string) => CATEGORIES.find((c) => c.value === v)?.label ?? v;

type Tone = "neutral" | "brand" | "success" | "warning" | "danger";

export const INSTALL_STATE: Record<InstallationState, { label: string; tone: Tone }> = {
  NOT_INSTALLED: { label: "Not installed", tone: "neutral" },
  DETECTED: { label: "Installation detected", tone: "brand" },
  ACTIVE: { label: "Active", tone: "success" },
  INACTIVE: { label: "Inactive", tone: "warning" },
  INVALID_CONFIGURATION: { label: "Invalid configuration", tone: "danger" },
};

export const VERIFICATION_STATE: Record<string, { label: string; tone: Tone }> = {
  PENDING: { label: "Unverified", tone: "warning" },
  VERIFIED: { label: "Verified", tone: "success" },
  LAPSED: { label: "Verification lapsed", tone: "warning" },
  EXPIRED: { label: "Verification expired", tone: "danger" },
  RELEASED: { label: "Released", tone: "neutral" },
  TRANSFERRED_OUT: { label: "Transferred", tone: "neutral" },
  REJECTED: { label: "Rejected", tone: "danger" },
};

export const TRIAL_OUTCOME: Record<string, string> = {
  ACTIVATED: "Free trial started by this website",
  COVERED_BY_ACTIVE_TRIAL: "Covered by your organization's active trial",
  ORG_TRIAL_ALREADY_USED: "Your organization has already used its free trial",
  DOMAIN_PREVIOUSLY_TRIALED: "This domain has already received a free trial — no new trial",
  TRIALS_DISABLED: "Free trials are currently not offered",
};

export const FAILURE_REASON: Record<string, string> = {
  DNS_RECORD_NOT_FOUND: "The TXT record wasn't found. Check the record name and value, then allow time for DNS to update.",
  DNS_PROPAGATING: "Some DNS resolvers see the record and some don't yet. Wait a few minutes and try again.",
  DNS_UNAVAILABLE: "Your DNS servers didn't answer. Try again later.",
  TOKEN_NOT_FOUND_IN_FILE: "The verification file was reachable but doesn't contain the exact value on its own line.",
  META_TAG_NOT_FOUND: "No verification meta tag was found in the page <head>.",
  META_TOKEN_MISMATCH: "A verification meta tag was found but its content doesn't match your token.",
  BLOCKED_DESTINATION: "The domain resolves to a private or reserved address, so it can't be checked.",
  REDIRECTS_OFF_SITE: "The page redirects to a different website. Verification only follows redirects within your own domain.",
  HOST_NOT_FOUND: "The domain doesn't resolve to any address.",
  SITE_UNREACHABLE: "We couldn't connect to your website over HTTPS or HTTP.",
  TOKEN_ROTATED: "The token changed after this check was requested. Use the current token.",
  VERIFICATION_EXPIRED: "The verification window expired.",
  CLAIM_CHANGED: "The claim changed while the check was running. Try again.",
  CHECK_ERROR: "The check failed unexpectedly. Try again.",
};
export function failureText(reason: string | null): string {
  if (!reason) return "";
  if (/^HTTP_\d+$/.test(reason)) return `The verification URL returned HTTP ${reason.slice(5)}.`;
  return FAILURE_REASON[reason] ?? reason;
}

export const INVALID_REASON: Record<string, string> = {
  ORIGIN_MISMATCH: "The script ran on a different domain or subdomain than this website. Install it only on this website, or add the other domain as its own website.",
  ORIGIN_MISSING: "A request arrived without a browser origin (typically a bot, link preview or tool, not a visitor). It was ignored; nothing to fix on your site.",
  WEBSITE_NOT_VERIFIED: "The script ran before ownership was verified. Verify the website; new page loads will then count.",
  REVOKED_KEY: "The page uses a revoked site key. Replace the snippet with the current one.",
  EXPIRED_KEY: "The page uses a previous site key whose grace period ended. Replace the snippet with the current one.",
};

export const METHOD_LABEL: Record<string, string> = {
  DNS_TXT: "DNS TXT record", WELL_KNOWN_FILE: "HTML file", HTML_META: "Meta tag", SDK_BEACON: "SDK", ANY: "Any method",
};

// Same labelled format as monitoring data ("YYYY-MM-DD HH:mm <zone>") so every screen shows times alike.
export const fmt = fmtTime;
export const fmtDate = (d: string | null | undefined) => (d ? localDay(d) : "—");

export function relative(d: string | null | undefined): string {
  if (!d) return "—";
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  const abs = Math.abs(s);
  const [v, u] = abs < 60 ? [abs, "s"] : abs < 3600 ? [Math.round(abs / 60), "min"] : abs < 86_400 ? [Math.round(abs / 3600), "h"] : [Math.round(abs / 86_400), "d"];
  return s >= 0 ? `${v} ${u} ago` : `in ${v} ${u}`;
}

// ---------------------------------------------------------------- installation snippets
export interface SnippetParts { scriptUrl: string; siteKey: string; endpoint: string | null }

export function snippetParts(snippet: string, scriptUrl: string, siteKey: string): SnippetParts {
  const endpoint = /data-endpoint="([^"]+)"/.exec(snippet)?.[1] ?? null;
  return { scriptUrl, siteKey, endpoint };
}

export const FRAMEWORKS = ["html", "react", "next-app", "next-pages", "vue", "angular", "wordpress"] as const;
export type Framework = (typeof FRAMEWORKS)[number];
export const FRAMEWORK_LABEL: Record<Framework, string> = {
  html: "Plain HTML", react: "React", "next-app": "Next.js (App Router)", "next-pages": "Next.js (Pages Router)", vue: "Vue", angular: "Angular", wordpress: "WordPress",
};

export function frameworkInstructions(f: Framework, p: SnippetParts, snippet: string): { where: string; code: string; note?: string } {
  const epJsx = p.endpoint ? `\n          data-endpoint="${p.endpoint}"` : "";
  switch (f) {
    case "html":
      return { where: "Paste before </head> on every page.", code: snippet };
    case "react":
      return {
        where: "Simplest: paste the plain snippet into public/index.html (Create React App) or index.html (Vite) before </head>. Or load it once from your root component:",
        code: `import { useEffect } from "react";

export function SiteSentinelMonitor() {
  useEffect(() => {
    if (document.querySelector('script[data-site-key="${p.siteKey}"]')) return;
    const s = document.createElement("script");
    s.src = "${p.scriptUrl}";
    s.async = true;
    s.dataset.siteKey = "${p.siteKey}";${p.endpoint ? `\n    s.dataset.endpoint = "${p.endpoint}";` : ""}
    document.head.appendChild(s);
  }, []);
  return null;
}

// Render <SiteSentinelMonitor /> once, e.g. in App.tsx.`,
      };
    case "next-app":
      return {
        where: "Add to app/layout.tsx:",
        code: `import Script from "next/script";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Script
          src="${p.scriptUrl}"
          data-site-key="${p.siteKey}"${epJsx}
          strategy="afterInteractive"
        />
      </body>
    </html>
  );
}`,
        note: "If you use a Content-Security-Policy with nonces, pass your nonce to <Script nonce={nonce} />.",
      };
    case "next-pages":
      return {
        where: "Add to pages/_app.tsx:",
        code: `import type { AppProps } from "next/app";
import Script from "next/script";

export default function App({ Component, pageProps }: AppProps) {
  return (
    <>
      <Script
        src="${p.scriptUrl}"
        data-site-key="${p.siteKey}"${epJsx}
        strategy="afterInteractive"
      />
      <Component {...pageProps} />
    </>
  );
}`,
      };
    case "vue":
      return {
        where: "Paste the snippet into index.html before </head> (Vite / Vue CLI). For Nuxt, add it to app.head.script in nuxt.config:",
        code: `${snippet}

<!-- Nuxt 3: nuxt.config.ts -->
export default defineNuxtConfig({
  app: {
    head: {
      script: [{ src: "${p.scriptUrl}", async: true, "data-site-key": "${p.siteKey}"${p.endpoint ? `, "data-endpoint": "${p.endpoint}"` : ""} }],
    },
  },
});`,
      };
    case "angular":
      return { where: "Paste into src/index.html before </head>:", code: snippet };
    case "wordpress":
      return {
        where: "Add to your (child) theme's functions.php, or paste the plain snippet into a header-scripts plugin:",
        code: `add_action('wp_enqueue_scripts', function () {
    wp_enqueue_script('sitesentinel-monitor', '${p.scriptUrl}', array(), null, false);
});

add_filter('script_loader_tag', function ($tag, $handle) {
    if ($handle !== 'sitesentinel-monitor') return $tag;
    return str_replace(' src=', ' async data-site-key="${p.siteKey}"${p.endpoint ? ` data-endpoint="${p.endpoint}"` : ""} src=', $tag);
}, 10, 2);`,
        note: "Caching plugins: clear the page cache after installing.",
      };
  }
}
