import type { NextConfig } from "next";

// Tolerate a trailing "/" or "/api" in the configured base URL (rewrites add "/api/…" themselves).
const api = (process.env.API_INTERNAL_URL ?? "http://127.0.0.1:4000").trim().replace(/\/+$/, "").replace(/\/api$/, "");

// Content-Security-Policy is set per request with a nonce in src/proxy.ts.

const config: NextConfig = {
  transpilePackages: ["@wim/ui"],
  poweredByHeader: false,
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${api}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default config;
