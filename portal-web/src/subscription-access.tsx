import { message, translateMessage, type LocalizedMessage } from "../../shared/i18n-core";
import { errorText } from "../../shared/i18n-errors";
import { useI18n } from "../../shared/i18n";
import { useState, type FormEvent } from "react";
import { api } from "./api";

/** Secret retrieval is owner-only, password verified and never persisted in browser storage. */
export function SubscriptionAccess({ id, disabled, onChanged }: { id: string; disabled: boolean; onChanged: () => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false), [password, setPassword] = useState("");
  const [token, setToken] = useState(""), [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [reset, setReset] = useState(false);
  const [client, setClient] = useState("hiddify"), [notice, setNotice] = useState<LocalizedMessage>("");
  const link = token ? `${window.location.origin}/api/subscription?token=${encodeURIComponent(token)}` : "";
  async function reveal(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      const result = await api<{ token: string }>("/api/v1/subscriptions", { method: "PATCH", body: JSON.stringify({ id, action: reset ? "reset-link" : "reveal-link", password }) });
      setToken(result.token); setPassword(""); setOpen(false);
      setNotice(reset ? message("链接已重置，请重新导入；已有配置仍可连接。") : message("已获取原订阅链接，不影响现有客户端。"));
      onChanged();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const importUrl = client === "hiddify" ? `hiddify://import/${link}#Northstar` : `clash://install-config?url=${encodeURIComponent(link)}&name=Northstar`;
  return <section className="connection-download subscription-access">
    <button className="primary" disabled={disabled || busy} onClick={() => { setReset(false); setOpen(true); setError(""); }}>{t("导入 / 复制链接")}</button>
    {error && <p className="error" role="alert">{errorText(error, t)}</p>}
    {notice && <p role="status">{translateMessage(notice, t)}</p>}
    {open && <form onSubmit={reveal}><h3>{reset ? t("重置订阅链接") : t("验证身份后获取链接")}</h3><p>{reset ? t("旧链接将失效，所有客户端需要重新导入。已下载的配置不会因此撤销；泄露时请撤销整个连接。") : t("链接包含访问权限，请输入当前账号的登录密码。")}</p><label>{t("登录密码")}<input type="password" autoComplete="current-password" required maxLength={1024} value={password} onChange={(e) => setPassword(e.target.value)} /></label><div className="connection-manage"><button className="primary" disabled={disabled || busy}>{busy ? t("验证中…") : reset ? t("验证并重置") : t("验证并获取")}</button><button type="button" className="secondary" disabled={busy} onClick={() => { setOpen(false); setPassword(""); }}>{t("取消")}</button></div></form>}
    {link && !disabled && <div className="download-box"><label>{t("订阅链接")}<input readOnly aria-label={t("订阅链接")} value={link} onFocus={(e) => e.target.select()} /></label><label>{t("导入客户端")}<select value={client} onChange={(e) => setClient(e.target.value)}><option value="hiddify">Hiddify</option><option value="clash">Clash Verge Rev</option></select></label><div className="connection-manage"><button className="primary" onClick={() => { void navigator.clipboard.writeText(link).then(() => setNotice(message("已复制，可粘贴到客户端的订阅入口。"))).catch(() => setError(t("无法自动复制，请手动选中链接复制。"))); }}>{t("复制链接")}</button><a className="secondary" href={importUrl}>{t("导入客户端")}</a><button className="text-link" onClick={() => setToken("")}>{t("隐藏链接")}</button></div><p>{t("请勿分享链接或上传第三方转换网站。客户端未打开时，可手动粘贴链接导入。")}</p></div>}
    <details><summary>{t("订阅链接高级操作")}</summary><button className="danger-link" disabled={disabled || busy} onClick={() => { setReset(true); setOpen(true); setError(""); setPassword(""); }}>{t("重置链接")}</button></details>
  </section>;
}
