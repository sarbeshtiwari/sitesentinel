import { NextResponse, type NextRequest } from "next/server";

/**
 * Per-request CSP nonce (SECURITY.md §10/§11). Scripts run only with this request's
 * nonce ('strict-dynamic' lets Next's own nonce'd bootstrap load its chunks); no
 * 'unsafe-inline' for scripts. 'unsafe-eval' only in development (React dev tooling).
 * style-src keeps 'unsafe-inline' for React style attributes and the runtime brand colour.
 */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const dev = process.env.NODE_ENV === "development";
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    `connect-src 'self'${dev ? " ws: wss:" : ""}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    ...(dev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  // Pages only: API calls are proxied to the backend (which sets its own strict CSP), static assets need none.
  matcher: [{ source: "/((?!api|_next/static|_next/image|favicon.ico).*)" }],
};
