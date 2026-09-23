import { NextResponse } from "next/server";
import { addAudit } from "../../../../../server/db";
import { findAccessCredential, renameAccessCredential } from "../../../../../server/control-db";
import { cleanText, jsonError, readJson } from "../../../../../server/http";
import { requestUser } from "../../../../../server/request-auth";

export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await requestUser(request);
  if (!user) return jsonError("Authentication required", 401);
  const { id } = await context.params;
  const credential = await findAccessCredential(id);
  if (!credential || credential.user_id !== user.id) return jsonError("Credential not found", 404);
  try {
    const body = await readJson(request);
    const name = cleanText(body.name, 120);
    if (!name) return jsonError("Credential name is required");
    const updated = await renameAccessCredential(id, name);
    await addAudit({ actorUserId: user.id, action: "credential.renamed", targetType: "credential", targetId: id });
    return NextResponse.json({ credential: updated });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to rename credential", 409);
  }
}
