import { defineConfig, devices } from "@playwright/test";

/**
 * E2E tests run against an already-running stack (API, email worker, web, admin,
 * Docker Postgres/Redis/Mailpit). Override URLs with WEB_URL / ADMIN_URL / MAILPIT_URL.
 *
 * The API rate-limits registration (5/hour/IP) and admin login (5/15 min/email), so repeated
 * runs from one machine hit 429s by design. In development, clear only the rate-limit counters:
 *   docker compose -f infra/compose/docker-compose.dev.yml exec -T redis \
 *     sh -c 'redis-cli -a wim_redis_dev_password --no-auth-warning --scan --pattern "rl:*" | xargs -r redis-cli -a wim_redis_dev_password --no-auth-warning del'
 */
export default defineConfig({
  testDir: ".",
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { ...devices["Desktop Chrome"], trace: "retain-on-failure" },
});
