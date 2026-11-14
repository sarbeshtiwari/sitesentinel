import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** Root .env values (the Docker dev infrastructure), re-pointed at the isolated test database. */
export function testEnv(): Record<string, string> {
  const base: Record<string, string> = {};
  for (const line of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) base[m[1]!] = m[2]!;
  }
  const db = (url: string) => Object.assign(new URL(url), { pathname: "/wim_test" }).toString();
  return {
    ...base,
    NODE_ENV: "test",
    MIGRATION_DATABASE_URL: db(base.MIGRATION_DATABASE_URL!),
    DATABASE_URL: db(base.DATABASE_URL!),
    ADMIN_DATABASE_URL: db(base.ADMIN_DATABASE_URL!),
    WORKER_DATABASE_URL: db(base.WORKER_DATABASE_URL!),
    BROWSER_DATABASE_URL: db(base.BROWSER_DATABASE_URL!),
    SCANNER_DATABASE_URL: db(base.SCANNER_DATABASE_URL!),
    INGEST_DATABASE_URL: db(base.INGEST_DATABASE_URL!),
    SETTINGS_DATABASE_URL: db(base.DATABASE_URL!),
    SDK_URL: "http://localhost:4200/sdk",
    INGEST_URL: "http://localhost:4200",
    REDIS_URL: `${base.REDIS_URL}/1`,
    QUEUE_PREFIX: "wimtest",
    KEK_RING_FILE: join(ROOT, ".keys", "kek.test.json"),
    APP_URL: "http://localhost:3000",
    ADMIN_URL: "http://localhost:3001",
    EMAIL_PROVIDER: "smtp",
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: "51025",
    EMAIL_FROM_DOMAIN: "sitesentinel.test",
    MAILPIT_URL: "http://127.0.0.1:58025",
    COOKIE_SECURE: "false",
    // Phase 4H: the harness's notification worker must not evaluate platform health in the background (tests drive
    // evaluations explicitly with fixed inputs)
    OPS_WATCHDOG: "off",
  };
}

export const ROOT_DIR = ROOT;
