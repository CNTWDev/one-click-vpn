import { NextResponse } from "next/server";
import { addAudit } from "../../../../../server/db";
import { cleanText, jsonError, readJson } from "../../../../../server/http";
import { deleteMailSettings, mailSettings, saveMailSettings } from "../../../../../server/mail";
import { requestAdmin } from "../../../../../server/request-auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!await requestAdmin(request)) return jsonError("Administrator authentication required", 403);
  return NextResponse.json({ settings: await mailSettings() });
}

export async function PUT(request: Request) {
  const admin = await requestAdmin(request);
  if (!admin) return jsonError("Administrator authentication required", 403);
  try {
    const body = await readJson(request);
    const provider = body.provider === "aliyun" ? "aliyun" : "smtp";
    const host = cleanText(body.host, 253).toLowerCase();
    const port = Number(body.port);
    const username = cleanText(body.username, 320);
    if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host)) return jsonError("Enter a valid SMTP server");
    if (!Number.isInteger(port) || port < 1 || port > 65535) return jsonError("Enter a valid SMTP port");
    if (!/^\S+@\S+\.\S+$/.test(username)) return jsonError("Enter a valid sender address");
    const settings = await saveMailSettings({ provider, host, port, username, fromName: cleanText(body.fromName, 80), password: typeof body.password === "string" ? body.password.trim() : "" });
    await addAudit({ actorUserId: admin.id, action: "mail.settings.updated", targetType: "controller", targetId: "mail", metadata: { provider, host, port, username } });
    return NextResponse.json({ settings });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to save mail settings");
  }
}

export async function DELETE(request: Request) {
  const admin = await requestAdmin(request);
  if (!admin) return jsonError("Administrator authentication required", 403);
  await deleteMailSettings();
  await addAudit({ actorUserId: admin.id, action: "mail.settings.deleted", targetType: "controller", targetId: "mail" });
  return NextResponse.json({ settings: null });
}
