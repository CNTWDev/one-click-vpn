import { NextResponse } from "next/server";
import { latestClientReleases } from "../../../../shared/client-releases";
import { publicReleases } from "../../../../server/client-releases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public metadata: safe for signed-out clients checking installation availability. */
export async function GET(request: Request) {
  const channel = new URL(request.url).searchParams.get("channel") || "stable";
  const headers = { "Cache-Control": "no-store" };
  if (channel !== "stable" && channel !== "beta") return NextResponse.json({ code: "INVALID_CHANNEL" }, { status: 400, headers });
  try {
    const releases = latestClientReleases(await publicReleases(), channel);
    return NextResponse.json({ product: "NORTHSTAR", releases }, { headers });
  } catch {
    // Never print manifest contents: operators may have accidentally included secrets.
    console.error("NORTHSTAR client releases unavailable");
    return NextResponse.json({ code: "CLIENT_RELEASES_UNAVAILABLE" }, { status: 503, headers });
  }
}
