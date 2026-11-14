import type { ErrorCode, ErrorEnvelope } from "@wim/contracts";

/** Error thrown for every non-2xx API response, carrying the documented envelope. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | "NETWORK",
    message: string,
    readonly details?: Record<string, unknown>,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** Field → message map from VALIDATION_FAILED details. */
  fieldErrors(): Record<string, string> {
    const issues = (this.details?.issues as Array<{ path: string; message: string }> | undefined) ?? [];
    return Object.fromEntries(issues.map((i) => [i.path, i.message]));
  }
}

const CSRF_COOKIE = "wim_csrf";
const AUTH_PAGES = ["/login", "/register", "/verify-email", "/forgot-password", "/reset-password", "/2fa", "/2fa-reset", "/invitations/accept"];

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const hit = document.cookie.split("; ").find((c) => c.startsWith(`${name}=`) || c.startsWith(`__Host-${name}=`));
  return hit ? decodeURIComponent(hit.slice(hit.indexOf("=") + 1)) : null;
}

let csrfPromise: Promise<void> | null = null;
async function ensureCsrf() {
  if (readCookie(CSRF_COOKIE)) return;
  csrfPromise ??= fetch("/api/v1/auth/csrf", { credentials: "same-origin" }).then(() => undefined).finally(() => { csrfPromise = null; });
  await csrfPromise;
}

export interface RequestOptions {
  /** Don't navigate to /login or /2fa on 401 (pages that handle anonymous users themselves). */
  noAuthRedirect?: boolean;
  signal?: AbortSignal;
}

export async function api<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const unsafe = method !== "GET" && method !== "HEAD";
  if (unsafe) await ensureCsrf();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const csrf = readCookie(CSRF_COOKIE);
  if (unsafe && csrf) headers["X-CSRF-Token"] = csrf;

  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
      signal: opts.signal,
    });
  } catch {
    throw new ApiError(0, "NETWORK", "Can't reach the server. Check your connection and try again.");
  }
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => null)) as (ErrorEnvelope & T) | null;
  if (!res.ok) {
    const e = json?.error;
    const err = new ApiError(res.status, e?.code ?? "INTERNAL", e?.message ?? `Request failed (${res.status})`, e?.details, e?.requestId);
    if (res.status === 401 && !opts.noAuthRedirect && typeof window !== "undefined") {
      const here = window.location.pathname;
      if (!AUTH_PAGES.some((p) => here.startsWith(p))) {
        const next = encodeURIComponent(here + window.location.search);
        window.location.assign(err.code === "SECOND_FACTOR_REQUIRED" ? `/2fa?next=${next}` : `/login?next=${next}`);
      }
    }
    throw err;
  }
  return json as T;
}

export const get = <T>(path: string, opts?: RequestOptions) => api<T>("GET", path, undefined, opts);
export const post = <T>(path: string, body?: unknown, opts?: RequestOptions) => api<T>("POST", path, body ?? {}, opts);
export const patch = <T>(path: string, body: unknown) => api<T>("PATCH", path, body);
export const del = <T>(path: string) => api<T>("DELETE", path);

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "RATE_LIMITED") {
      const s = Number(e.details?.retryAfterSec ?? 0);
      return s > 0 ? `${e.message} (try again in ${s < 90 ? `${Math.ceil(s)} s` : `${Math.ceil(s / 60)} min`})` : e.message;
    }
    return e.message;
  }
  return "Something went wrong";
}

/** Only allow same-site relative redirect targets (no open redirects). */
export function safeNext(next: string | null | undefined, fallback = "/"): string {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : fallback;
}
