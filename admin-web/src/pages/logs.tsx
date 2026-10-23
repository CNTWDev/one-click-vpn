import { t, useConsoleLanguage } from "../i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useConfirm } from "../confirm-dialog";
import { Icon } from "../icons";
import { useQueryParam } from "../router";
import { useToast } from "../toast";
import type { NodeRecord, OperationalLogLine } from "../types";
import { Empty, formatTime, InlineNotice, type Notice, PageHeader, Pill, TableToolbar } from "./shared";

export function LogsPage({ nodes }: { nodes: NodeRecord[] }) {
  useConsoleLanguage();
  const [logs, setLogs] = useState<OperationalLogLine[]>([]);
  const [available, setAvailable] = useState(true);
  const [nodeId, setNodeId] = useQueryParam("node");
  const [level, setLevel] = useQueryParam("level", "all");
  const [source, setSource] = useQueryParam("source", "all");
  const [hours, setHours] = useQueryParam("hours", "24");
  const [search, setSearch] = useQueryParam("q");
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState<Notice | null>(null);
  const confirm = useConfirm();
  const toast = useToast();
  const request = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++request.current;
    setBusy(true); setNotice(null);
    try {
      const params = new URLSearchParams({ hours, limit: "300" });
      if (nodeId) params.set("nodeId", nodeId);
      if (level !== "all") params.set("level", level);
      if (source !== "all") params.set("source", source);
      if (search.trim()) params.set("q", search.trim());
      const result = await api<{ logs: OperationalLogLine[]; available: boolean }>(`/api/logs?${params}`);
      if (id !== request.current) return;
      setLogs(result.logs || []); setAvailable(result.available !== false);
    } catch (error) { if (id === request.current) setNotice({ tone: "error", message: (error as Error).message }); }
    finally { if (id === request.current) setBusy(false); }
  }, [hours, nodeId, level, source, search]);
  // Filters apply on their own (debounced) — there is no separate "查询" step.
  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 300);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  async function purge() {
    const confirmation = nodeId ? "PURGE NODE LOGS" : "PURGE SYSTEM LOGS";
    const typed = await confirm({
      title: t("清除{0}日志", [nodeId ? t("节点") : t("全部")]),
      message: t("这是不可逆操作，将删除{0}日志。", [nodeId ? t("当前节点") : t("全部系统")]),
      confirmLabel: t("永久删除"),
      danger: true,
      confirmText: confirmation,
    });
    if (!typed) return;
    try {
      await api("/api/logs/purge", { method: "POST", body: JSON.stringify({ nodeId: nodeId || undefined, confirmation }) });
      toast(t("日志删除请求已接受，物理删除由日志服务异步执行。")); await refresh();
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
  }

  // Search runs in Loki (it also matches users, IPs and ids); the page only renders what came back.
  const shown = logs;
  const nodeName = (id?: string) => !id || id === "controller" ? "Controller" : nodes.find((node) => node.id === id)?.name || id;
  const follow = (id: string) => { setSearch(id); setLevel("all"); setSource("all"); setNodeId(""); };
  const counts = (value: string) => level === "all" || level === value ? logs.filter((log) => value === "all" || (log.labels.level || "info") === value).length : undefined;
  return <>
    <PageHeader title={t("运行日志")} description={t("记录用户关键操作和系统事件。点请求或任务 ID，可查看同一次操作的全部日志。")} actions={<><button className="button ghost" disabled={busy} onClick={() => void refresh()}><Icon name="refresh" size={16} />{busy ? t("加载中…") : t("刷新")}</button><button className="button danger" onClick={() => void purge()}>{nodeId ? t("清除节点日志") : t("清除全部日志")}</button></>} />
    <InlineNotice notice={notice} onRetry={notice?.tone === "error" ? () => void refresh() : undefined} />
    {!available && <InlineNotice notice={{ tone: "info", message: t("日志服务（Loki）当前不可用。在服务器上运行 sudo ./one-click-update.sh 可自动修复；节点恢复操作不受影响。") }} />}
    <section className="panel flush table-panel log-panel">
      <TableToolbar search={search} onSearch={setSearch} placeholder={t("搜索消息、用户、IP 或请求 ID")} chips={[["all", t("全部")], ["info", t("信息")], ["warning", t("警告")], ["error", t("错误")]].map(([value, label]) => ({ value, label, count: counts(value) }))} chip={level} onChip={setLevel}>
        <div className="log-filters"><select className="toolbar-select" aria-label={t("来源")} value={source} onChange={(event) => setSource(event.target.value)}><option value="all">{t("全部来源")}</option><option value="user">{t("用户操作")}</option><option value="system">{t("系统事件")}</option></select>
        <select className="toolbar-select" aria-label={t("节点")} value={nodeId} onChange={(event) => setNodeId(event.target.value)}><option value="">{t("全部节点 / Controller")}</option>{nodes.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}</select>
        <select className="toolbar-select" aria-label={t("时间范围")} value={hours} onChange={(event) => setHours(event.target.value)}><option value="1">{t("最近 1 小时")}</option><option value="6">{t("最近 6 小时")}</option><option value="24">{t("最近 24 小时")}</option><option value="168">{t("最近 7 天")}</option><option value="720">{t("最近 30 天")}</option></select></div>
      </TableToolbar>
      {shown.length ? <div className={`log-list ${busy ? "refreshing" : ""}`}>{shown.map((log, index) => <LogEntry key={`${log.timestamp}:${index}`} log={log} nodeName={nodeName} onFollow={follow} />)}</div>
        : busy ? <div className="skeleton-block" role="status" aria-label={t("正在查询日志")}><i /><i /><i /></div> : <Empty action={search || level !== "all" || source !== "all" || nodeId ? <button className="button ghost" onClick={() => { setSearch(""); setLevel("all"); setSource("all"); setNodeId(""); }}>{t("清除筛选")}</button> : undefined}>{t("当前筛选范围内没有日志。")}</Empty>}
    </section>
  </>;
}

const componentLabels: Record<string, string> = { controller: "Controller", bootstrap: "部署", agent: "Agent", reconcile: "配置同步", audit: "关键操作", api: "API" };

function detailText(details?: Record<string, unknown>): string {
  if (!details) return "";
  const flat = (value: unknown): string => value && typeof value === "object" ? JSON.stringify(value) : String(value);
  return Object.entries(details).map(([key, value]) => key === "metadata" && value && typeof value === "object"
    ? Object.entries(value as Record<string, unknown>).map(([inner, item]) => `${inner}=${flat(item)}`).join("  ")
    : `${key}=${flat(value)}`).join("  ");
}

/** One line: what happened, who did it (or the system), and the ids that link it to related lines. */
function LogEntry({ log, nodeName, onFollow }: { log: OperationalLogLine; nodeName: (id?: string) => string; onFollow: (id: string) => void }) {
  const component = log.labels.component || "controller";
  const target = log.target?.id && log.target.type !== "node" ? `${log.target.type || ""} ${log.target.id}`.trim() : "";
  const details = detailText(log.details);
  const user = log.actor ? log.actor.email || log.actor.id : log.labels.source === "user" ? t("未登录用户") : "";
  return <article>
    <time dateTime={log.timestamp}>{formatTime(log.timestamp)}</time>
    <span><Pill value={log.labels.level || "info"} /></span>
    <span className="log-source">{nodeName(log.labels.node)}<small>{t(componentLabels[component] || component)}</small></span>
    <div className="log-body">
      <p>{log.message}</p>
      {(user || log.ip || target || log.request || log.traceId || log.actionId) && <div className="log-meta">
        {user && <span className="log-actor">{user}</span>}
        {log.ip && <span>{log.ip}</span>}
        {target && <span>{target}</span>}
        {log.request && <span className="mono">{log.request}</span>}
        {log.traceId && <button type="button" className="log-ref" title={t("查看同一请求的全部日志")} onClick={() => onFollow(log.traceId!)}>{t("请求")} {log.traceId}</button>}
        {log.actionId && <button type="button" className="log-ref" title={t("查看同一任务的全部日志")} onClick={() => onFollow(log.actionId!)}>{t("任务")} {log.actionId.slice(0, 8)}</button>}
      </div>}
      {details && <small className="log-details">{details}</small>}
    </div>
  </article>;
}
