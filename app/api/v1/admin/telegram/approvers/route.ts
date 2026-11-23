import { NextResponse } from "next/server";
import { addAudit } from "../../../../../../server/db";
import { jsonError, readJson } from "../../../../../../server/http";
import { requestAdmin } from "../../../../../../server/request-auth";
import { setTelegramApprovers } from "../../../../../../server/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Replaces the approvers: { approvers: telegramUserId[] }. Only people the bot has seen can be added. */
export async function PUT(request: Request) {
  const admin = await requestAdmin(request);
  if (!admin) return jsonError("Administrator authentication required", 403);
  try {
    const body = await readJson(request);
    const status = await setTelegramApprovers(body.approvers);
    await addAudit({ actorUserId: admin.id, action: "telegram.approvers.updated", targetType: "controller", targetId: "telegram", metadata: { approvers: status.approvers.map((person) => person.id) } });
    return NextResponse.json(status);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to save approvers");
  }
}
