// Creates a local development key ring at .keys/kek.json (git-ignored) if absent.
// The key ring lives outside the database by design. In production it is
// mounted from a secret manager (or replaced by a KMS provider), never committed.
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";

const file = resolve(process.argv[2] ?? ".keys/kek.json");
if (existsSync(file)) {
  console.log(`key ring already exists: ${file}`);
  process.exit(0);
}
mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
const ring = {
  current: "local-1",
  keys: { "local-1": randomBytes(32).toString("base64") },
  hmacPepper: randomBytes(32).toString("base64"),
};
writeFileSync(file, JSON.stringify(ring, null, 2) + "\n", { mode: 0o600 });
chmodSync(file, 0o600);
console.log(`created key ring: ${file}`);
