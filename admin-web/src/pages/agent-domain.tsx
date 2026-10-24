import { t, useConsoleLanguage } from "../i18n";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useToast } from "../toast";
import { InlineNotice, type Notice, StateDot } from "./shared";

type AgentNode = { id: string; name: string; status: string; version: string; controllerOrigin: string };
type Status = { domain: string; origin: string; source: "console" | "environment"; environmentOrigin: string; nodes: AgentNode[] };

const SHOWN = 6;

/** The one domain nodes install and heartbeat through; no site owns it, so sites can change freely. */
export function AgentDomainPanel() {
  useConsoleLanguage();
  const [status, setStatus] = useState<Status | null>(null);
  const [domain, setDomain] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const toast = useToast();

  const refresh = useCallback(() => api<Status>("/api/v1/admin/agent-domain")
    .then((result) => setStatus(result))
    .catch((error: Error) => setNotice({ tone: "error", message: error.message })), []);
  useEffect(() => { void refresh(); }, [refresh]);

  async function save(value: string, event?: FormEvent) {
    event?.preventDefault(); setBusy(true); setNotice(null);
    try {
      setStatus(await api<Status>("/api/v1/admin/agent-domain", { method: "PUT", body: JSON.stringify({ domain: value }) }));
      setDomain("");
      toast(t("Agent 域名已保存。节点会在下次心跳时自动切换。"));
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
    finally { setBusy(false); }
  }

  const waiting = status ? status.nodes.filter((node) => node.controllerOrigin !== status.origin) : [];
  const reason = (node: AgentNode) => node.status !== "online" ? t("离线")
    : !node.controllerOrigin ? t("Agent 版本较旧，升级 Agent 后自动切换")
    : t("切换中，新域名不通时每 10 分钟重试");

  return <section className="panel agent-domain"><div className="panel-head"><h2>{t("Agent 接入域名")}</h2>{status && <span className="count-badge">{status.nodes.length - waiting.length}/{status.nodes.length}</span>}</div>
    <p className="form-note">{t("所有站点共用，只用于节点安装和心跳。增删站点、更换站点域名都不影响节点。")}</p>
    <InlineNotice notice={notice} />
    {status && <dl className="site-domains">
      <div><dt>{t("当前域名")}</dt><dd><code>{status.origin}</code> <span className="muted">{status.source === "console" ? t("（在这里设置）") : t("（来自部署配置）")}</span></dd></div>
      <div><dt>{t("节点")}</dt><dd>{!status.nodes.length ? <span className="muted">{t("还没有节点")}</span>
        : !waiting.length ? <span className="site-check ok"><StateDot tone="success" />{t("全部 {0} 个节点已使用当前域名", [status.nodes.length])}</span>
        : <ul className="agent-domain-waiting">{waiting.slice(0, SHOWN).map((node) => <li key={node.id}><b>{node.name}</b><span>{reason(node)}</span></li>)}
          {waiting.length > SHOWN && <li className="muted">{t("还有 {0} 个节点", [waiting.length - SHOWN])}</li>}</ul>}</dd></div>
    </dl>}
    <form className="agent-domain-form" onSubmit={(event) => void save(domain, event)}>
      <input aria-label={t("新的 Agent 域名")} value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="agent.example.com" />
      <button className="button primary" disabled={busy || !domain.trim()}>{busy ? t("检查中…") : t("检查并保存")}</button>
      {status?.source === "console" && <button type="button" className="text-button" disabled={busy} onClick={() => void save("")}>{t("恢复部署配置")}</button>}
    </form>
    <small className="agent-domain-hint">{t("先在宝塔把新域名反向代理到 {0}，申请好证书再保存。旧域名保留到所有节点切换完成。", ["http://127.0.0.1:3000"])}</small>
  </section>;
}
