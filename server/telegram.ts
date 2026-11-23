import { randomBytes } from "node:crypto";
import { dbExec, dbQuery } from "./db";
import { decryptSecret, encryptSecret } from "./crypto";
import { writeOperationalLog } from "./operational-logs";
import { listSites, siteBrand } from "./sites";
import { approvalButtons, escapeHtml, type InlineButton, parseCallback, personName, renderMessage, scrubToken, type TelegramMessage, validToken } from "./telegram-format";

export type { TelegramMessage } from "./telegram-format";

// Telegram is the one channel for notifications and approvals (Console → Controller → Telegram).
// One bot; its token is encrypted with the master key like every other secret and never logged or returned.
// Each added chat picks the events it receives. Approvals are inline buttons that only the listed approvers
// may press; the bot reads presses (and /start, to discover chats) by long polling, so no inbound port is needed.
//
// Other modules use three calls:
//   defineEvent("rollout", { approval: true })            once, at import time
//   notify("alerts", { tone: "alert", title, lines })     fire and forget; never throws
//   requestApproval({ kind, target, event, message })     sends approve / reject buttons; see registerApproval

type EventInfo = { key: string; approval: boolean };
type ApprovalHandler = {
  /** Applies the decision. Returns the line shown under the message afterwards, e.g. "已通过". */
  decide: (target: string, approve: boolean, by: { telegramId: string; name: string }) => Promise<string>;
};
// Next.js may load this file once for instrumentation (the polling loop) and again for API routes, so the
// state they must share lives on globalThis: a token saved in the Console reaches the running loop at once.
type State = {
  events: Map<string, EventInfo>; handlers: Map<string, ApprovalHandler>;
  cache: { row: SettingsRow | null; token: string } | null;
  receiving: { ok: boolean; error?: string; at?: string }; loop: AbortController | null;
};
const state: State = ((globalThis as { __veilbirdTelegram?: State }).__veilbirdTelegram ??= { events: new Map(), handlers: new Map(), cache: null, receiving: { ok: false }, loop: null });
const events = state.events;
const handlers = state.handlers;
/** Declares an event chats can subscribe to. Approval events get buttons and need approvers. */
export function defineEvent(key: string, options: { approval?: boolean } = {}) {
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(key)) throw new Error(`Invalid Telegram event ${key}`);
  events.set(key, { key, approval: Boolean(options.approval) });
}
defineEvent("alerts");
defineEvent("signups", { approval: true });
defineEvent("releases", { approval: true });

export function registerApproval(kind: string, handler: ApprovalHandler) { handlers.set(kind, handler); }

type SettingsRow = { token_ciphertext: string; token_iv: string; token_tag: string; bot_id: string; bot_username: string; bot_name: string; update_offset: string; approvers: Person[]; updated_at: Date };
type ChatRow = { chat_id: string; title: string; kind: ChatKind; events: string[] };
type ChatKind = "private" | "group" | "supergroup" | "channel";
type Person = { id: string; name: string };

// A self-hosted Bot API server (or the tests' fake one) can stand in for api.telegram.org.
const api = () => (process.env.VEILBIRD_TELEGRAM_API_ORIGIN?.trim() || "https://api.telegram.org").replace(/\/$/, "");
const APPROVAL_DAYS = 7;

export class TelegramError extends Error {
  constructor(message: string, readonly code = 0, readonly retryAfter = 0, readonly migrateTo = "") { super(scrubToken(message)); }
}

/** One Bot API call. Errors carry Telegram's description, with any token scrubbed. */
async function call<T>(token: string, method: string, body: Record<string, unknown> = {}, timeoutMs = 15_000, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${api()}/bot${token}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // Never pass the fetch error on as is: some runtimes put the URL (and so the token) in it.
    const reason = (error as { name?: string }).name === "TimeoutError" ? "timed out" : (error as { cause?: { code?: string } }).cause?.code || "network error";
    throw new TelegramError(`Telegram unreachable: ${reason}`);
  }
  const data = await response.json().catch(() => null) as { ok?: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number; migrate_to_chat_id?: number } } | null;
  if (!data?.ok) throw new TelegramError(data?.description || `HTTP ${response.status}`, data?.error_code || response.status, data?.parameters?.retry_after || 0, data?.parameters?.migrate_to_chat_id ? String(data.parameters.migrate_to_chat_id) : "");
  return data.result as T;
}

async function load(): Promise<{ row: SettingsRow | null; token: string }> {
  if (state.cache) return state.cache;
  const row = (await dbQuery<SettingsRow>("SELECT * FROM telegram_settings WHERE id = 'primary'"))[0] ?? null;
  state.cache = { row, token: row ? decryptSecret({ ciphertext: row.token_ciphertext, iv: row.token_iv, tag: row.token_tag }) : "" };
  return state.cache;
}
function forget() { state.cache = null; }

function log(level: "info" | "warning", action: string, message: string, fields: Record<string, unknown> = {}) {
  void writeOperationalLog({ component: "controller", level, action: `telegram.${action}`, message: scrubToken(message), fields });
}

/** Sends one message, waiting out one rate limit. A group upgraded to a supergroup is followed to its new id. */
async function sendTo(token: string, chatId: string, html: string, keyboard?: InlineButton[][]): Promise<{ chatId: string; messageId: number }> {
  const body = (id: string) => ({ chat_id: id, text: html, parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}) });
  try {
    const sent = await call<{ message_id: number }>(token, "sendMessage", body(chatId));
    return { chatId, messageId: sent.message_id };
  } catch (error) {
    if (!(error instanceof TelegramError)) throw error;
    if (error.migrateTo) {
      await dbExec("UPDATE telegram_chats SET chat_id = $2, kind = 'supergroup' WHERE chat_id = $1", [chatId, error.migrateTo]);
      const sent = await call<{ message_id: number }>(token, "sendMessage", body(error.migrateTo));
      return { chatId: error.migrateTo, messageId: sent.message_id };
    }
    if (error.code === 429 && error.retryAfter && error.retryAfter <= 30) {
      await new Promise((resolve) => setTimeout(resolve, error.retryAfter * 1000));
      const sent = await call<{ message_id: number }>(token, "sendMessage", body(chatId));
      return { chatId, messageId: sent.message_id };
    }
    throw error;
  }
}

async function chatsFor(event: string): Promise<ChatRow[]> {
  return dbQuery<ChatRow>("SELECT chat_id, title, kind, events FROM telegram_chats WHERE $1 = ANY(events) ORDER BY created_at", [event]);
}

/** True when a bot is set up and at least one chat receives `event`. */
export async function telegramReady(event: string): Promise<boolean> {
  const { row } = await load();
  return Boolean(row) && (await chatsFor(event)).length > 0;
}

/** A link to the default site's Console, for "open Console" lines. */
export async function consoleLink(path = ""): Promise<{ label: string; url: string } | undefined> {
  const site = (await listSites()).find((item) => item.isDefault);
  const origin = site ? siteBrand(site).consoleOrigin : "";
  return origin ? { label: "打开 Console →", url: `${origin}${path}` } : undefined;
}

/**
 * Sends `message` to every chat that receives `event`. Never throws: returns how many chats got it
 * (0 when Telegram is not set up), and logs failures to Loki.
 */
export async function notify(event: string, message: TelegramMessage): Promise<number> {
  return (await deliver(event, renderMessage(message))).length;
}

async function deliver(event: string, html: string, keyboard?: InlineButton[][]): Promise<Array<{ chatId: string; messageId: number }>> {
  try {
    const { row, token } = await load();
    if (!row) return [];
    const sent: Array<{ chatId: string; messageId: number }> = [];
    for (const chat of await chatsFor(event)) {
      try { sent.push(await sendTo(token, chat.chat_id, html, keyboard)); }
      catch (error) { log("warning", "send_failed", `Telegram message to ${chat.title} failed: ${(error as Error).message}`, { event, chat: chat.chat_id }); }
    }
    return sent;
  } catch (error) {
    log("warning", "send_failed", `Telegram ${event} message failed: ${(error as Error).message}`, { event });
    return [];
  }
}

/**
 * Asks the approvers in every chat that receives `event`. One approval per kind + target: asking again for
 * the same target does nothing while one is open. Returns false when nobody could be asked.
 */
export async function requestApproval(input: { kind: string; target: string; event: string; message: TelegramMessage; approveLabel?: string; rejectLabel?: string | null }): Promise<boolean> {
  if (!handlers.has(input.kind)) throw new Error(`No Telegram approval handler for ${input.kind}`);
  if (!await telegramReady(input.event)) return false;
  const id = randomBytes(9).toString("base64url");
  const inserted = await dbExec(`INSERT INTO telegram_approvals (id, kind, target, event, message, expires_at)
    VALUES ($1, $2, $3, $4, $5, now() + interval '${APPROVAL_DAYS} days') ON CONFLICT (kind, target) DO NOTHING`, [id, input.kind, input.target, input.event, JSON.stringify(input.message)]);
  if (!inserted) return false;
  const keyboard = approvalButtons(id, { approve: input.approveLabel || "✅ 通过", reject: input.rejectLabel === null ? undefined : input.rejectLabel || "✖️ 拒绝" });
  const sent = await deliver(input.event, renderMessage(input.message), keyboard);
  await dbExec("UPDATE telegram_approvals SET sent = $2 WHERE id = $1", [id, JSON.stringify(sent)]);
  return sent.length > 0;
}

/** Rewrites every copy of an approval message with its outcome and drops the buttons. */
async function closeMessages(row: ApprovalRow, footer: string) {
  const { row: settings, token } = await load();
  if (!settings) return;
  const html = renderMessage({ ...row.message, footer });
  for (const copy of row.sent) {
    await call(token, "editMessageText", { chat_id: copy.chatId, message_id: copy.messageId, text: html, parse_mode: "HTML", link_preview_options: { is_disabled: true } })
      .catch((error) => log("warning", "edit_failed", `Telegram approval edit failed: ${(error as Error).message}`, { approval: row.id }));
  }
}

type ApprovalRow = { id: string; kind: string; target: string; event: string; message: TelegramMessage; sent: Array<{ chatId: string; messageId: number }>; status: string; expires_at: Date };

/**
 * The same decision was made somewhere else (the Console): close the open Telegram approval for it,
 * so nobody presses a stale button. `footer` is the line shown, e.g. "已在 Console 通过".
 */
export async function settleApproval(kind: string, target: string, footer: string): Promise<void> {
  try {
    const row = (await dbQuery<ApprovalRow>("UPDATE telegram_approvals SET status = 'settled', decided_at = now() WHERE kind = $1 AND target = $2 AND status = 'pending' RETURNING *", [kind, target]))[0];
    if (row) await closeMessages(row, footer);
  } catch (error) { log("warning", "settle_failed", `Telegram approval close failed: ${(error as Error).message}`, { kind }); }
}

const clock = () => new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: process.env.TZ || "Asia/Shanghai" });

type Update = {
  update_id: number;
  message?: { message_id: number; text?: string; chat: TgChat; from?: TgUser; new_chat_members?: TgUser[] };
  my_chat_member?: { chat: TgChat; from: TgUser };
  callback_query?: { id: string; from: TgUser; data?: string; message?: { message_id: number; chat: TgChat } };
};
type TgChat = { id: number; type: ChatKind; title?: string; first_name?: string; last_name?: string; username?: string };
type TgUser = { id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string };

const chatTitle = (chat: TgChat) => chat.title || personName(chat) || String(chat.id);

async function remember(chat: TgChat, user?: TgUser) {
  await dbExec(`INSERT INTO telegram_seen (chat_id, user_id, title, kind, user_name, seen_at) VALUES ($1, $2, $3, $4, $5, now())
    ON CONFLICT (chat_id, user_id) DO UPDATE SET title = EXCLUDED.title, kind = EXCLUDED.kind, user_name = EXCLUDED.user_name, seen_at = now()`,
  [String(chat.id), user && !user.is_bot ? String(user.id) : "", chatTitle(chat), chat.type, user && !user.is_bot ? personName(user) : ""]);
  await dbExec("UPDATE telegram_chats SET title = $2 WHERE chat_id = $1 AND title <> $2", [String(chat.id), chatTitle(chat)]);
}

async function answer(token: string, id: string, text: string) {
  await call(token, "answerCallbackQuery", { callback_query_id: id, text, show_alert: true }).catch(() => undefined);
}

export async function handleUpdate(update: Update): Promise<void> {
  const { row, token } = await load();
  if (!row) return;
  if (update.message) {
    const { chat, from, text } = update.message;
    await remember(chat, from);
    const command = text?.trim().match(/^\/(start|id)(@\w+)?\b/i);
    if (command && (!command[2] || command[2].slice(1).toLowerCase() === row.bot_username.toLowerCase())) {
      const lines = [`Chat ID：<code>${escapeHtml(chat.id)}</code>`, from ? `你的 Telegram ID：<code>${escapeHtml(from.id)}</code>` : "", "在 Console → Controller → Telegram 里添加这个聊天。"].filter(Boolean);
      await call(token, "sendMessage", { chat_id: chat.id, text: lines.join("\n"), parse_mode: "HTML" }).catch(() => undefined);
    }
    return;
  }
  if (update.my_chat_member) { await remember(update.my_chat_member.chat, update.my_chat_member.from); return; }
  const query = update.callback_query;
  if (!query) return;
  const parsed = parseCallback(query.data);
  if (!parsed || !query.message) return answer(token, query.id, "这个按钮已失效。");
  const chatId = String(query.message.chat.id);
  const approver = row.approvers.find((person) => person.id === String(query.from.id));
  if (!approver) {
    log("warning", "approval_denied", `Telegram approval pressed by a non-approver`, { telegramUser: String(query.from.id), approval: parsed.id });
    return answer(token, query.id, "你不在审批人名单里，不能操作。");
  }
  const chatAllowed = (await dbQuery("SELECT 1 FROM telegram_chats WHERE chat_id = $1", [chatId])).length > 0;
  if (!chatAllowed) return answer(token, query.id, "这个聊天已从 Console 移除。");
  // Claim the approval first, so two approvers pressing at once decide it only once.
  const claimed = (await dbQuery<ApprovalRow>(`UPDATE telegram_approvals SET status = 'deciding' WHERE id = $1 AND status = 'pending' AND expires_at > now() RETURNING *`, [parsed.id]))[0];
  if (!claimed) {
    const current = (await dbQuery<{ status: string; expires_at: Date }>("SELECT status, expires_at FROM telegram_approvals WHERE id = $1", [parsed.id]))[0];
    return answer(token, query.id, !current ? "这个按钮已失效。" : current.status === "pending" ? "已过期，请在 Console 处理。" : "已经处理过了。");
  }
  const handler = handlers.get(claimed.kind);
  try {
    if (!handler) throw new Error("no handler");
    const outcome = await handler.decide(claimed.target, parsed.approve, { telegramId: approver.id, name: approver.name });
    await dbExec("UPDATE telegram_approvals SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1", [claimed.id, parsed.approve ? "approved" : "rejected", approver.id]);
    await closeMessages(claimed, `${outcome} · ${approver.name.replace(/ \(@.*\)$/, "")} · ${clock()}`);
    await answer(token, query.id, outcome);
    log("info", "approval_decided", `Telegram approval ${claimed.kind}: ${parsed.approve ? "approved" : "rejected"}`, { approval: claimed.id, kind: claimed.kind, target: claimed.target, telegramUser: approver.id });
  } catch (error) {
    await dbExec("UPDATE telegram_approvals SET status = 'pending' WHERE id = $1 AND status = 'deciding'", [claimed.id]);
    log("warning", "approval_failed", `Telegram approval ${claimed.kind} failed: ${(error as Error).message}`, { approval: claimed.id });
    await answer(token, query.id, `没有成功：${scrubToken((error as Error).message).slice(0, 150)}`);
  }
}

// ---- receiving: one long-polling loop per process, restarted when the token changes ----
export function startTelegramPolling(): void {
  state.loop?.abort();
  const controller = new AbortController();
  state.loop = controller;
  void (async () => {
    let backoff = 5_000;
    while (!controller.signal.aborted) {
      try {
        const { row, token } = await load();
        if (!row) { state.receiving = { ok: false }; return; }
        const updates = await call<Update[]>(token, "getUpdates", { offset: Number(row.update_offset) + 1 || 0, timeout: 25, allowed_updates: ["message", "callback_query", "my_chat_member"] }, 35_000, controller.signal);
        state.receiving = { ok: true, at: new Date().toISOString() };
        backoff = 5_000;
        for (const update of updates) {
          await handleUpdate(update).catch((error) => log("warning", "update_failed", `Telegram update failed: ${(error as Error).message}`));
          await dbExec("UPDATE telegram_settings SET update_offset = $1 WHERE id = 'primary' AND update_offset < $1", [update.update_id]);
          if (state.cache?.row) state.cache.row.update_offset = String(update.update_id);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        const message = (error as Error).message;
        // 409: another bot client (a webhook or a second Controller) is reading this bot's updates.
        state.receiving = { ok: false, error: message, at: new Date().toISOString() };
        log("warning", "receive_failed", `Telegram updates failed: ${message}`);
        await new Promise((resolve) => setTimeout(resolve, backoff).unref());
        backoff = Math.min(backoff * 2, 120_000);
      }
    }
  })();
}

// ---- Console ----
export type TelegramStatus = {
  bot: { username: string; name: string; updatedAt: string } | null;
  receiving: { ok: boolean; error?: string; at?: string };
  events: EventInfo[];
  chats: Array<{ chatId: string; title: string; kind: ChatKind; events: string[] }>;
  approvers: Person[];
  seen: Array<{ chatId: string; title: string; kind: ChatKind; userId: string; userName: string; seenAt: string }>;
};

export async function telegramStatus(): Promise<TelegramStatus> {
  const { row } = await load();
  const known = new Set(events.keys());
  if (!row) return { bot: null, receiving: { ok: false }, events: [...events.values()], chats: [], approvers: [], seen: [] };
  const chats = await dbQuery<ChatRow>("SELECT chat_id, title, kind, events FROM telegram_chats ORDER BY created_at");
  const seen = await dbQuery<{ chat_id: string; user_id: string; title: string; kind: ChatKind; user_name: string; seen_at: Date }>(
    "SELECT * FROM telegram_seen WHERE seen_at > now() - interval '7 days' ORDER BY seen_at DESC LIMIT 30");
  return {
    bot: { username: row.bot_username, name: row.bot_name, updatedAt: new Date(row.updated_at).toISOString() },
    receiving: state.receiving, events: [...events.values()],
    chats: chats.map((chat) => ({ chatId: chat.chat_id, title: chat.title, kind: chat.kind, events: chat.events.filter((item) => known.has(item)) })),
    approvers: row.approvers,
    seen: seen.map((item) => ({ chatId: item.chat_id, title: item.title, kind: item.kind, userId: item.user_id, userName: item.user_name, seenAt: new Date(item.seen_at).toISOString() })),
  };
}

/** Checks the token with Telegram, stores it encrypted, and (re)starts receiving. */
export async function saveTelegramToken(token: string): Promise<TelegramStatus> {
  if (!validToken(token)) throw new Error("This does not look like a bot token from @BotFather");
  const me = await call<{ id: number; username: string; first_name: string }>(token, "getMe");
  // Updates are read by polling; a webhook left by another tool would block it.
  await call(token, "deleteWebhook", { drop_pending_updates: false });
  const secret = encryptSecret(token);
  const current = (await load()).row;
  const sameBot = current?.bot_id === String(me.id);
  await dbExec(`INSERT INTO telegram_settings (id, token_ciphertext, token_iv, token_tag, bot_id, bot_username, bot_name, update_offset, approvers, updated_at)
    VALUES ('primary', $1, $2, $3, $4, $5, $6, 0, '[]', now())
    ON CONFLICT (id) DO UPDATE SET token_ciphertext = EXCLUDED.token_ciphertext, token_iv = EXCLUDED.token_iv, token_tag = EXCLUDED.token_tag,
      bot_id = EXCLUDED.bot_id, bot_username = EXCLUDED.bot_username, bot_name = EXCLUDED.bot_name, updated_at = now(),
      update_offset = CASE WHEN $7 THEN telegram_settings.update_offset ELSE 0 END`,
  [secret.ciphertext, secret.iv, secret.tag, String(me.id), me.username, me.first_name, sameBot]);
  // A different bot is not in the old chats: start over.
  if (current && !sameBot) await Promise.all([dbExec("DELETE FROM telegram_chats"), dbExec("DELETE FROM telegram_seen"), dbExec("UPDATE telegram_settings SET approvers = '[]'")]);
  forget();
  startTelegramPolling();
  return telegramStatus();
}

export async function deleteTelegram(): Promise<TelegramStatus> {
  state.loop?.abort(); state.loop = null;
  await dbExec("DELETE FROM telegram_settings"); await dbExec("DELETE FROM telegram_chats"); await dbExec("DELETE FROM telegram_seen");
  await dbExec("UPDATE telegram_approvals SET status = 'expired' WHERE status = 'pending'");
  forget(); state.receiving = { ok: false };
  return telegramStatus();
}

async function requireBot() {
  const loaded = await load();
  if (!loaded.row) throw new Error("Connect a Telegram bot first");
  return loaded;
}

/** Adds a chat the bot can see. New chats receive every event; the Console unticks what they don't want. */
export async function addTelegramChat(chatId: string): Promise<TelegramStatus> {
  if (!/^-?\d{3,20}$/.test(chatId)) throw new Error("Enter a numeric chat ID");
  const { token } = await requireBot();
  let chat: TgChat;
  try { chat = await call<TgChat>(token, "getChat", { chat_id: chatId }); }
  catch (error) { throw new Error(`The bot cannot see this chat. Add the bot to it or send it /start first. (${(error as Error).message})`); }
  await dbExec(`INSERT INTO telegram_chats (chat_id, title, kind, events) VALUES ($1, $2, $3, $4) ON CONFLICT (chat_id) DO UPDATE SET title = EXCLUDED.title, kind = EXCLUDED.kind`,
    [String(chat.id), chatTitle(chat), chat.type, [...events.keys()]]);
  return telegramStatus();
}

export async function setTelegramChatEvents(chatId: string, list: unknown): Promise<TelegramStatus> {
  const chosen = Array.isArray(list) ? [...new Set(list.filter((item): item is string => typeof item === "string" && events.has(item)))] : [];
  if (!await dbExec("UPDATE telegram_chats SET events = $2 WHERE chat_id = $1", [chatId, chosen])) throw new Error("Chat not found");
  return telegramStatus();
}

export async function removeTelegramChat(chatId: string): Promise<TelegramStatus> {
  await dbExec("DELETE FROM telegram_chats WHERE chat_id = $1", [chatId]);
  return telegramStatus();
}

/** Approvers are Telegram user ids the bot has seen (their names come from those messages). */
export async function setTelegramApprovers(ids: unknown): Promise<TelegramStatus> {
  const { row } = await requireBot();
  const wanted = Array.isArray(ids) ? [...new Set(ids.map(String).filter((id) => /^\d{3,20}$/.test(id)))].slice(0, 20) : [];
  const names = new Map<string, string>([...row!.approvers.map((person) => [person.id, person.name] as const)]);
  for (const item of await dbQuery<{ user_id: string; user_name: string }>("SELECT user_id, user_name FROM telegram_seen WHERE user_id = ANY($1)", [wanted])) names.set(item.user_id, item.user_name);
  const approvers = wanted.filter((id) => names.has(id)).map((id) => ({ id, name: names.get(id)! }));
  await dbExec("UPDATE telegram_settings SET approvers = $1 WHERE id = 'primary'", [JSON.stringify(approvers)]);
  forget();
  return telegramStatus();
}

/** Sends a test message to one chat and returns Telegram's error as is (minus any token) when it fails. */
export async function sendTelegramTest(chatId: string): Promise<void> {
  const { token } = await requireBot();
  const chat = (await dbQuery<ChatRow>("SELECT chat_id, title, kind, events FROM telegram_chats WHERE chat_id = $1", [chatId]))[0];
  if (!chat) throw new Error("Chat not found");
  const names: Record<string, string> = { alerts: "告警与恢复", signups: "注册审核", releases: "客户端发布" };
  await sendTo(token, chat.chat_id, renderMessage({ tone: "ok", title: "测试消息", lines: [chat.events.length ? `这个聊天会收到：${chat.events.map((item) => names[item] || item).join("、")}` : "这个聊天现在不接收任何消息。"] }));
}

/** Daily: forget old discoveries and close approvals nobody answered. */
export async function cleanupTelegram(): Promise<number> {
  await dbExec("DELETE FROM telegram_seen WHERE seen_at < now() - interval '30 days'");
  const expired = await dbQuery<ApprovalRow>("UPDATE telegram_approvals SET status = 'expired' WHERE status = 'pending' AND expires_at < now() RETURNING *");
  for (const row of expired) await closeMessages(row, "⌛ 已过期，请在 Console 处理");
  await dbExec("DELETE FROM telegram_approvals WHERE created_at < now() - interval '90 days'");
  return expired.length;
}
