// Telegram text is sent with parse_mode "HTML", not Markdown: only <b> <i> <u> <s> <code> <pre> <a> <blockquote>
// <tg-spoiler> are allowed, and every literal "<", ">" and "&" must be escaped or the whole message is refused.
// Callers build messages from plain strings; this file does the escaping and keeps them under Telegram's limits.

/** Telegram's limit for a message text, counted after entities are parsed. */
export const MESSAGE_LIMIT = 4096;
/** callback_data is at most 64 bytes. */
export const CALLBACK_LIMIT = 64;

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const clip = (value: string, max: number) => value.length > max ? `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…` : value;

export type Tone = "alert" | "ok" | "info" | "approval" | "release";
const ICONS: Record<Tone, string> = { alert: "🔴", ok: "🟢", info: "ℹ️", approval: "🙋", release: "📦" };

/**
 * A notification as data. Every string is plain text: it is escaped here, never interpreted as markup.
 * `fields` are "label: value" lines, with the value in <code> when `code` is set (emails, IDs, versions).
 */
export type TelegramMessage = {
  tone?: Tone;
  title: string;
  lines?: string[];
  fields?: Array<{ label: string; value: string; code?: boolean }>;
  link?: { label: string; url: string };
  /** Appended under a blank line, e.g. the outcome of an approval. Plain text, shown in bold. */
  footer?: string;
};

function safeUrl(value: string): string | null {
  try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null; } catch { return null; }
}

/**
 * Renders a message to Telegram HTML. Plain text is clipped before escaping, so a cut never lands inside a
 * tag or an entity; the result (markup included) always fits in MESSAGE_LIMIT.
 */
export function renderMessage(message: TelegramMessage): string {
  const icon = message.tone ? `${ICONS[message.tone]} ` : "";
  const head = `${icon}<b>${escapeHtml(clip(message.title, 256))}</b>`;
  const url = message.link && safeUrl(message.link.url);
  const tail = [
    url ? `<a href="${escapeHtml(url)}">${escapeHtml(clip(message.link!.label, 64))}</a>` : "",
    message.footer ? `\n<b>${escapeHtml(clip(message.footer, 200))}</b>` : "",
  ].filter(Boolean).join("\n");
  const body: string[] = [];
  for (const field of message.fields ?? []) {
    const value = clip(field.value, 300);
    body.push(`${escapeHtml(clip(field.label, 40))}：${field.code ? `<code>${escapeHtml(value)}</code>` : escapeHtml(value)}`);
  }
  for (const line of message.lines ?? []) body.push(escapeHtml(line));
  // Room left for the body; each escaped body line is whole markup, so dropping or clipping lines stays valid.
  let room = MESSAGE_LIMIT - head.length - tail.length - 4;
  const kept: string[] = [];
  for (const line of body) {
    if (line.length + 1 <= room) { kept.push(line); room -= line.length + 1; continue; }
    // A partial last line: only plain lines (no tags) are cut, and never in the middle of an entity.
    if (!line.includes("<") && room > 20) kept.push(line.slice(0, room - 1).replace(/&[a-z]*$/, "") + "…");
    else if (room > 2) kept.push("…");
    break;
  }
  return [head, ...kept, tail].filter(Boolean).join("\n");
}

export type InlineButton = { text: string; callback_data: string };

/** Builds approve / reject buttons for an approval id. callback_data stays within 64 bytes. */
export function approvalButtons(id: string, labels: { approve: string; reject?: string }): InlineButton[][] {
  const row: InlineButton[] = [{ text: labels.approve, callback_data: `ap:${id}:y` }];
  if (labels.reject) row.push({ text: labels.reject, callback_data: `ap:${id}:n` });
  for (const button of row) if (Buffer.byteLength(button.callback_data) > CALLBACK_LIMIT) throw new Error("callback_data too long");
  return [row];
}

export function parseCallback(data: unknown): { id: string; approve: boolean } | null {
  const match = typeof data === "string" ? data.match(/^ap:([A-Za-z0-9_-]{6,40}):([yn])$/) : null;
  return match ? { id: match[1], approve: match[2] === "y" } : null;
}

/** A Telegram user as people know them: "Name (@handle)". */
export function personName(user: { first_name?: string; last_name?: string; username?: string; id?: number | string }): string {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  const handle = user.username ? `@${user.username}` : "";
  return clip(name && handle ? `${name} (${handle})` : name || handle || String(user.id ?? ""), 80);
}

/** Bot tokens look like 123456789:AA…; anything that could carry one is scrubbed before it is logged or shown. */
export const TOKEN_PATTERN = /\d{5,12}:[A-Za-z0-9_-]{30,}/g;
export function scrubToken(value: string): string {
  return value.replace(TOKEN_PATTERN, "[token]").replace(/\/bot[^/\s]+/g, "/bot[token]");
}
export function validToken(value: string): boolean {
  return /^\d{5,12}:[A-Za-z0-9_-]{30,80}$/.test(value);
}
