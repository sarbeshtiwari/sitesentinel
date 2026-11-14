import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";
import { Providers } from "./providers";

// The visible product name is applied at runtime from platform settings (branding.productName).
export const metadata: Metadata = { title: "Admin console", robots: { index: false } };
export const viewport: Viewport = { width: "device-width", initialScale: 1 };

// Applies the stored theme before first paint to avoid a light/dark flash.
const themeScript = `try{var t=localStorage.getItem("wim-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script nonce={nonce}>{themeScript}</script>
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
