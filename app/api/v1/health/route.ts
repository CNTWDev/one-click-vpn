import { NextResponse } from "next/server";

export const runtime = "nodejs";

export function GET(request: Request) {
  return NextResponse.json({
    status: "ok",
    service: "veilbird-control-plane",
    time: new Date().toISOString(),
    requestId: request.headers.get("x-request-id") || crypto.randomUUID(),
  });
}

