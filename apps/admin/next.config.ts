import type { NextConfig } from "next";

const api = process.env.API_INTERNAL_URL ?? "http://127.0.0.1:4000";

// Content-Security-Policy is set per request with a nonce in src/proxy.ts.

const config: NextConfig = {
  transpilePackages: ["@wim/ui"],
  poweredByHeader: false,
  async rewrites() {
    return [{ source: "/api/admin/:path*", destination: `${api}/api/admin/:path*` }];
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
