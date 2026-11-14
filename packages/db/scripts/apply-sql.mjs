// Applies packages/db/sql/*.sql in lexical order after `prisma migrate deploy`.
// Every file is idempotent, so this runs on every deploy.
import { readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const sqlDir = join(dirname(fileURLToPath(import.meta.url)), "..", "sql");
for (const file of readdirSync(sqlDir).filter((f) => f.endsWith(".sql")).sort()) {
  process.stdout.write(`applying ${file} … `);
  execFileSync("prisma", ["db", "execute", "--file", join(sqlDir, file)], { stdio: ["ignore", "ignore", "inherit"], env: process.env });
  console.log("ok");
}
