import nodemailer, { type Transporter } from "nodemailer";
import { dbExec, dbQuery } from "./db";
import { decryptSecret, encryptSecret } from "./crypto";

// Outgoing mail is configured in Console → Controller (one row, password encrypted with the master key).
// Aliyun DirectMail and any other SMTP service work the same way: the sender address doubles as the SMTP login.
export type MailProvider = "aliyun" | "smtp";
export type MailSettings = { provider: MailProvider; host: string; port: number; username: string; fromName: string; passwordSet: boolean; updatedAt: string };

type Row = { provider: MailProvider; host: string; port: number; username: string; from_name: string; password_ciphertext: string; password_iv: string; password_tag: string; updated_at: string };

let cached: { row: Row | null; transport: Transporter | null } | null = null;

async function load(): Promise<{ row: Row | null; transport: Transporter | null }> {
  if (cached) return cached;
  const row = (await dbQuery<Row>("SELECT * FROM mail_settings WHERE id = 'primary'"))[0] ?? null;
  cached = { row, transport: row ? createTransport(row, decryptSecret({ ciphertext: row.password_ciphertext, iv: row.password_iv, tag: row.password_tag })) : null };
  return cached;
}

function createTransport(row: Pick<Row, "host" | "port" | "username">, password: string): Transporter {
  // 465 is implicit TLS; other ports (25, 80, 587) upgrade with STARTTLS when the server offers it.
  return nodemailer.createTransport({ host: row.host, port: row.port, secure: row.port === 465, auth: { user: row.username, pass: password }, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 });
}

function publicSettings(row: Row | null): MailSettings | null {
  return row ? { provider: row.provider, host: row.host, port: row.port, username: row.username, fromName: row.from_name, passwordSet: true, updatedAt: row.updated_at } : null;
}

export async function mailConfigured(): Promise<boolean> {
  return Boolean((await load()).row);
}

export async function mailSettings(): Promise<MailSettings | null> {
  return publicSettings((await load()).row);
}

/** Saves the settings; an empty password keeps the stored one. */
export async function saveMailSettings(input: { provider: MailProvider; host: string; port: number; username: string; fromName: string; password: string }): Promise<MailSettings | null> {
  const current = (await load()).row;
  const password = input.password || (current ? decryptSecret({ ciphertext: current.password_ciphertext, iv: current.password_iv, tag: current.password_tag }) : "");
  if (!password) throw new Error("SMTP password is required");
  const secret = encryptSecret(password);
  await dbExec(`INSERT INTO mail_settings (id, provider, host, port, username, from_name, password_ciphertext, password_iv, password_tag, updated_at)
    VALUES ('primary', $1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (id) DO UPDATE SET provider = EXCLUDED.provider, host = EXCLUDED.host, port = EXCLUDED.port, username = EXCLUDED.username,
      from_name = EXCLUDED.from_name, password_ciphertext = EXCLUDED.password_ciphertext, password_iv = EXCLUDED.password_iv,
      password_tag = EXCLUDED.password_tag, updated_at = EXCLUDED.updated_at`,
  [input.provider, input.host, input.port, input.username, input.fromName, secret.ciphertext, secret.iv, secret.tag, new Date().toISOString()]);
  cached = null;
  return mailSettings();
}

export async function deleteMailSettings(): Promise<void> {
  await dbExec("DELETE FROM mail_settings WHERE id = 'primary'");
  cached = null;
}

export async function sendMail(input: { to: string; subject: string; text: string }): Promise<void> {
  const { row, transport } = await load();
  if (!row || !transport) throw new Error("Email delivery is not configured");
  const name = row.from_name.replace(/["\r\n]/g, "").trim();
  await transport.sendMail({ from: name ? `"${name}" <${row.username}>` : row.username, to: input.to, subject: input.subject, text: input.text });
}

const resetMail = {
  zh: { subject: "重置 Veilbird 密码", body: (url: string) => `点击下面的链接设置新密码，1 小时内有效，只能使用一次：\n\n${url}\n\n如果不是你本人操作，忽略这封邮件即可，密码不会改变。` },
  en: { subject: "Reset your Veilbird password", body: (url: string) => `Open this link to set a new password. It works once and expires in 1 hour:\n\n${url}\n\nIf you didn't ask for this, ignore this email. Your password stays the same.` },
  ru: { subject: "Сброс пароля Veilbird", body: (url: string) => `Откройте ссылку, чтобы задать новый пароль. Она одноразовая и действует 1 час:\n\n${url}\n\nЕсли вы не запрашивали сброс, просто проигнорируйте это письмо. Пароль не изменится.` },
};

export function passwordResetMail(language: unknown, url: string): { subject: string; text: string } {
  const copy = resetMail[language === "zh" || language === "ru" ? language : "en"];
  return { subject: copy.subject, text: copy.body(url) };
}
