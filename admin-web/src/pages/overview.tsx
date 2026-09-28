import { FleetMap } from "../fleet-map";
import type { AdminUser, ControllerInfo, NodeRecord, Region } from "../types";
import { Empty, formatTime, PageHeader, Pill } from "./shared";

export function OverviewPage({ users, nodes, regions, controllerSettings, onNavigate, onRefresh }: {
  users: AdminUser[]; nodes: NodeRecord[]; regions: Region[]; controllerSettings?: ControllerInfo["settings"] | null; onNavigate: (page: string) => void; onRefresh: () => Promise<void>;
}) {
  const pending = users.filter((user) => user.status === "pending");
  const attention = nodes.filter((node) => node.status !== "online");
  return <>
    <PageHeader eyebrow="CONTROL PLANE" title="运维总览" description="从账号准入到边缘节点，集中查看当前需要处理的事项。" actions={<button className="button ghost" onClick={() => void onRefresh()}>刷新数据</button>} />
    <section className="metric-grid">
      <button onClick={() => onNavigate("users")}><small>待审核账号</small><b>{pending.length}</b><span>进入账号管理 →</span></button>
      <button onClick={() => onNavigate("nodes")}><small>在线节点</small><b>{nodes.filter((node) => node.status === "online").length}<em> / {nodes.length}</em></b><span>进入节点运维 →</span></button>
      <button onClick={() => onNavigate("services")}><small>需关注节点</small><b>{attention.length}</b><span>检查服务状态 →</span></button>
      <button onClick={() => onNavigate("logs")}><small>当前用户</small><b>{users.filter((user) => user.status === "active").length}</b><span>查看运行日志 →</span></button>
    </section>
    <FleetMap nodes={nodes} regions={regions} controller={controllerSettings} onNavigate={onNavigate} />
    <div className="two-column">
      <section className="panel">
        <div className="panel-head"><div><p className="eyebrow">ATTENTION</p><h2>需要处理</h2></div></div>
        {!pending.length && !attention.length ? <Empty>当前没有待处理事项。</Empty> : <div className="attention-list">
          {pending.slice(0, 5).map((user) => <button key={user.id} onClick={() => onNavigate("users")}><span className="attention-icon">U</span><span><b>{user.displayName} 等待账号审核</b><small>{user.email} · {formatTime(user.createdAt)}</small></span><em>审核</em></button>)}
          {attention.slice(0, 6).map((node) => <button key={node.id} onClick={() => onNavigate("nodes")}><span className="attention-icon node">N</span><span><b>{node.name} 状态为 {node.status}</b><small>{node.ip} · {node.last_seen}</small></span><em>诊断</em></button>)}
        </div>}
      </section>
      <section className="panel">
        <div className="panel-head"><div><p className="eyebrow">FLEET</p><h2>节点状态</h2></div><button className="text-button" onClick={() => onNavigate("nodes")}>全部节点</button></div>
        {nodes.length ? <div className="compact-list">{nodes.slice(0, 8).map((node) => <div key={node.id}><span className={`state-dot ${node.status}`} /><span><b>{node.name}</b><small>{node.place} · {node.latency}</small></span><Pill value={node.status} /></div>)}</div> : <Empty>尚未部署节点。</Empty>}
      </section>
    </div>
  </>;
}
