import { NextResponse } from "next/server";

export const runtime = "nodejs";

export function GET() {
  return NextResponse.json({
    status: "ok",
    service: "northstar-control-plane",
    build: process.env.NORTHSTAR_BUILD_REV || "unknown",
    time: new Date().toISOString(),
  });
}
