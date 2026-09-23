import { NextResponse } from "next/server";
import { addAudit } from "../../../../../server/db";
import { findAccessCredential, renameAccessCredential } from "../../../../../server/control-db";
import { cleanText, jsonError, readJson } from "../../../../../server/http";
import { requestUser } from "../../../../../server/request-auth";
import { manageCredentialAccess, type CredentialAction } from "../../../../../server/credential-access";

export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await requestUser(request);
  if (!user) return jsonError("Authentication required", 401);
  const { id } = await context.params;
  const credential = await findAccessCredential(id);
  if (!credential || credential.user_id !== user.id) return jsonError("Credential not found", 404);
  try {
    const body = await readJson(request);
    if (body.action) {
      const action = cleanText(body.action, 20) as CredentialAction;
      if (!["enable", "disable", "revoke", "delete"].includes(action)) return jsonError("Unsupported action");
      return NextResponse.json(await manageCredentialAccess(id, action, { id: user.id, admin: false }));
    }
    if (credential.deleted_at) return jsonError("Credential not found", 404);
    const name = cleanText(body.name, 120);
    if (!name) return jsonError("Credential name is required");
    const updated = await renameAccessCredential(id, name);
    await addAudit({ actorUserId: user.id, action: "credential.renamed", targetType: "credential", targetId: id });
    return NextResponse.json({ credential: updated });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to rename credential", 409);
  }
}
