import { t, useConsoleLanguage } from "../i18n";
import { PasswordInput } from "../../../shared/password-input";
import { type FormEvent, useEffect, useState } from "react";
import { api } from "../api";
import { useConfirm } from "../confirm-dialog";
import { useToast } from "../toast";
import { InlineNotice, type Notice, Pill } from "./shared";

type MailSettings = { provider: "aliyun" | "smtp"; host: string; port: number; username: string; fromName: string; passwordSet: boolean; updatedAt: string };

const ALIYUN_HOST = "smtpdm.aliyun.com";
const empty = { provider: "aliyun" as MailSettings["provider"], host: ALIYUN_HOST, port: "465", username: "", password: "", fromName: "TrackNothing" };

/** Outgoing mail for "forgot password". Aliyun DirectMail is the preset; any SMTP service fits the same fields. */
export function MailSettingsPanel() {
  useConsoleLanguage();
  const [settings, setSettings] = useState<MailSettings | null>(null);
  const [form, setForm] = useState(empty);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const toast = useToast();
  const confirm = useConfirm();

  function apply(next: MailSettings | null) {
    setSettings(next);
    setForm(next ? { provider: next.provider, host: next.host, port: String(next.port), username: next.username, password: "", fromName: next.fromName } : empty);
  }
  useEffect(() => { void api<{ settings: MailSettings | null }>("/api/v1/admin/mail-settings").then((result) => apply(result.settings)).catch((error: Error) => setNotice({ tone: "error", message: error.message })); }, []);

  function chooseProvider(provider: MailSettings["provider"]) {
    setForm((current) => ({ ...current, provider, ...(provider === "aliyun" ? { host: ALIYUN_HOST, port: "465" } : current.host === ALIYUN_HOST ? { host: "", port: "465" } : {}) }));
  }

  async function save(event: FormEvent) {
    event.preventDefault(); setBusy("save"); setNotice(null);
    try {
      const result = await api<{ settings: MailSettings }>("/api/v1/admin/mail-settings", { method: "PUT", body: JSON.stringify({ ...form, port: Number(form.port) }) });
      apply(result.settings); toast(t("邮件设置已保存，建议发送一封测试邮件。"));
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
    finally { setBusy(""); }
  }

  async function sendTest() {
    setBusy("test"); setNotice(null);
    try {
      const result = await api<{ to: string }>("/api/v1/admin/mail-settings/test", { method: "POST" });
      setNotice({ tone: "success", message: t("测试邮件已发送到 {0}，请检查收件箱。", [result.to]) });
    } catch (error) { setNotice({ tone: "error", message: t("发送失败：{0}", [(error as Error).message]) }); }
    finally { setBusy(""); }
  }

  async function disable() {
    if (!await confirm({ title: t("停用邮件发送"), message: t("停用后，用户忘记密码时需联系管理员获取重置链接。"), confirmLabel: t("停用"), danger: true })) return;
    setBusy("delete"); setNotice(null);
    try { await api("/api/v1/admin/mail-settings", { method: "DELETE" }); apply(null); toast(t("邮件发送已停用。")); }
    catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
    finally { setBusy(""); }
  }

  return <section className="panel">
    <div className="panel-head"><div><h2>{t("邮件发送")}</h2><p>{t("用于用户在 Portal 自助找回密码。")}</p></div><Pill value={settings ? "active" : "unset"} label={settings ? t("已启用") : t("未配置")} tone={settings ? "success" : "neutral"} /></div>
    <InlineNotice notice={notice} />
    <form className="stack-form" onSubmit={save}>
      <label>{t("服务商")}<select value={form.provider} onChange={(event) => chooseProvider(event.target.value as MailSettings["provider"])}><option value="aliyun">{t("阿里云邮件推送")}</option><option value="smtp">{t("其他 SMTP 服务")}</option></select></label>
      <div className="split-fields mail-server-fields">
        <label>{t("SMTP 服务器")}<input required value={form.host} onChange={(event) => setForm({ ...form, host: event.target.value })} placeholder="smtp.example.com" /></label>
        <label>{t("SMTP 端口")}<input required type="number" min="1" max="65535" value={form.port} onChange={(event) => setForm({ ...form, port: event.target.value })} /></label>
      </div>
      {form.provider === "aliyun" && <small>{t("海外区域请改为对应地址，例如新加坡：smtpdm-ap-southeast-1.aliyun.com。")}</small>}
      <label>{t("发信地址")}<input required type="email" value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} placeholder="no-reply@mail.example.com" /></label>
      <label>{t("发件人名称")}<input value={form.fromName} onChange={(event) => setForm({ ...form, fromName: event.target.value })} placeholder="TrackNothing" /></label>
      <label>{t("SMTP 密码")}<PasswordInput showLabel={t("显示密码")} hideLabel={t("隐藏密码")} autoComplete="new-password" required={!settings} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder={settings ? t("留空则保持不变") : ""} /></label>
      {form.provider === "aliyun" && <small>{t("在阿里云邮件推送控制台创建发信地址并设置 SMTP 密码，发信域名需完成 SPF / DKIM 验证。")}</small>}
      <div className="form-actions mail-actions">
        {settings && <button type="button" className="button ghost danger-text" disabled={Boolean(busy)} onClick={() => void disable()}>{t("停用")}</button>}
        {settings && <button type="button" className="button ghost" disabled={Boolean(busy)} onClick={() => void sendTest()}>{busy === "test" ? t("发送中…") : t("发送测试邮件")}</button>}
        <button className="button primary" disabled={Boolean(busy)}>{busy === "save" ? t("保存中…") : t("保存设置")}</button>
      </div>
    </form>
  </section>;
}
