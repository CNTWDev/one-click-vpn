import { useEffect, useState } from "react";
import { api } from "../api";
import { useConfirm } from "../confirm-dialog";
import type { NodeRecord, OperationalLogLine } from "../types";
import { Empty, formatTime, InlineNotice, type Notice, PageHeader, Pill } from "./shared";

export function LogsPage({ nodes }: { nodes: NodeRecord[] }) {
  const [logs, setLogs] = useState<OperationalLogLine[]>([]);
  const [available, setAvailable] = useState(true);
  const [filters, setFilters] = useState({ nodeId: "", level: "", hours: "24" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const confirm = useConfirm();
  async function refresh() {
    setBusy(true); setNotice(null);
    try {
      const params = new URLSearchParams({ hours: filters.hours, limit: "300" });
      if (filters.nodeId) params.set("nodeId", filters.nodeId);
      if (filters.level) params.set("level", filters.level);
      const result = await api<{ logs: OperationalLogLine[]; available: boolean }>(`/api/logs?${params}`);
      setLogs(result.logs || []); setAvailable(result.available !== false);
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    void api<{ logs: OperationalLogLine[]; available: boolean }>("/api/logs?hours=24&limit=300").then((result) => {
      setLogs(result.logs || []); setAvailable(result.available !== false);
    }).catch((error: Error) => setNotice({ tone: "error", message: error.message }));
  }, []);
  async function purge() {
    const confirmation = filters.nodeId ? "PURGE NODE LOGS" : "PURGE SYSTEM LOGS";
    const typed = await confirm({
      title: `清除${filters.nodeId ? "节点" : "全部"}日志`,
      message: `这是不可逆操作。请输入 ${confirmation} 以确认删除${filters.nodeId ? "当前节点" : "全部系统"}日志。`,
      confirmLabel: "永久删除",
      danger: true,
      input: { label: "确认文本", placeholder: confirmation, required: true },
    });
    if (typed === null) return;
    try {
      await api("/api/logs/purge", { method: "POST", body: JSON.stringify({ nodeId: filters.nodeId || undefined, confirmation: typed }) });
      setNotice({ tone: "success", message: "日志删除请求已接受，物理删除由日志服务异步执行。" }); await refresh();
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
  }
  return <>
    <PageHeader eyebrow="OBSERVABILITY" title="运行日志" description="查询 Controller、Agent、部署和配置同步日志，用于定位节点故障。" />
    <InlineNotice notice={notice} />
    {!available && <InlineNotice notice={{ tone: "info", message: "运行日志存储尚未启用或当前不可用；这不会阻塞节点恢复操作。" }} />}
    <section className="log-toolbar"><label>节点<select value={filters.nodeId} onChange={(event) => setFilters({ ...filters, nodeId: event.target.value })}><option value="">全部节点 / Controller</option>{nodes.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}</select></label><label>级别<select value={filters.level} onChange={(event) => setFilters({ ...filters, level: event.target.value })}><option value="">全部级别</option><option value="info">Info</option><option value="warning">Warning</option><option value="error">Error</option></select></label><label>范围<select value={filters.hours} onChange={(event) => setFilters({ ...filters, hours: event.target.value })}><option value="1">最近 1 小时</option><option value="6">最近 6 小时</option><option value="24">最近 24 小时</option><option value="168">最近 7 天</option><option value="720">最近 30 天</option></select></label><span className="grow" /><button className="button ghost" disabled={busy} onClick={() => void refresh()}>{busy ? "查询中…" : "查询"}</button><button className="button danger" onClick={() => void purge()}>清除{filters.nodeId ? "节点" : "全部"}日志</button></section>
    <section className="panel flush log-panel">{logs.length ? <div className="log-list">{logs.map((log, index) => <article key={`${log.timestamp}:${index}`}><time>{formatTime(log.timestamp)}</time><span><Pill value={log.labels.level || "info"} /></span><span className="log-source">{log.labels.node || "controller"}<small>{log.labels.component}</small></span><p>{log.message}{log.actionId && <small>action {log.actionId}</small>}</p></article>)}</div> : <Empty>{busy ? "正在查询日志…" : "当前筛选范围内没有日志。"}</Empty>}</section>
  </>;
}
