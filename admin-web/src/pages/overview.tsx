import { t, useConsoleLanguage } from "../i18n";
import { useEffect, useState } from "react";
import { api } from "../api";
import { FleetMap } from "../fleet-map";
import { Icon } from "../icons";
import { href } from "../router";
import type { AdminUser, ControllerInfo, NodeRecord, OverviewStats, Region } from "../types";
import { Empty, formatBytes, formatRate, PageHeader, Pill, StateDot, Time } from "./shared";

const MAP_KEY = "veilbird-console-overview-map";
function readMapOpen() { try { return window.localStorage.getItem(MAP_KEY) !== "closed"; } catch { return true; } }

export function OverviewPage({ pendingUsers: pending, activeUsers, nodes, regions, controllerSettings, onRefresh }: {
  pendingUsers: AdminUser[]; activeUsers: number; nodes: NodeRecord[]; regions: Region[]; controllerSettings?: ControllerInfo["settings"] | null; onRefresh: () => Promise<void>;
}) {
  useConsoleLanguage();
  const [mapOpen, setMapOpen] = useState(readMapOpen);
  const attention = nodes.filter((node) => node.status !== "online");
  const online = nodes.length - attention.length;
  const [stats, setStats] = useState<OverviewStats | null>(null);
  const loadStats = () => api<OverviewStats>("/api/v1/admin/overview-stats").then(setStats).catch(() => undefined);
  useEffect(() => { void loadStats(); }, []);
  // Month totals and live speed come from the node list (Agent 2.11+); older agents simply do not count.
  const tracked = nodes.filter((node) => node.monthlyTraffic);
  const monthTx = tracked.reduce((sum, node) => sum + node.monthlyTraffic!.txBytes, 0);
  const monthRx = tracked.reduce((sum, node) => sum + node.monthlyTraffic!.rxBytes, 0);
  const live = nodes.filter((node) => node.status === "online" && node.metrics?.network?.wanTxBytesPerSecond !== undefined);
  const rateTx = live.reduce((sum, node) => sum + (node.metrics!.network!.wanTxBytesPerSecond ?? 0), 0);
  const rateRx = live.reduce((sum, node) => sum + (node.metrics!.network!.wanRxBytesPerSecond ?? 0), 0);
  const byTraffic = [...nodes].sort((left, right) => (right.monthlyTraffic?.txBytes ?? -1) - (left.monthlyTraffic?.txBytes ?? -1)).slice(0, 6);
  const topTx = byTraffic[0]?.monthlyTraffic?.txBytes || 0;
  const expiring = stats?.expiring ?? [];
  const nearQuota = stats?.nearQuota ?? [];
  const todo = pending.length + attention.length + expiring.length + nearQuota.length;
  function toggleMap() {
    const next = !mapOpen; setMapOpen(next);
    try { window.localStorage.setItem(MAP_KEY, next ? "open" : "closed"); } catch { /* remembered for this tab only */ }
  }
  return <>
    <PageHeader title={t("运维总览")} description={t("从账号准入到边缘节点，集中查看当前需要处理的事项。")} actions={<button className="button ghost" onClick={() => { void onRefresh(); void loadStats(); }}><Icon name="refresh" size={16} />{t("刷新")}</button>} />
    <section className="metric-grid">
      <a href={href("nodes", { filter: attention.length ? "attention" : "online" })} ><small>{t("在线节点")}</small><b>{online}<em> / {nodes.length}</em></b><span className={attention.length ? "danger" : ""}>{attention.length ? t("{0} 个需关注 →", [attention.length]) : t("查看节点 →")}</span></a>
      <a href={href("users", { filter: "active" })}><small>{t("当前在线")}</small><b>{stats ? stats.online.users : "—"}</b><span>{stats ? t("{0} 台设备 · 共 {1} 个账号", [stats.online.devices, activeUsers]) : t("共 {0} 个账号", [activeUsers])}</span></a>
      <a href={href("nodes", { sort: "traffic" })} title={t("公网网卡出站流量，按 UTC 自然月累计")}><small>{t("本月流量")}</small><b>{tracked.length ? formatBytes(monthTx) : "—"}</b><span>{t("入 {0}", [formatBytes(monthRx)])}{stats?.lastMonth ? ` · ${t("上月 {0}", [formatBytes(stats.lastMonth.txBytes)])}` : ""}</span></a>
      <a href={href("nodes", { sort: "rate" })}><small>{t("当前速率")}</small><b>{live.length ? formatRate(rateTx) : "—"}</b><span>{t("入 {0} · {1} 个节点", [formatRate(rateRx), live.length])}</span></a>
    </section>
    <div className="two-column">
      <section className="panel">
        <div className="panel-head"><h2>{t("需要处理")}</h2>{todo > 0 && <span className="count-badge">{todo}</span>}</div>
        {!todo ? <Empty>{t("当前没有待处理事项。")}</Empty> : <div className="attention-list">
          {pending.slice(0, 5).map((user) => <a key={user.id} href={href("users", { filter: "pending", q: user.email })}><span className="attention-icon warning"><Icon name="user" size={16} /></span><span><b>{t("{0} · 等待账号审核", [user.displayName])}</b><small>{user.email} · <Time value={user.createdAt} /></small></span><em>{t("审核 →")}</em></a>)}
          {attention.slice(0, 6).map((node) => <a key={node.id} href={href("nodes", { focus: node.id })}><span className={`attention-icon ${node.status === "provisioning" ? "progress" : "danger"}`}><Icon name="nodes" size={16} /></span><span><b>{node.name}</b><small>{node.ip} · {node.last_seen}</small></span><Pill value={node.status} /><em>{t("诊断 →")}</em></a>)}
          {expiring.slice(0, 5).map((account) => <a key={`e-${account.userId}`} href={href("users", { q: account.email })}><span className="attention-icon warning"><Icon name="plans" size={16} /></span><span><b>{t("{0} · 即将到期", [account.displayName])}</b><small>{account.email} · <Time value={account.expiresAt} /></small></span><em>{t("续期 →")}</em></a>)}
          {nearQuota.slice(0, 5).map((account) => <a key={`q-${account.userId}`} href={href("users", { q: account.email })}><span className="attention-icon warning"><Icon name="plans" size={16} /></span><span><b>{t("{0} · 流量已用 {1}%", [account.displayName, Math.floor(account.usedBytes / account.quotaBytes * 100)])}</b><small>{account.email} · {formatBytes(account.usedBytes)} / {formatBytes(account.quotaBytes)}</small></span><em>{t("调整 →")}</em></a>)}
        </div>}
      </section>
      <section className="panel">
        <div className="panel-head"><h2>{t("节点本月流量")}</h2><a className="text-button" href={href("nodes", { sort: "traffic" })}>{t("全部节点 →")}</a></div>
        {nodes.length ? <div className="compact-list traffic-rank">{byTraffic.map((node) => <a key={node.id} href={href("nodes", { focus: node.id })}><StateDot value={node.status} /><b>{node.name}</b><em>{node.monthlyTraffic ? formatBytes(node.monthlyTraffic.txBytes) : "—"}</em><i className="rank-bar"><b style={{ width: `${topTx && node.monthlyTraffic ? Math.max(2, node.monthlyTraffic.txBytes / topTx * 100) : 0}%` }} /></i></a>)}</div> : <Empty action={<a className="button primary" href={href("nodes")}>{t("添加节点")}</a>}>{t("尚未部署节点。")}</Empty>}
      </section>
    </div>
    <section className={`overview-map ${mapOpen ? "" : "collapsed"}`}>
      <div className="overview-map-head"><button className="overview-map-toggle" aria-expanded={mapOpen} onClick={toggleMap}><Icon name="chevron" /><b>{t("全球节点分布")}</b><small>{t("区域数：{0} · 在线节点：{1}/{2}", [regions.length, online, nodes.length])}</small></button><a className="text-button" href={href("topology")}>{t("完整拓扑 →")}</a></div>
      {mapOpen && <FleetMap compact nodes={nodes} regions={regions} controller={controllerSettings} />}
    </section>
  </>;
}
