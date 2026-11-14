"use client";
import { Activity, Globe2, MonitorSmartphone, ScanSearch } from "lucide-react";
import { AuthLayout, Logo, LogoSymbol } from "@wim/ui";
import Link from "next/link";
import { useConfig } from "@/lib/hooks";

/** Product mark: the configured logo when one is set (https only), otherwise the SiteSentinel logo with the configured name. */
export function BrandMark({ className = "" }: { className?: string }) {
  const { config } = useConfig();
  if (config.logoUrl && /^https:\/\//.test(config.logoUrl)) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={config.logoUrl} alt={config.productName} className={`h-7 w-auto ${className}`} />;
  }
  return <Logo name={config.productName} className={className} />;
}

// What the product does — capability statements, not metrics (no invented numbers on the sign-in screen).
const CAPABILITIES = [
  { icon: Globe2, title: "Availability", text: "HTTP checks from our monitoring network, with outages told apart from inconclusive checks." },
  { icon: MonitorSmartphone, title: "Synthetic browser checks", text: "Real Chromium sessions measure page load, layout shifts and errors on your key pages." },
  { icon: ScanSearch, title: "Deep scans", text: "Crawl-based audits for broken links, security headers and content issues." },
  { icon: Activity, title: "Incidents you can act on", text: "Grouped incidents, timelines and notifications routed to your team." },
];

function BrandPanel() {
  const { config } = useConfig();
  return (
    <div className="relative flex h-full flex-col justify-between overflow-hidden p-12 text-white">
      {/* Decorative signal rings radiating from the mark — purely ornamental. */}
      <svg aria-hidden className="pointer-events-none absolute -right-40 -top-40 h-[640px] w-[640px] opacity-60" viewBox="0 0 640 640" fill="none">
        {[90, 160, 230, 300].map((r, i) => <circle key={r} cx="320" cy="320" r={r} stroke={i % 2 ? "#22d3ee" : "#6366f1"} strokeOpacity={0.28 - i * 0.05} />)}
      </svg>
      <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-[radial-gradient(ellipse_at_bottom_left,rgb(79_70_229/0.28),transparent_65%)]" />
      <LogoSymbol className="relative h-11 w-11" />
      <div className="relative max-w-md">
        <h2 className="text-[28px] font-semibold leading-tight tracking-tight">Know when your website breaks — before your customers do.</h2>
        <ul className="mt-8 grid gap-5">
          {CAPABILITIES.map(({ icon: Icon, title, text }) => (
            <li key={title} className="flex gap-3.5">
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-white/[0.07] ring-1 ring-white/10"><Icon className="h-4 w-4 text-cyan-300" aria-hidden /></span>
              <span>
                <span className="block text-sm font-medium">{title}</span>
                <span className="block text-sm text-slate-300">{text}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <p className="relative text-xs text-slate-400">{config.productName} · Website monitoring</p>
    </div>
  );
}

export function AuthCard({ title, description, children, footer }: { title: string; description?: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode }) {
  const { config } = useConfig();
  return (
    <AuthLayout
      brand={<Link href="/" className="rounded-md"><BrandMark /></Link>}
      aside={<BrandPanel />}
      footer={
        (config.termsUrl || config.privacyUrl || config.supportEmail) && (
          <p className="flex flex-wrap justify-center gap-4 text-xs">
            {config.termsUrl && <a className="hover:text-foreground" href={config.termsUrl} rel="noopener noreferrer" target="_blank">Terms</a>}
            {config.privacyUrl && <a className="hover:text-foreground" href={config.privacyUrl} rel="noopener noreferrer" target="_blank">Privacy</a>}
            {config.supportEmail && <a className="hover:text-foreground" href={`mailto:${config.supportEmail}`}>Support</a>}
          </p>
        )
      }
    >
      <div className="grid gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      <div className="mt-7">{children}</div>
      {footer && <div className="mt-6 text-center text-sm text-muted-foreground">{footer}</div>}
    </AuthLayout>
  );
}
