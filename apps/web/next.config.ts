import type { NextConfig } from "next";
import { resolve } from "node:path";

// Tolerate a trailing "/" or "/api" in the configured base URL (rewrites add "/api/…" themselves).
const api = (process.env.API_INTERNAL_URL ?? "http://127.0.0.1:4000").trim().replace(/\/+$/, "").replace(/\/api$/, "");

// Content-Security-Policy is set per request with a nonce in src/proxy.ts.

// Container images (infra/docker/{web,admin}.Dockerfile) build a self-contained server with NEXT_OUTPUT_STANDALONE=1.
// Unset (local dev, `next start` hosts) the build output is unchanged. `next build` runs in apps/<name>, so the
// monorepo root is two levels up; tracing from there lets the standalone bundle include workspace packages.
const standalone = process.env.NEXT_OUTPUT_STANDALONE === "1";

const config: NextConfig = {
  ...(standalone ? { output: "standalone" as const, outputFileTracingRoot: resolve(process.cwd(), "../..") } : {}),
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
