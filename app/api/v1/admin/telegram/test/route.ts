import { NextResponse } from "next/server";
import { jsonError, readJson } from "../../../../../../server/http";
import { requestAdmin } from "../../../../../../server/request-auth";
import { sendTelegramTest } from "../../../../../../server/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sends a test message to one chat: { chatId }. Telegram's error comes back as is (never with the token). */
export async function POST(request: Request) {
  if (!await requestAdmin(request)) return jsonError("Administrator authentication required", 403);
  try {
    const body = await readJson(request);
    await sendTelegramTest(String(body.chatId ?? ""));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to send", 502);
  }
}
