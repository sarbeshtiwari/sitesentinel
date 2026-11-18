import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";
import { display, mono } from "./fonts";
import { Providers } from "./providers";

// Absolute URLs for og:image / twitter:image. Without it Next falls back to http://localhost:<port> in production.
function siteUrl(): URL | undefined {
  try { return process.env.APP_URL ? new URL(process.env.APP_URL) : undefined; } catch { return undefined; }
}

// The visible product name is applied at runtime from platform settings (branding.productName).
export const metadata: Metadata = {
  metadataBase: siteUrl(),
  title: "SiteSentinel",
  description: "Website monitoring for uptime, synthetic browser checks, performance and deep scans.",
  robots: { index: false },
  icons: {
    icon: [{ url: "/favicon/favicon.svg", type: "image/svg+xml" }, { url: "/favicon/favicon-32.png", sizes: "32x32", type: "image/png" }, { url: "/favicon/favicon-16.png", sizes: "16x16", type: "image/png" }],
    apple: "/favicon/apple-touch-icon.png",
  },
  manifest: "/favicon/site.webmanifest",
  openGraph: { title: "SiteSentinel", description: "Website monitoring for uptime, synthetic browser checks, performance and deep scans.", images: [{ url: "/brand/og-image.png", width: 1200, height: 630 }] },
  twitter: { card: "summary_large_image", title: "SiteSentinel", description: "Website monitoring for uptime, synthetic browser checks, performance and deep scans.", images: ["/brand/og-image.png"] },
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [{ media: "(prefers-color-scheme: light)", color: "#f7f8fc" }, { media: "(prefers-color-scheme: dark)", color: "#0b1020" }],
};

// Applies the stored theme before first paint to avoid a light/dark flash.
const themeScript = `try{var t=localStorage.getItem("wim-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" suppressHydrationWarning className={`${display.variable} ${mono.variable}`}>
      <head>
        <script nonce={nonce}>{themeScript}</script>
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
