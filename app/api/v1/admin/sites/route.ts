import { NextResponse } from "next/server";
import { addAudit } from "../../../../../server/db";
import { jsonError, readJson } from "../../../../../server/http";
import { requestAdmin } from "../../../../../server/request-auth";
import { createSite, listSites, validateSiteInput } from "../../../../../server/sites";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!await requestAdmin(request)) return jsonError("Administrator authentication required", 403);
  return NextResponse.json({ sites: await listSites() });
}

export async function POST(request: Request) {
  const admin = await requestAdmin(request);
  if (!admin) return jsonError("Administrator authentication required", 403);
  try {
    const site = await createSite(validateSiteInput(await readJson(request)));
    await addAudit({ actorUserId: admin.id, action: "site.created", targetType: "site", targetId: site.id, metadata: { name: site.name, portal: site.portalDomain, console: site.consoleDomain, api: site.apiDomain } });
    return NextResponse.json({ site }, { status: 201 });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to create site");
  }
}
