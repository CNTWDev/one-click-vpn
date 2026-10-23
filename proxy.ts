import { NextResponse, type NextRequest } from "next/server";

// Every API request gets a correlation id. It is forwarded to route handlers (read through
// server/trace.ts), echoed to the caller as X-Request-Id and written on each log line it produces.
export function proxy(request: NextRequest) {
  const incoming = request.headers.get("x-request-id");
  const requestId = incoming && /^[A-Za-z0-9_-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  const headers = new Headers(request.headers);
  headers.set("x-request-id", requestId);
  headers.set("x-veilbird-method", request.method);
  headers.set("x-veilbird-path", request.nextUrl.pathname.slice(0, 200));
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("x-request-id", requestId);
  return response;
}

export const config = { matcher: "/api/:path*" };
