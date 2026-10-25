import { NextResponse } from "next/server";
import { alertStatus, saveAlertRecipients } from "../../../../../server/alerts";
import { addAudit } from "../../../../../server/db";
import { jsonError, readJson } from "../../../../../server/http";
import { requestAdmin } from "../../../../../server/request-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!await requestAdmin(request)) return jsonError("Administrator authentication required", 403);
  return NextResponse.json(await alertStatus());
}

export async function PUT(request: Request) {
  const admin = await requestAdmin(request);
  if (!admin) return jsonError("Administrator authentication required", 403);
  try {
    const body = await readJson(request);
    await saveAlertRecipients(body.recipients);
    await addAudit({ actorUserId: admin.id, action: "alerts.recipients.updated", targetType: "controller", targetId: "primary" });
    return NextResponse.json(await alertStatus());
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to save alert recipients");
  }
}
