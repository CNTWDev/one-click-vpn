import { NextResponse } from "next/server";
import { addAudit } from "../../../../../server/db";
import { jsonError, readJson } from "../../../../../server/http";
import { requestAdmin } from "../../../../../server/request-auth";
import { deleteTelegram, saveTelegramToken, telegramStatus } from "../../../../../server/telegram";
import "../../../../../server/telegram-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!await requestAdmin(request)) return jsonError("Administrator authentication required", 403);
  return NextResponse.json(await telegramStatus());
}

/** Connects the bot: { token }. The token is checked with Telegram, stored encrypted and never returned. */
export async function PUT(request: Request) {
  const admin = await requestAdmin(request);
  if (!admin) return jsonError("Administrator authentication required", 403);
  try {
    const body = await readJson(request);
    const status = await saveTelegramToken(typeof body.token === "string" ? body.token.trim() : "");
    await addAudit({ actorUserId: admin.id, action: "telegram.bot.connected", targetType: "controller", targetId: "telegram", metadata: { bot: status.bot?.username } });
    return NextResponse.json(status);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to connect the bot");
  }
}

export async function DELETE(request: Request) {
  const admin = await requestAdmin(request);
  if (!admin) return jsonError("Administrator authentication required", 403);
  const status = await deleteTelegram();
  await addAudit({ actorUserId: admin.id, action: "telegram.bot.deleted", targetType: "controller", targetId: "telegram" });
  return NextResponse.json(status);
}
