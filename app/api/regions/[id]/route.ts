import { NextResponse } from "next/server";
import { addAudit, deleteRegion, findRegion, updateRegion } from "../../../../server/db";
import { updateControlRegion } from "../../../../server/control-db";
import { currentUser } from "../../../../server/auth";
import { cleanText, jsonError, readJson } from "../../../../server/http";

export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return jsonError("Authentication required", 401);
  const { id } = await context.params;
  if (!findRegion(id)) return jsonError("Region not found", 404);
  try {
    const body = await readJson(request);
    const name = cleanText(body.name, 80);
    const country = cleanText(body.country, 80);
    const code = cleanText(body.code, 8).toUpperCase();
    if (!name || !country || !/^[A-Z]{2,8}$/.test(code)) return jsonError("Region name, country, and code are required");
    const region = updateRegion(id, { name, country, code });
    if (region) updateControlRegion(id, `${region.name} · ${region.country}`);
    addAudit({ actorUserId: user.id, action: "region.updated", targetType: "region", targetId: id });
    return NextResponse.json({ region });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to update region");
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return jsonError("Authentication required", 401);
  const { id } = await context.params;
  if (!findRegion(id)) return jsonError("Region not found", 404);
  if (!deleteRegion(id)) return jsonError("This region is still assigned to one or more nodes", 409);
  addAudit({ actorUserId: user.id, action: "region.deleted", targetType: "region", targetId: id });
  return NextResponse.json({ ok: true });
}
