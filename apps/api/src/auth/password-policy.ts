import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { createLogger } from "@wim/logger";
import { SettingsService } from "../settings/settings.service.js";
import { Errors } from "../common/errors.js";

const log = createLogger("password-policy");

// A short local deny-list catches the most common choices even when the breach API is unreachable.
const COMMON = new Set([
  "password1234", "passwordpassword", "123456789012", "qwertyuiopas", "iloveyou1234", "welcome12345",
  "letmein12345", "adminadmin12", "changeme1234", "sitesentinel", "monitoring123", "p@ssw0rd1234",
]);

/**
 * NIST SP 800-63B style: length (from settings), no composition rules, reject
 * breached / common passwords and passwords containing the email local part.
 */
@Injectable()
export class PasswordPolicy {
  constructor(private readonly settings: SettingsService) {}

  async assertAcceptable(password: string, email: string): Promise<void> {
    const s = await this.settings.get();
    if (password.length < s["auth.password.minLength"]) {
      throw Errors.weakPassword(`Use at least ${s["auth.password.minLength"]} characters`);
    }
    if (password.length > 128) throw Errors.weakPassword("Use at most 128 characters");
    const lower = password.toLowerCase();
    if (COMMON.has(lower) || /^(.)\1+$/.test(password)) throw Errors.weakPassword("This password is too common");
    const local = email.split("@")[0]?.toLowerCase() ?? "";
    if (local.length >= 4 && lower.includes(local)) throw Errors.weakPassword("Don't include your email address in your password");
    if (s["auth.password.breachCheck"] && (await this.isBreached(password))) {
      throw Errors.weakPassword("This password appeared in a data breach. Choose a different one");
    }
  }

  /** HIBP k-anonymity range API: only the first 5 hex chars of the SHA-1 leave the server. Fails open. */
  private async isBreached(password: string): Promise<boolean> {
    const sha1 = createHash("sha1").update(password).digest("hex").toUpperCase();
    try {
      const res = await fetch(`https://api.pwnedpasswords.com/range/${sha1.slice(0, 5)}`, {
        headers: { "Add-Padding": "true" },
        signal: AbortSignal.timeout(2_000),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const suffix = sha1.slice(5);
      return (await res.text()).split("\n").some((line) => {
        const [hash, count] = line.trim().split(":");
        return hash === suffix && Number(count) > 0;
      });
    } catch (e) {
      log.warn({ err: (e as Error).message }, "breached-password check unavailable; failing open");
      return false;
    }
  }
}
