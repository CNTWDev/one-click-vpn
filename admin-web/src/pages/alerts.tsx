import { t, useConsoleLanguage } from "../i18n";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useToast } from "../toast";
import { InlineNotice, type Notice, StateDot, Time } from "./shared";

type Kind = "node-offline" | "service" | "agent-outdated" | "disk";
type Status = { recipients: string; mailConfigured: boolean; firing: Array<{ key: string; kind: Kind; subject: string; detail: string; since: string; notified: boolean }> };
const titles: Record<Kind, string> = { "node-offline": "节点离线：{0}", service: "协议同步失败：{0}", "agent-outdated": "Agent 不是最新版：{0}", disk: "控制面磁盘已用 {0}" };

/** Email alerts: who gets them, and what is wrong right now. Checked every minute by the Controller. */
export function AlertsPanel() {
  useConsoleLanguage();
  const [status, setStatus] = useState<Status | null>(null);
  const [recipients, setRecipients] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const toast = useToast();

  const refresh = useCallback(() => api<Status>("/api/v1/admin/alerts")
    .then((result) => { setStatus({ ...result, firing: result.firing || [] }); setRecipients(result.recipients || ""); })
    .catch((error: Error) => setNotice({ tone: "error", message: error.message })), []);
  useEffect(() => { void refresh(); }, [refresh]);

  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setNotice(null);
    try {
      const result = await api<Status>("/api/v1/admin/alerts", { method: "PUT", body: JSON.stringify({ recipients }) });
      setStatus(result); setRecipients(result.recipients); toast(t("告警收件人已保存。"));
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
    finally { setBusy(false); }
  }

  return <section className="panel alerts-panel"><div className="panel-head"><h2>{t("告警")}</h2>{status && <span className="count-badge">{status.firing.length}</span>}</div>
    <p className="form-note">{t("节点离线 3 分钟、服务异常 10 分钟、磁盘超过 85%、Agent 落后一天时发邮件，恢复时再发一封。")}</p>
    <InlineNotice notice={notice} />
    {status && !status.mailConfigured && <InlineNotice notice={{ tone: "info", message: t("先在上方“邮件发送”配置发信，告警才能发出。") }} />}
    {status && (status.firing.length ? <div className="compact-list">{status.firing.map((item) => <div key={item.key}><StateDot tone="danger" /><span><b>{t(titles[item.kind], [item.subject])}</b><small>{item.kind === "service" && item.detail ? `${item.detail} · ` : ""}<Time value={item.since} />{item.notified ? "" : ` · ${t("等待发送")}`}</small></span></div>)}</div>
      : <p className="site-check ok"><StateDot tone="success" />{t("当前没有告警")}</p>)}
    <form className="stack-form" onSubmit={save}>
      <label>{t("收件人")}<input value={recipients} onChange={(event) => setRecipients(event.target.value)} placeholder="ops@example.com, me@example.com" /></label>
      <div className="form-actions"><button className="button primary" disabled={busy}>{busy ? t("保存中…") : t("保存")}</button></div>
    </form>
  </section>;
}
