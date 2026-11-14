import type { ErrorCode } from "@wim/contracts";

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const Errors = {
  unauthenticated: (message = "Sign in to continue") => new AppError(401, "UNAUTHENTICATED", message),
  invalidCredentials: () => new AppError(401, "UNAUTHENTICATED", "Incorrect email or password"),
  secondFactorRequired: () => new AppError(401, "SECOND_FACTOR_REQUIRED", "Complete two-factor authentication"),
  forbidden: (message = "You don't have permission to do that") => new AppError(403, "FORBIDDEN", message),
  csrf: () => new AppError(403, "CSRF_INVALID", "Request could not be verified. Refresh the page and try again"),
  suspended: () => new AppError(403, "ACCOUNT_SUSPENDED", "This account is suspended"),
  emailNotVerified: () => new AppError(403, "EMAIL_NOT_VERIFIED", "Verify your email address first"),
  /** Also used for resources owned by another tenant: no existence oracle. */
  notFound: () => new AppError(404, "NOT_FOUND", "Not found"),
  conflict: (message: string, details?: Record<string, unknown>) => new AppError(409, "CONFLICT", message, details),
  invalidCode: () => new AppError(400, "INVALID_CODE", "That code didn't work. Check it and try again"),
  invalidToken: () => new AppError(400, "INVALID_TOKEN", "This link is invalid or has expired"),
  weakPassword: (reason: string) => new AppError(400, "WEAK_PASSWORD", reason),
  lastOwner: () => new AppError(409, "LAST_OWNER", "An organization must keep at least one owner"),
  registrationClosed: () => new AppError(403, "REGISTRATION_CLOSED", "Registration is currently closed"),
  rateLimited: (retryAfterSec: number, message = "Too many attempts. Try again later") =>
    new AppError(429, "RATE_LIMITED", message, { retryAfterSec }, { "Retry-After": String(Math.max(1, Math.ceil(retryAfterSec))) }),
};
