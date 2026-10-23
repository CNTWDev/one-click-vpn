import { NextResponse } from "next/server";
import { addAudit, findUserById } from "../../../../../../../server/db";
import { ADMIN_LINK_TTL_SECONDS, createResetLink } from "../../../../../../../server/password-reset";
import { requestAdmin } from "../../../../../../../server/request-auth";
import { jsonError } from "../../../../../../../server/http";

export const runtime = "nodejs";

/** Creates a one-time reset link the administrator passes to the user; the administrator never sees a password. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const admin = await requestAdmin(request);
  if (!admin) return jsonError("Administrator authentication required", 403);
  const { id } = await context.params;
  const target = await findUserById(id);
  if (!target) return jsonError("User not found", 404);
  if (target.role === "owner") return jsonError("Reset the owner password on the server with scripts/reset-admin-password.sh");
  if (target.status !== "active" && target.status !== "pending") return jsonError("Only active or pending accounts can reset their password");
  const link = await createResetLink(id, ADMIN_LINK_TTL_SECONDS);
  if (!link) return jsonError("User not found", 404);
  await addAudit({ actorUserId: admin.id, action: "user.password_reset_link", targetType: "user", targetId: id });
  return NextResponse.json(link);
}
