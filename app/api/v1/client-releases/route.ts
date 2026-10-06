import { NextResponse } from "next/server";
import { clientReleaseHistory, latestClientReleases } from "../../../../shared/client-releases";
import { publicReleases } from "../../../../server/client-releases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public metadata: safe for signed-out clients checking installation availability. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams, channel = params.get("channel") || "stable";
  const headers = { "Cache-Control": "no-store" };
  if (channel !== "stable" && channel !== "beta") return NextResponse.json({ code: "INVALID_CHANNEL" }, { status: 400, headers });
  try {
    const all = await publicReleases();
    const releases = latestClientReleases(all, channel);
    // ?history=1 adds older published builds so the Portal can offer previous versions.
    return NextResponse.json({ product: "Veilbird", releases, ...(params.get("history") === "1" ? { history: clientReleaseHistory(all, channel) } : {}) }, { headers });
  } catch {
    // Never print manifest contents: operators may have accidentally included secrets.
    console.error("Veilbird client releases unavailable");
    return NextResponse.json({ code: "CLIENT_RELEASES_UNAVAILABLE" }, { status: 503, headers });
  }
}
