import { z } from "zod";
import { parseTrustProxy } from "@wim/core";

/**
 * Deployment configuration (per environment). Anything an operator should be
 * able to change at runtime lives in platform_settings instead (@wim/core SETTINGS).
 * No production domain is hard-coded: every public URL comes from here.
 */
const bool = z.enum(["true", "false"]).transform((v) => v === "true");

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(4000),
  HOST: z.string().default("127.0.0.1"),
  REGION: z.string().min(1).default("ap-south-1"), // Mumbai; region-independent code paths

  APP_URL: z.url().default("http://localhost:3000"),
  ADMIN_URL: z.url().default("http://localhost:3001"),
  API_URL: z.url().default("http://localhost:4000"),
  SDK_URL: z.url().default("http://localhost:4200/sdk"),
  INGEST_URL: z.url().default("http://localhost:4200"),
  EMAIL_FROM_DOMAIN: z.string().min(1).default("localhost"),
  EMAIL_FROM_LOCAL_PART: z.string().min(1).default("no-reply"),

  DATABASE_URL: z.string().min(1),
  ADMIN_DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  QUEUE_PREFIX: z.string().min(1).default("wim"),

  // Phase 4D: artifact (screenshot) downloads are streamed by the API from private object storage.
  S3_ENDPOINT: z.url().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_BUCKET_ARTIFACTS: z.string().default("wim-artifacts"),

  COOKIE_SECURE: bool.default(false),
  /** false | true | comma-separated proxy IPs/CIDRs (audit F-1; see @wim/core parseTrustProxy) */
  TRUST_PROXY: z.string().default("false").transform((v, ctx) => {
    try { return parseTrustProxy(v); } catch (e) { ctx.addIssue({ code: "custom", message: (e as Error).message }); return z.NEVER; }
  }),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    // Fail fast at boot with the offending keys (values are never printed).
    const keys = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid environment configuration: ${keys}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === "production" && !env.COOKIE_SECURE) {
    throw new Error("COOKIE_SECURE must be true in production");
  }
  return env;
}

export const ENV = Symbol("ENV");
