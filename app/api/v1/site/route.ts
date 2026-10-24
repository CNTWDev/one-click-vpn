import { NextResponse } from "next/server";
import { siteBrand, siteForRequest } from "../../../../server/sites";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Name, logo and hostnames of the site the visitor opened; the Portal and Console brand themselves from it. */
export async function GET(request: Request) {
  try {
    return NextResponse.json(siteBrand(await siteForRequest(request)), { headers: { "Cache-Control": "no-cache" } });
  } catch {
    return NextResponse.json({ error: "Site unavailable" }, { status: 503 });
  }
}
