import { NextResponse } from "next/server";
import { findAccessCredential } from "../../../../../../server/control-db";
import { manageCredentialAccess } from "../../../../../../server/credential-access";
import { jsonError } from "../../../../../../server/http";
import { requestUser } from "../../../../../../server/request-auth";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await requestUser(request);
  if (!user) return jsonError("Authentication required", 401);
  const { id } = await context.params;
  const credential = await findAccessCredential(id);
  if (!credential || credential.user_id !== user.id) return jsonError("Credential not found", 404);
  try {
    return NextResponse.json(await manageCredentialAccess(id, "revoke", { id: user.id, admin: false }));
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to revoke credential", 409);
  }
}
