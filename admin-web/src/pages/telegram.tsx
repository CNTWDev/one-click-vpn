import { t, useConsoleLanguage } from "../i18n";
import { PasswordInput } from "../../../shared/password-input";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useConfirm } from "../confirm-dialog";
import { useToast } from "../toast";
import { InlineNotice, type Notice, Pill, Time } from "./shared";
import "./telegram.css";

type ChatKind = "private" | "group" | "supergroup" | "channel";
type Chat = { chatId: string; title: string; kind: ChatKind; events: string[] };
type Seen = { chatId: string; title: string; kind: ChatKind; userId: string; userName: string; seenAt: string };
type Person = { id: string; name: string };
type EventInfo = { key: string; approval: boolean };
type Status = {
  bot: { username: string; name: string; updatedAt: string } | null;
  receiving: { ok: boolean; error?: string; at?: string };
  events: EventInfo[];
  chats: Chat[];
  approvers: Person[];
  seen: Seen[];
};

// Event names live with the Controller's notifier; the Console only translates the ones it knows.
const EVENT_LABELS: Record<string, string> = { alerts: "告警与恢复", signups: "注册审核", releases: "客户端发布" };
const KIND_LABELS: Record<ChatKind, string> = { private: "私聊", group: "群组", supergroup: "群组", channel: "频道" };
const ENDPOINT = "/api/v1/admin/telegram";
// An older Controller (or a partial answer) must not break the page: fill in what is missing.
const normalize = (value: Partial<Status> | null | undefined): Status => ({
  bot: value?.bot ?? null, receiving: value?.receiving ?? { ok: false }, events: value?.events ?? [],
  chats: value?.chats ?? [], approvers: value?.approvers ?? [], seen: value?.seen ?? [],
});

/** Telegram: one bot, the chats it posts to and what each chat receives, and who may press approve / reject. */
export function TelegramPanel() {
  useConsoleLanguage();
  const [status, setStatus] = useState<Status | null>(null);
  const [token, setToken] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [manualId, setManualId] = useState("");
  const [manual, setManual] = useState(false);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const toast = useToast();
  const confirm = useConfirm();

  const refresh = useCallback(() => api<Status>(ENDPOINT).then((next) => setStatus(normalize(next))).catch((error: Error) => setNotice({ tone: "error", message: error.message })), []);
  useEffect(() => {
    void refresh();
    // New chats show up when someone sends /start to the bot; look again while the page is open.
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 10_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function run(key: string, action: () => Promise<Status | void>, done?: string) {
    setBusy(key); setNotice(null);
    try { const next = await action(); if (next) setStatus(normalize(next)); if (done) toast(done); }
    catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
    finally { setBusy(""); }
  }
  const send = (path: string, method: string, body?: unknown) => api<Status>(`${ENDPOINT}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });

  function connect(event: FormEvent) {
    event.preventDefault();
    void run("token", async () => { const next = await send("", "PUT", { token: token.trim() }); setToken(""); setReplacing(false); return next; }, t("机器人已连接。"));
  }
  async function disable() {
    if (!await confirm({ title: t("停用 Telegram"), message: t("停用后不再发送 Telegram 消息，已添加的聊天和审批人会一并清除。"), confirmLabel: t("停用"), danger: true })) return;
    void run("disable", () => send("", "DELETE"), t("Telegram 已停用。"));
  }
  const toggleEvent = (chat: Chat, key: string) => run(`event:${chat.chatId}:${key}`, () => send("/chats", "PUT", {
    chatId: chat.chatId, events: chat.events.includes(key) ? chat.events.filter((item) => item !== key) : [...chat.events, key],
  }));
  const addChat = (chatId: string) => run(`add:${chatId}`, async () => { const next = await send("/chats", "POST", { chatId }); setManualId(""); setManual(false); return next; });
  async function removeChat(chat: Chat) {
    if (!await confirm({ title: t("移除聊天"), message: t("「{0}」将不再收到任何消息。", [chat.title]), confirmLabel: t("移除"), danger: true })) return;
    void run(`remove:${chat.chatId}`, () => send("/chats", "DELETE", { chatId: chat.chatId }));
  }
  const test = (chat: Chat) => run(`test:${chat.chatId}`, async () => { await send("/test", "POST", { chatId: chat.chatId }); }, t("测试消息已发送到「{0}」。", [chat.title]));
  const setApprovers = (list: Person[]) => run("approvers", () => send("/approvers", "PUT", { approvers: list.map((item) => item.id) }));

  if (!status) return <section className="panel telegram-panel"><div className="panel-head"><h2>Telegram</h2></div><InlineNotice notice={notice} /></section>;

  const bot = status.bot;
  const added = new Set(status.chats.map((chat) => chat.chatId));
  const newChats = [...new Map(status.seen.filter((item) => !added.has(item.chatId)).map((item) => [item.chatId, item])).values()];
  const approverIds = new Set(status.approvers.map((item) => item.id));
  const candidates = [...new Map(status.seen.filter((item) => item.userId && !approverIds.has(item.userId)).map((item) => [item.userId, { id: item.userId, name: item.userName }])).values()];
  const approvalEvents = status.events.filter((item) => item.approval).map((item) => t(EVENT_LABELS[item.key] || item.key));

  return <section className="panel telegram-panel">
    <div className="panel-head">
      <div><h2>Telegram</h2><p>{t("告警、审核和发布消息统一发到 Telegram，审核直接在消息里点按钮。")}</p></div>
      <Pill value={bot ? "active" : "unset"} label={bot ? t("已连接") : t("未配置")} tone={bot ? "success" : "neutral"} />
    </div>
    <InlineNotice notice={notice} />

    {(!bot || replacing) ? <form className="tg-connect" onSubmit={connect}>
      {!bot && <ol className="tg-steps">
        <li>{t("在 Telegram 打开 @BotFather，发送 /newbot 创建机器人。")}</li>
        <li>{t("把它给你的 Token 粘贴到下面。")}</li>
      </ol>}
      <label>{t("机器人 Token")}<PasswordInput showLabel={t("显示 Token")} hideLabel={t("隐藏 Token")} autoComplete="off" required value={token} onChange={(event) => setToken(event.target.value)} placeholder="123456789:AA…" /></label>
      <div className="form-actions">
        {replacing && <button type="button" className="button tg-soft" disabled={Boolean(busy)} onClick={() => { setReplacing(false); setToken(""); }}>{t("取消")}</button>}
        <button className="button primary" disabled={Boolean(busy) || !token.trim()}>{busy === "token" ? t("连接中…") : t("连接")}</button>
      </div>
    </form> : <div className="tg-bot">
      <span className="tg-avatar" aria-hidden="true">{(bot.name || bot.username).slice(0, 1).toUpperCase()}</span>
      <span className="tg-bot-text"><b>@{bot.username}</b><small>{status.receiving.ok ? t("正在接收按钮和 /start") : t("暂时收不到消息：{0}", [status.receiving.error || "—"])}</small></span>
      <span className="tg-bot-actions">
        <button type="button" className="button small tg-soft" disabled={Boolean(busy)} onClick={() => setReplacing(true)}>{t("更换 Token")}</button>
        <button type="button" className="button small tg-soft danger-text" disabled={Boolean(busy)} onClick={() => void disable()}>{t("停用")}</button>
      </span>
    </div>}

    {bot && <>
      <h3 className="tg-heading">{t("接收消息的聊天")}</h3>
      {status.chats.length ? <div className="tg-chats">{status.chats.map((chat) => <div className="tg-chat" key={chat.chatId}>
        <div className="tg-chat-head">
          <span className="tg-chat-name"><b>{chat.title}</b><small>{t(KIND_LABELS[chat.kind])} · {chat.chatId}</small></span>
          <span className="tg-chat-actions">
            <button type="button" className="button small tg-soft" disabled={Boolean(busy)} onClick={() => void test(chat)}>{busy === `test:${chat.chatId}` ? t("发送中…") : t("发送测试")}</button>
            <button type="button" className="button small tg-text danger-text" disabled={Boolean(busy)} onClick={() => void removeChat(chat)}>{t("移除")}</button>
          </span>
        </div>
        <div className="tg-events" role="group" aria-label={t("这个聊天接收")}>{status.events.map((item) => {
          const on = chat.events.includes(item.key);
          return <button type="button" key={item.key} className={on ? "on" : ""} aria-pressed={on} disabled={busy === `event:${chat.chatId}:${item.key}`} onClick={() => void toggleEvent(chat, item.key)}>{t(EVENT_LABELS[item.key] || item.key)}</button>;
        })}</div>
      </div>)}</div> : <p className="tg-empty">{t("还没有聊天。")}</p>}

      <div className="tg-add">
        <p>{t("把机器人拉进群，或私聊它发送 /start，聊天会出现在这里。")}</p>
        {newChats.map((item) => <div className="tg-row" key={item.chatId}>
          <span className="tg-chat-name"><b>{item.title}</b><small>{t(KIND_LABELS[item.kind])} · <Time value={item.seenAt} /></small></span>
          <button type="button" className="button small primary" disabled={Boolean(busy)} onClick={() => void addChat(item.chatId)}>{t("添加")}</button>
        </div>)}
        {manual ? <form className="tg-manual" onSubmit={(event) => { event.preventDefault(); void addChat(manualId.trim()); }}>
          <input aria-label="Chat ID" value={manualId} onChange={(event) => setManualId(event.target.value)} placeholder="-1001234567890" inputMode="numeric" />
          <button className="button small primary" disabled={Boolean(busy) || !/^-?\d{3,20}$/.test(manualId.trim())}>{t("添加")}</button>
        </form> : <button type="button" className="tg-link" onClick={() => setManual(true)}>{t("手动输入 Chat ID")}</button>}
      </div>

      <h3 className="tg-heading">{t("审批人")}</h3>
      <p className="tg-note">{approvalEvents.length ? t("只有这些 Telegram 账号能在「{0}」消息里点通过或拒绝。", [approvalEvents.join(" / ")]) : t("只有这些 Telegram 账号能在消息里点通过或拒绝。")}</p>
      <div className="tg-people">
        {status.approvers.map((person) => <span className="tg-person" key={person.id}>{person.name}<button type="button" aria-label={t("移除 {0}", [person.name])} disabled={Boolean(busy)} onClick={() => void setApprovers(status.approvers.filter((item) => item.id !== person.id))}>×</button></span>)}
        {candidates.map((person) => <button type="button" className="tg-person add" key={person.id} disabled={Boolean(busy)} onClick={() => void setApprovers([...status.approvers, person])}>+ {person.name}</button>)}
        {!status.approvers.length && !candidates.length && <span className="tg-empty">{t("私聊机器人发送 /start 后，你的账号会出现在这里。")}</span>}
      </div>
    </>}
  </section>;
}
