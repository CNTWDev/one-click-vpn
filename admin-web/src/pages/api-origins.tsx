import { t, useConsoleLanguage } from "../i18n";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useToast } from "../toast";
import { InlineNotice, type Notice } from "./shared";

type Status = { backupDomains: string[]; origins: string[] };

/** Extra API hostnames for the apps: they try every site's API domain, then these, when one is blocked. */
export function BackupApiPanel() {
  useConsoleLanguage();
  const [status, setStatus] = useState<Status | null>(null);
  const [domains, setDomains] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const toast = useToast();

  const refresh = useCallback(() => api<Status>("/api/v1/admin/api-origins")
    .then((result) => { setStatus({ backupDomains: result.backupDomains || [], origins: result.origins || [] }); setDomains((result.backupDomains || []).join("\n")); })
    .catch((error: Error) => setNotice({ tone: "error", message: error.message })), []);
  useEffect(() => { void refresh(); }, [refresh]);

  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setNotice(null);
    try {
      const result = await api<Status>("/api/v1/admin/api-origins", { method: "PUT", body: JSON.stringify({ domains }) });
      setStatus(result); setDomains(result.backupDomains.join("\n"));
      toast(t("备用 API 域名已保存。App 下次请求时拿到新列表。"));
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
    finally { setBusy(false); }
  }

  return <section className="panel agent-domain"><div className="panel-head"><h2>{t("App 备用入口")}</h2>{status && <span className="count-badge">{status.origins.length}</span>}</div>
    <p className="form-note">{t("App 连不上自己的 API 域名时，会依次尝试所有站点的 API 域名和下面的备用域名，并记住能用的地址。")}</p>
    <InlineNotice notice={notice} />
    {status && <dl className="site-domains"><div><dt>{t("App 会尝试")}</dt><dd><ul className="agent-domain-waiting">{status.origins.map((origin) => <li key={origin}><code>{origin}</code></li>)}</ul></dd></div></dl>}
    <form className="stack-form" onSubmit={save}>
      <label>{t("备用 API 域名")}<textarea rows={3} value={domains} onChange={(event) => setDomains(event.target.value)} placeholder={"api2.example.net\napi.example.org"} /></label>
      <div className="form-actions"><button className="button primary" disabled={busy}>{busy ? t("检查中…") : t("检查并保存")}</button></div>
    </form>
    <small className="agent-domain-hint">{t("每行一个，最多 8 个。先在宝塔把域名反向代理到 {0} 并申请证书，保存时会逐个检查。", ["http://127.0.0.1:3000"])}</small>
  </section>;
}
