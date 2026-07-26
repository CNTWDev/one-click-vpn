import { NextResponse } from "next/server";
import { addAudit, findUserById, updateUserStatus, type DbUser } from "../../../../../../../server/db";
import { publicUser } from "../../../../../../../server/device-auth";
import { requestAdmin } from "../../../../../../../server/request-auth";
import { cleanText, jsonError, readJson } from "../../../../../../../server/http";

export const runtime = "nodejs";

const statuses = new Set<DbUser["status"]>(["active", "rejected", "suspended"]);

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const admin = await requestAdmin(request);
  if (!admin) return jsonError("Administrator authentication required", 403);
  const { id } = await context.params;
  const target = await findUserById(id);
  if (!target) return jsonError("User not found", 404);
  try {
    const body = await readJson(request);
    const status = cleanText(body.status, 20) as DbUser["status"];
    const reason = cleanText(body.reason, 500);
    if (!statuses.has(status)) return jsonError("Invalid user status");
    if (target.role === "owner" && status !== "active") return jsonError("The owner account cannot be disabled");
    const user = await updateUserStatus(id, status, admin.id, reason);
    if (!user) return jsonError("User not found", 404);
    await addAudit({ actorUserId: admin.id, action: `user.${status}`, targetType: "user", targetId: id, metadata: reason ? { reason } : {} });
    return NextResponse.json({ user: publicUser(user) });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to update user");
  }
}
