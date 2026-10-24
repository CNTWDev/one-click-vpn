import { NextResponse } from "next/server";
import { jsonError } from "../../../../../../../server/http";
import { requestAdmin } from "../../../../../../../server/request-auth";
import { checkSiteDomains, listSites } from "../../../../../../../server/sites";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Opens each hostname over HTTPS and confirms it reaches this deployment and resolves to this site. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!await requestAdmin(request)) return jsonError("Administrator authentication required", 403);
  const { id } = await context.params;
  const site = (await listSites()).find((item) => item.id === id);
  if (!site) return jsonError("Site not found", 404);
  return NextResponse.json({ checks: await checkSiteDomains(site) });
}
