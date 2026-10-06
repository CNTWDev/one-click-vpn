import { NextResponse } from "next/server";
import { latestClientReleases, parseClientReleases } from "../../../../shared/client-releases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public metadata: safe for signed-out clients checking installation availability. */
export function GET(request: Request) {
  const channel = new URL(request.url).searchParams.get("channel") || "stable";
  const headers = { "Cache-Control": "no-store" };
  if (channel !== "stable" && channel !== "beta") return NextResponse.json({ code: "INVALID_CHANNEL" }, { status: 400, headers });
  try {
    const releases = latestClientReleases(parseClientReleases(process.env.NORTHSTAR_CLIENT_RELEASES_JSON || "[]"), channel);
    return NextResponse.json({ product: "NORTHSTAR", releases }, { headers });
  } catch {
    // Never print manifest contents: operators may have accidentally included secrets.
    console.error("Invalid NORTHSTAR client release manifest");
    return NextResponse.json({ code: "CLIENT_RELEASES_UNAVAILABLE" }, { status: 503, headers });
  }
}
