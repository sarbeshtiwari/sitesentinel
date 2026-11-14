/**
 * Bootstrap or add a Super Admin account (admins are never created through a
 * public endpoint). Prints a one-time password (unless ADMIN_PASSWORD is set)
 * and the TOTP enrollment URL; 2FA is mandatory for admins.
 *
 *   pnpm admin:create -- --email ops@example.com --name "Ops" [--role SUPER_ADMIN]
 */
import "reflect-metadata";
import { parseArgs } from "node:util";
import QRCode from "qrcode";
import { generateTotpSecret, hashPassword, LocalKeyProvider, otpauthUrl, randomToken } from "@wim/crypto";
import { createDb, loadSettings } from "@wim/db";
import { ADMIN_ROLE_PERMISSIONS, type AdminRoleKey } from "@wim/core";
import { Email } from "@wim/contracts";
import { KeysService } from "../crypto/keys.service.js";

const { values } = parseArgs({
  options: { email: { type: "string" }, name: { type: "string" }, role: { type: "string", default: "SUPER_ADMIN" } },
});
const email = Email.parse(values.email);
const name = (values.name ?? "").trim();
const role = values.role as AdminRoleKey;
if (!name) throw new Error("--name is required");
if (!(role in ADMIN_ROLE_PERMISSIONS)) throw new Error(`--role must be one of ${Object.keys(ADMIN_ROLE_PERMISSIONS).join(", ")}`);
if (!process.env.ADMIN_DATABASE_URL) throw new Error("ADMIN_DATABASE_URL is required");

const db = createDb({ url: process.env.ADMIN_DATABASE_URL, max: 1, omitSecrets: true });
const keys = new KeysService(LocalKeyProvider.fromEnv());
try {
  const password = process.env.ADMIN_PASSWORD ?? randomToken(18);
  if (password.length < 16) throw new Error("ADMIN_PASSWORD must be at least 16 characters");
  const secret = generateTotpSecret();
  const id = crypto.randomUUID();
  const totpSecretEnc = await keys.sealPlatform(db, "admin-secrets", secret, `admin_users.totp:${id}`);
  await db.adminUser.create({ data: { id, email, name, role, passwordHash: await hashPassword(password), totpSecretEnc } });
  await db.auditLog.createMany({ data: { stream: "platform", actorType: "SYSTEM", actorLabel: "cli", action: "admin.created", targetType: "admin_user", targetId: id, changes: { email, role } } });
  const issuer = `${(await loadSettings(db))["branding.productName"]} Admin`;
  const url = otpauthUrl({ issuer, account: email, secret });
  console.log(`\nSuper Admin created: ${email} (${role})`);
  if (!process.env.ADMIN_PASSWORD) console.log(`One-time password (store it in your password manager now): ${password}`);
  console.log(`\nAdd this account to your authenticator app (shown once):\n${url}\n`);
  console.log(await QRCode.toString(url, { type: "terminal", small: true }));
} finally {
  await db.$disconnect();
}
