import { NextResponse } from "next/server";

export const runtime = "nodejs";

export function GET() {
  return NextResponse.json({
    status: "ok",
    service: "veilbird-control-plane",
    build: process.env.VEILBIRD_BUILD_REV || "unknown",
    time: new Date().toISOString(),
  });
}
