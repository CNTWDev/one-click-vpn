import { NextResponse } from "next/server";
import { addAudit } from "../../../../../../server/db";
import { jsonError, readJson } from "../../../../../../server/http";
import { requestAdmin } from "../../../../../../server/request-auth";
import { addTelegramChat, removeTelegramChat, setTelegramChatEvents, type TelegramStatus } from "../../../../../../server/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(request: Request, action: string, work: (body: Record<string, unknown>, chatId: string) => Promise<TelegramStatus>) {
  const admin = await requestAdmin(request);
  if (!admin) return jsonError("Administrator authentication required", 403);
  try {
    const body = await readJson(request);
    const chatId = String(body.chatId ?? "").trim();
    const status = await work(body, chatId);
    await addAudit({ actorUserId: admin.id, action: `telegram.chat.${action}`, targetType: "telegram_chat", targetId: chatId, metadata: Array.isArray(body.events) ? { events: body.events } : {} });
    return NextResponse.json(status);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to update the chat");
  }
}

/** Adds a chat: { chatId }. */
export const POST = (request: Request) => handle(request, "added", (_body, chatId) => addTelegramChat(chatId));
/** Sets what a chat receives: { chatId, events: string[] }. */
export const PUT = (request: Request) => handle(request, "updated", (body, chatId) => setTelegramChatEvents(chatId, body.events));
/** Removes a chat: { chatId }. */
export const DELETE = (request: Request) => handle(request, "removed", (_body, chatId) => removeTelegramChat(chatId));
