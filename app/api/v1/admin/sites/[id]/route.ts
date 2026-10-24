import { NextResponse } from "next/server";
import { addAudit } from "../../../../../../server/db";
import { jsonError, readJson } from "../../../../../../server/http";
import { requestAdmin } from "../../../../../../server/request-auth";
import { deleteSite, makeDefaultSite, updateSite, validateSiteInput } from "../../../../../../server/sites";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function PUT(request: Request, context: Context) {
  const admin = await requestAdmin(request);
  if (!admin) return jsonError("Administrator authentication required", 403);
  const { id } = await context.params;
  try {
    const site = await updateSite(id, validateSiteInput(await readJson(request)));
    if (!site) return jsonError("Site not found", 404);
    await addAudit({ actorUserId: admin.id, action: "site.updated", targetType: "site", targetId: id, metadata: { name: site.name, portal: site.portalDomain, console: site.consoleDomain, api: site.apiDomain } });
    return NextResponse.json({ site });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to update site");
  }
}

/** `{ "default": true }` makes this the site for unknown hostnames and the native apps. */
export async function PATCH(request: Request, context: Context) {
  const admin = await requestAdmin(request);
  if (!admin) return jsonError("Administrator authentication required", 403);
  const { id } = await context.params;
  try {
    if ((await readJson(request)).default !== true) return jsonError("Nothing to change");
    if (!await makeDefaultSite(id)) return jsonError("Site not found", 404);
    await addAudit({ actorUserId: admin.id, action: "site.default", targetType: "site", targetId: id });
    return NextResponse.json({ status: "ok" });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to update site");
  }
}

export async function DELETE(request: Request, context: Context) {
  const admin = await requestAdmin(request);
  if (!admin) return jsonError("Administrator authentication required", 403);
  const { id } = await context.params;
  try {
    await deleteSite(id);
    await addAudit({ actorUserId: admin.id, action: "site.deleted", targetType: "site", targetId: id });
    return NextResponse.json({ status: "deleted" });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to delete site", error instanceof Error && error.message === "Site not found" ? 404 : 400);
  }
}
