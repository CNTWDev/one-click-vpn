import { t, useConsoleLanguage } from "../i18n";
import { useState } from "react";
import { FleetMap } from "../fleet-map";
import { Icon } from "../icons";
import { href } from "../router";
import type { AdminUser, ControllerInfo, NodeRecord, Region } from "../types";
import { Empty, PageHeader, Pill, StateDot, Time } from "./shared";

const MAP_KEY = "veilbird-console-overview-map";
function readMapOpen() { try { return window.localStorage.getItem(MAP_KEY) !== "closed"; } catch { return true; } }

export function OverviewPage({ users, nodes, regions, controllerSettings, onRefresh }: {
  users: AdminUser[]; nodes: NodeRecord[]; regions: Region[]; controllerSettings?: ControllerInfo["settings"] | null; onRefresh: () => Promise<void>;
}) {
  useConsoleLanguage();
  const [mapOpen, setMapOpen] = useState(readMapOpen);
  const pending = users.filter((user) => user.status === "pending");
  const attention = nodes.filter((node) => node.status !== "online");
  const online = nodes.length - attention.length;
  function toggleMap() {
    const next = !mapOpen; setMapOpen(next);
    try { window.localStorage.setItem(MAP_KEY, next ? "open" : "closed"); } catch { /* remembered for this tab only */ }
  }
  return <>
    <PageHeader title={t("运维总览")} description={t("从账号准入到边缘节点，集中查看当前需要处理的事项。")} actions={<button className="button ghost" onClick={() => void onRefresh()}><Icon name="refresh" size={16} />{t("刷新")}</button>} />
    <section className="metric-grid">
      <a href={href("users", { filter: "pending" })} className={pending.length ? "warn" : ""}><small>{t("待审核账号")}</small><b>{pending.length}</b><span>{t("去审核 →")}</span></a>
      <a href={href("nodes", { filter: "online" })}><small>{t("在线节点")}</small><b>{online}<em> / {nodes.length}</em></b><span>{t("查看节点 →")}</span></a>
      <a href={href("nodes", { filter: "attention" })} className={attention.length ? "danger" : ""}><small>{t("需关注节点")}</small><b>{attention.length}</b><span>{t("查看需关注节点 →")}</span></a>
      <a href={href("users", { filter: "active" })}><small>{t("已启用账号")}</small><b>{users.filter((user) => user.status === "active").length}</b><span>{t("查看账号 →")}</span></a>
    </section>
    <div className="two-column">
      <section className="panel">
        <div className="panel-head"><h2>{t("需要处理")}</h2>{pending.length + attention.length > 0 && <span className="count-badge">{pending.length + attention.length}</span>}</div>
        {!pending.length && !attention.length ? <Empty>{t("当前没有待处理事项。")}</Empty> : <div className="attention-list">
          {pending.slice(0, 5).map((user) => <a key={user.id} href={href("users", { filter: "pending", q: user.email })}><span className="attention-icon warning"><Icon name="user" size={16} /></span><span><b>{t("{0} · 等待账号审核", [user.displayName])}</b><small>{user.email} · <Time value={user.createdAt} /></small></span><em>{t("审核 →")}</em></a>)}
          {attention.slice(0, 6).map((node) => <a key={node.id} href={href("nodes", { focus: node.id })}><span className={`attention-icon ${node.status === "provisioning" ? "progress" : "danger"}`}><Icon name="nodes" size={16} /></span><span><b>{node.name}</b><small>{node.ip} · {node.last_seen}</small></span><Pill value={node.status} /><em>{t("诊断 →")}</em></a>)}
        </div>}
      </section>
      <section className="panel">
        <div className="panel-head"><h2>{t("节点状态")}</h2><a className="text-button" href={href("nodes")}>{t("全部节点 →")}</a></div>
        {nodes.length ? <div className="compact-list">{nodes.slice(0, 8).map((node) => <a key={node.id} href={href("nodes", { focus: node.id })}><StateDot value={node.status} /><span><b>{node.name}</b><small>{node.place} · {node.latency}</small></span><Pill value={node.status} /></a>)}</div> : <Empty action={<a className="button primary" href={href("nodes")}>{t("添加节点")}</a>}>{t("尚未部署节点。")}</Empty>}
      </section>
    </div>
    <section className={`overview-map ${mapOpen ? "" : "collapsed"}`}>
      <div className="overview-map-head"><button className="overview-map-toggle" aria-expanded={mapOpen} onClick={toggleMap}><Icon name="chevron" /><b>{t("全球节点分布")}</b><small>{t("区域数：{0} · 在线节点：{1}/{2}", [regions.length, online, nodes.length])}</small></button><a className="text-button" href={href("topology")}>{t("完整拓扑 →")}</a></div>
      {mapOpen && <FleetMap compact nodes={nodes} regions={regions} controller={controllerSettings} />}
    </section>
  </>;
}
