import { pino, type DestinationStream, type Logger, type LoggerOptions } from "pino";

/**
 * Central redaction list (SECURITY.md §13). Any field with these names, at the
 * top level or one/two levels deep, is replaced before serialization.
 */
const SECRET_KEYS = [
  "password", "newPassword", "currentPassword", "passwordHash", "token", "accessToken", "refreshToken",
  "secret", "secretEnc", "totpSecret", "code", "recoveryCode", "recoveryCodes", "apiKey", "authorization",
  "cookie", "set-cookie", "credentials", "privateKey", "csrfSecret", "x-csrf-token", "sessionToken",
];

export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers[\"x-csrf-token\"]",
  "res.headers[\"set-cookie\"]",
  ...SECRET_KEYS,
  ...SECRET_KEYS.map((k) => `*.${k}`),
  ...SECRET_KEYS.map((k) => `*.*.${k}`),
];

/** Patterns that look like secrets even inside free text (messages, error strings). */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]"],
  [/\b(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g, "[REDACTED_JWT]"],
  [/([?&](?:token|key|secret|password|code)=)[^&\s]+/gi, "$1[REDACTED]"],
  [/\b(sk|rk)_(live|test)_[A-Za-z0-9]{8,}\b/g, "[REDACTED_KEY]"],
];

export function scrubText(input: string): string {
  return SECRET_PATTERNS.reduce((s, [re, rep]) => s.replace(re, rep), input);
}

export function createLogger(name: string, opts: LoggerOptions = {}, destination?: DestinationStream): Logger {
  const options: LoggerOptions = {
    name,
    level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "silent" : "info"),
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    hooks: {
      logMethod(args, method) {
        // Scrub string arguments (the message and any interpolation values).
        method.apply(this, args.map((a) => (typeof a === "string" ? scrubText(a) : a)) as Parameters<typeof method>);
      },
    },
    formatters: { level: (label) => ({ level: label }) },
    ...opts,
  };
  return destination ? pino(options, destination) : pino(options);
}

export type { Logger };
