import { NextResponse, type NextRequest } from "next/server";
import { apiRetryAfter } from "./server/rate-limit";

// Every API request gets a correlation id. It is forwarded to route handlers (read through
// server/trace.ts), echoed to the caller as X-Request-Id and written on each log line it produces.
// Request limits (server/rate-limit.ts) run first, so a flood is answered without touching Postgres.
export function proxy(request: NextRequest) {
  const incoming = request.headers.get("x-request-id");
  const requestId = incoming && /^[A-Za-z0-9_-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  const retryAfter = apiRetryAfter(request, request.nextUrl.pathname);
  if (retryAfter) {
    // RATE_LIMITED is the code the apps already handle; the web clients read the status.
    return NextResponse.json({ code: "RATE_LIMITED", error: "Too many requests" }, {
      status: 429, headers: { "Retry-After": String(retryAfter), "Cache-Control": "no-store", "x-request-id": requestId },
    });
  }
  const headers = new Headers(request.headers);
  headers.set("x-request-id", requestId);
  headers.set("x-veilbird-method", request.method);
  headers.set("x-veilbird-path", request.nextUrl.pathname.slice(0, 200));
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("x-request-id", requestId);
  return response;
}

export const config = { matcher: ["/api/:path*", "/download/:path*"] };
