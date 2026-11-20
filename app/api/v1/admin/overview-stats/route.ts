import { NextResponse } from "next/server";
import { requestAdmin } from "../../../../../server/request-auth";
import { jsonError } from "../../../../../server/http";
import { overviewStats } from "../../../../../server/overview-stats";

export const runtime = "nodejs";

/** Console overview figures beyond the node list: online now, last month's traffic, accounts about to run out. ?fresh=1 skips the short cache. */
export async function GET(request: Request) {
  if (!await requestAdmin(request)) return jsonError("Administrator authentication required", 403);
  return NextResponse.json(await overviewStats({ fresh: new URL(request.url).searchParams.get("fresh") === "1" }), { headers: { "Cache-Control": "no-store" } });
}
