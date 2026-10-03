import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useConfirm } from "../confirm-dialog";
import { Icon } from "../icons";
import { useQueryParam } from "../router";
import { useToast } from "../toast";
import type { NodeRecord, OperationalLogLine } from "../types";
import { Empty, formatTime, includesText, InlineNotice, type Notice, PageHeader, Pill, TableToolbar } from "./shared";

export function LogsPage({ nodes }: { nodes: NodeRecord[] }) {
  const [logs, setLogs] = useState<OperationalLogLine[]>([]);
  const [available, setAvailable] = useState(true);
  const [nodeId, setNodeId] = useQueryParam("node");
  const [level, setLevel] = useQueryParam("level", "all");
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
      const result = await api<{ logs: OperationalLogLine[]; available: boolean }>(`/api/logs?${params}`);
      if (id !== request.current) return;
      setLogs(result.logs || []); setAvailable(result.available !== false);
    } catch (error) { if (id === request.current) setNotice({ tone: "error", message: (error as Error).message }); }
    finally { if (id === request.current) setBusy(false); }
  }, [hours, nodeId, level]);
  // Filters apply on their own (debounced) — there is no separate "查询" step.
  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 300);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  async function purge() {
    const confirmation = nodeId ? "PURGE NODE LOGS" : "PURGE SYSTEM LOGS";
    const typed = await confirm({
      title: `清除${nodeId ? "节点" : "全部"}日志`,
      message: `这是不可逆操作，将删除${nodeId ? "当前节点" : "全部系统"}日志。`,
      confirmLabel: "永久删除",
      danger: true,
      confirmText: confirmation,
    });
    if (!typed) return;
    try {
      await api("/api/logs/purge", { method: "POST", body: JSON.stringify({ nodeId: nodeId || undefined, confirmation }) });
      toast("日志删除请求已接受，物理删除由日志服务异步执行。"); await refresh();
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
  }

  const shown = logs.filter((log) => includesText(search, log.message, log.labels.node, log.labels.component, log.actionId));
  const counts = (value: string) => level === "all" || level === value ? logs.filter((log) => value === "all" || (log.labels.level || "info") === value).length : undefined;
  return <>
    <PageHeader title="运行日志" description="查询 Controller、Agent、部署和配置同步日志，用于定位节点故障。" actions={<><button className="button ghost" disabled={busy} onClick={() => void refresh()}><Icon name="refresh" size={16} />{busy ? "加载中…" : "刷新"}</button><button className="button danger" onClick={() => void purge()}>清除{nodeId ? "节点" : "全部"}日志</button></>} />
    <InlineNotice notice={notice} onRetry={notice?.tone === "error" ? () => void refresh() : undefined} />
    {!available && <InlineNotice notice={{ tone: "info", message: "运行日志存储尚未启用或当前不可用；这不会阻塞节点恢复操作。" }} />}
    <section className="panel flush table-panel log-panel">
      <TableToolbar search={search} onSearch={setSearch} placeholder="搜索消息、节点或 action ID" chips={[["all", "全部"], ["info", "信息"], ["warning", "警告"], ["error", "错误"]].map(([value, label]) => ({ value, label, count: counts(value) }))} chip={level} onChip={setLevel}>
        <select className="toolbar-select" aria-label="节点" value={nodeId} onChange={(event) => setNodeId(event.target.value)}><option value="">全部节点 / Controller</option>{nodes.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}</select>
        <select className="toolbar-select" aria-label="时间范围" value={hours} onChange={(event) => setHours(event.target.value)}><option value="1">最近 1 小时</option><option value="6">最近 6 小时</option><option value="24">最近 24 小时</option><option value="168">最近 7 天</option><option value="720">最近 30 天</option></select>
      </TableToolbar>
      {shown.length ? <div className={`log-list ${busy ? "refreshing" : ""}`}>{shown.map((log, index) => <article key={`${log.timestamp}:${index}`}><time dateTime={log.timestamp}>{formatTime(log.timestamp)}</time><span><Pill value={log.labels.level || "info"} /></span><span className="log-source">{log.labels.node || "controller"}<small>{log.labels.component}</small></span><p>{log.message}{log.actionId && <small>action {log.actionId}</small>}</p></article>)}</div>
        : busy ? <div className="skeleton-block" role="status" aria-label="正在查询日志"><i /><i /><i /></div> : <Empty action={search || level !== "all" || nodeId ? <button className="button ghost" onClick={() => { setSearch(""); setLevel("all"); setNodeId(""); }}>清除筛选</button> : undefined}>当前筛选范围内没有日志。</Empty>}
    </section>
  </>;
}
