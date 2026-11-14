import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { Redis } from "ioredis";
import { newKeyRing } from "@wim/crypto";
import { ROOT_DIR, testEnv } from "./env.js";

/**
 * Build the isolated test infrastructure once per run:
 *  - fresh wim_test database: migrations + SQL layer + seed (packages/db/scripts/setup-test-db.mjs)
 *  - a test-only key ring (outside the database)
 *  - flushed Redis db 1
 *  - test policy: breach check off (no network), IP rate limits raised (every request comes from 127.0.0.1)
 */
export default async function setup() {
  const env = testEnv();
  if (!existsSync(env.KEK_RING_FILE!)) writeFileSync(env.KEK_RING_FILE!, JSON.stringify(newKeyRing("test-1")), { mode: 0o600 });
  execFileSync("node", ["scripts/setup-test-db.mjs"], {
    cwd: join(ROOT_DIR, "packages", "db"),
    env: { ...process.env, MIGRATION_DATABASE_URL: env.MIGRATION_DATABASE_URL!.replace("/wim_test", "/wim") },
    stdio: "inherit",
  });
  const db = new pg.Client({ connectionString: env.MIGRATION_DATABASE_URL });
  await db.connect();
  const overrides: Record<string, unknown> = {
    "auth.password.breachCheck": false,
    "auth.register.perIpPerHour": 1000,
    "auth.login.perIpPer15Min": 1000,
    // Every test request comes from 127.0.0.1; per-email/per-session limits stay at production values.
    "admin.login.perIpPer15Min": 1000,
  };
  for (const [key, value] of Object.entries(overrides)) {
    await db.query("UPDATE platform_settings SET value = $2::jsonb WHERE key = $1", [key, JSON.stringify(value)]);
  }
  await db.end();
  const redis = new Redis(env.REDIS_URL!);
  await redis.flushdb();
  redis.disconnect();
}
