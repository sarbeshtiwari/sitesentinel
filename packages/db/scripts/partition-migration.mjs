// Rewrites `CREATE TABLE` statements in a Prisma-generated migration so that
// high-volume tables are created as RANGE-partitioned parents.
// Prisma cannot express partitioning; run this on any migration that creates
// one of these tables:  node scripts/partition-migration.mjs <migration.sql>
//
// Child partitions live in the `partitions` schema (created by sql/010) so that
// Prisma's introspection of `public` never sees them as drift.
import { readFileSync, writeFileSync } from "node:fs";

export const PARTITIONED = {
  login_attempts: ["occurred_at", "month"],
  monitoring_executions: ["queued_at", "day"],
  check_results: ["checked_at", "day"],
  page_test_results: ["tested_at", "day"],
  component_test_results: ["tested_at", "day"],
  responsive_test_results: ["tested_at", "day"],
  performance_metrics: ["measured_at", "day"],
  api_test_results: ["checked_at", "day"],
  sdk_events: ["received_at", "day"],
  metrics_hourly: ["bucket", "month"],
  metrics_daily: ["bucket", "month"],
  website_health_scores: ["computed_at", "month"],
  incident_occurrences: ["occurred_at", "month"],
  notification_delivery_logs: ["created_at", "month"],
  security_events: ["occurred_at", "month"],
  system_health_logs: ["recorded_at", "month"],
};

const file = process.argv[2];
if (file) {
  let sql = readFileSync(file, "utf8");
  let count = 0;
  for (const [table, [column]] of Object.entries(PARTITIONED)) {
    const re = new RegExp(`(CREATE TABLE "${table}" \\([\\s\\S]*?\\n\\))(;)`);
    if (re.test(sql)) {
      sql = sql.replace(re, `$1 PARTITION BY RANGE ("${column}")$2`);
      count++;
    }
  }
  writeFileSync(file, sql);
  console.log(`partitioned ${count} table(s) in ${file}`);
}
