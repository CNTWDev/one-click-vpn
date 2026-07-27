import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { FleetMap } from "./fleet-map";
import { countryName, countryOptions, presetGroups, regionPresets } from "./region-catalog";
import type {
  AdminUser, ControllerInfo, CredentialUsage, DeploymentPolicyOverview, NodeDiagnostics, NodeRecord,
  OperationalLogLine, Region, VpnService,
} from "./types";

export type Notice = { tone: "success" | "error" | "info"; message: string };

export function formatTime(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function actionLabel(value: string): string {
  return ({ bootstrap: "安装 / 修复 Agent", "status-agent": "检查 Agent", "restart-agent": "重启 Agent" } as Record<string, string>)[value] || value.replaceAll("-", " ");
}

function phaseLabel(value?: string): string {
  if (!value) return "等待开始";
  return value.replaceAll("-", " ").replaceAll("_", " ");
}

function formatBytes(value?: number): string {
  if (!value || value < 1) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const power = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** power).toFixed(power > 1 ? 1 : 0)} ${units[power]}`;
}

function PageHeader({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: ReactNode }) {
  return <div className="page-head">
    <div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>
    {actions && <div className="page-actions">{actions}</div>}
  </div>;
}

function Pill({ value }: { value: string }) {
  return <span className={`pill ${value.toLowerCase().replaceAll("_", "-")}`}>{value}</span>;
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

function Modal({ title, description, onClose, children, wide = false }: { title: string; description?: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener("keydown", closeOnEscape); };
  }, [onClose]);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal-head"><div><h2>{title}</h2>{description && <p>{description}</p>}</div><button className="icon-button" onClick={onClose} aria-label="关闭">×</button></div>
      {children}
    </section>
  </div>;
}

function InlineNotice({ notice }: { notice: Notice | null }) {
  return notice ? <div className={`inline-notice ${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>{notice.message}</div> : null;
}

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

export function TopologyPage({ nodes, regions, controllerSettings, onNavigate, onRefresh }: {
  nodes: NodeRecord[]; regions: Region[]; controllerSettings?: ControllerInfo["settings"] | null; onNavigate: (page: string) => void; onRefresh: () => Promise<void>;
}) {
  return <>
    <PageHeader
      eyebrow="GLOBAL FABRIC"
      title="全球拓扑"
      description="查看 Controller 与各区域 Agent 的管理通道、节点状态和全球覆盖空白。"
      actions={<button className="button ghost" onClick={() => void onRefresh()}>刷新拓扑</button>}
    />
    <FleetMap nodes={nodes} regions={regions} controller={controllerSettings} onNavigate={onNavigate} />
    <section className="topology-notes">
      <article><span>C</span><div><b>Controller 控制面</b><small>统一下发部署、修复、配置同步和诊断任务。</small></div></article>
      <article><span>A</span><div><b>Agent 管理通道</b><small>连线表示 Controller 与节点 Agent 的控制关系，不暴露用户流量。</small></div></article>
      <article><span>E</span><div><b>Edge Node 独立承载</b><small>当前不是节点间 Mesh；VPN 用户连接由所选区域节点独立处理。</small></div></article>
    </section>
  </>;
}

export function UsersPage({ users, onRefresh }: { users: AdminUser[]; onRefresh: () => Promise<void> }) {
  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [credentialOwner, setCredentialOwner] = useState<AdminUser | null>(null);
  const [credentials, setCredentials] = useState<CredentialUsage[]>([]);
  const [credentialsBusy, setCredentialsBusy] = useState(false);
  const visible = filter === "all" ? users : users.filter((user) => user.status === filter);
  const pending = users.filter((user) => user.status === "pending");

  async function update(user: AdminUser, status: "active" | "rejected" | "suspended") {
    let reason = "";
    if (status === "rejected") {
      const input = window.prompt(`拒绝 ${user.email} 的原因（可留空）`, "");
      if (input === null) return;
      reason = input;
    }
    if (status === "suspended" && !window.confirm(`确定停用 ${user.email} 吗？该账号将无法继续获取 VPN 配置。`)) return;
    setBusy(user.id); setNotice(null);
    try {
      await api(`/api/v1/admin/users/${user.id}/status`, { method: "POST", body: JSON.stringify({ status, reason }) });
      setNotice({ tone: "success", message: status === "active" ? "账号已启用。" : status === "rejected" ? "申请已拒绝。" : "账号已停用。" });
      await onRefresh();
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
    finally { setBusy(""); }
  }

  async function openCredentials(user: AdminUser) {
    setCredentialOwner(user); setCredentials([]); setCredentialsBusy(true);
    try {
      const result = await api<{ credentials: CredentialUsage[] }>(`/api/v1/admin/users/${user.id}/credentials`);
      setCredentials(result.credentials || []);
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); setCredentialOwner(null); }
    finally { setCredentialsBusy(false); }
  }

  return <>
    <PageHeader eyebrow="ACCESS CONTROL" title="账号管理" description="审核新账号，并管理现有用户的访问状态。" actions={<button className="button ghost" onClick={() => void onRefresh()}>刷新</button>} />
    <InlineNotice notice={notice} />
    <section className="panel review-panel">
      <div className="panel-head"><div><p className="eyebrow">PENDING REVIEW</p><h2>待审核账号 <span>{pending.length}</span></h2></div></div>
      {pending.length ? <div className="review-list">{pending.map((user) => <div key={user.id}>
        <span className="avatar">{user.displayName.slice(0, 1).toUpperCase()}</span>
        <span className="grow"><b>{user.displayName}</b><small>{user.email}</small><small>申请于 {formatTime(user.createdAt)}</small></span>
        <span className="row-actions"><button className="button primary small" disabled={busy === user.id} onClick={() => void update(user, "active")}>通过</button><button className="button danger small" disabled={busy === user.id} onClick={() => void update(user, "rejected")}>拒绝</button></span>
      </div>)}</div> : <Empty>目前没有待审核账号。</Empty>}
    </section>
    <section className="panel">
      <div className="panel-head"><div><p className="eyebrow">USER DIRECTORY</p><h2>全部账号</h2></div><select value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">全部状态</option><option value="active">已启用</option><option value="pending">待审核</option><option value="suspended">已停用</option><option value="rejected">已拒绝</option></select></div>
      <div className="table-wrap"><table className="action-table"><thead><tr><th>用户</th><th>角色</th><th>状态</th><th>注册时间</th><th className="align-right">操作</th></tr></thead><tbody>{visible.map((user) => <tr key={user.id}>
        <td><b>{user.displayName}</b><small>{user.email}</small></td><td>{user.role}</td><td><Pill value={user.status} />{user.rejectionReason && <small>{user.rejectionReason}</small>}</td><td>{formatTime(user.createdAt)}</td><td className="align-right"><button className="text-button" onClick={() => void openCredentials(user)}>凭据 / 流量</button>{user.role !== "owner" && user.status === "active" && <button className="text-button danger-text" disabled={busy === user.id} onClick={() => void update(user, "suspended")}>停用</button>}{user.status === "suspended" && <button className="text-button" disabled={busy === user.id} onClick={() => void update(user, "active")}>恢复</button>}</td>
      </tr>)}</tbody></table></div>
    </section>
    {credentialOwner && <Modal title={`${credentialOwner.displayName} 的 VPN 凭据`} description="查看每份配置当前是否活跃，以及最近 30 天累计流量。" onClose={() => setCredentialOwner(null)} wide>
      {credentialsBusy ? <Empty>正在读取凭据使用情况…</Empty> : credentials.length ? <div className="credential-usage-list">{credentials.map((item) => <article key={item.profileId}>
        <span className={`credential-live ${item.online ? "online" : ""}`} />
        <span className="credential-protocol">{item.protocol === "wireguard" ? "WG" : "OV"}</span>
        <div><b>{item.displayName} · {item.regionCode || "—"} {item.regionName}</b><small>{item.online ? "正在使用" : item.lastActivityAt ? `最后活动 ${formatTime(item.lastActivityAt)}` : "尚未使用"} · 凭据 …{item.credentialSuffix || "—"}</small></div>
        <span className="credential-traffic"><b>{formatBytes(item.totalBytes)}</b><small>30 天流量</small></span>
      </article>)}</div> : <Empty>该账号还没有可用 VPN 凭据。</Empty>}
    </Modal>}
  </>;
}

type NodeForm = {
  name: string; ip: string; regionId: string; sshUser: string; sshPort: string; secret: string;
  credentialType: "password" | "private_key"; hostFingerprint: string; deploymentTemplate: string;
};

const blankNodeForm: NodeForm = { name: "", ip: "", regionId: "", sshUser: "root", sshPort: "22", secret: "", credentialType: "password", hostFingerprint: "", deploymentTemplate: "standard" };
const localFingerprintCommand = "sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256";

export function NodesPage({ nodes, regions, onRefresh }: { nodes: NodeRecord[]; regions: Region[]; onRefresh: () => Promise<void> }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [form, setForm] = useState<NodeForm>(blankNodeForm);
  const [editing, setEditing] = useState<NodeRecord | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [operationNode, setOperationNode] = useState<NodeRecord | null>(null);
  const [diagnosticNode, setDiagnosticNode] = useState<NodeRecord | null>(null);
  const [diagnostics, setDiagnostics] = useState<NodeDiagnostics | null>(null);
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false);
  const [showFingerprintGuide, setShowFingerprintGuide] = useState(true);
  const [copiedFingerprintCommand, setCopiedFingerprintCommand] = useState<"local" | "remote" | "">("");

  function openCreate() {
    setEditing(null); setForm({ ...blankNodeForm, regionId: regions[0]?.id || "" }); setShowFingerprintGuide(true); setCopiedFingerprintCommand(""); setShowForm(true);
  }

  function openEdit(node: NodeRecord) {
    setEditing(node);
    setForm({ name: node.name, ip: node.ip, regionId: node.region_id || "", sshUser: node.ssh_user || "root", sshPort: String(node.ssh_port || 22), secret: "", credentialType: "password", hostFingerprint: node.host_fingerprint || "", deploymentTemplate: node.deployment_policy || "standard" });
    setShowFingerprintGuide(false); setCopiedFingerprintCommand(""); setShowForm(true);
  }

  const safeFingerprintHost = /^[A-Za-z0-9.-]+$/.test(form.ip.trim()) ? form.ip.trim() : "";
  const safeFingerprintPort = /^\d{1,5}$/.test(form.sshPort) && Number(form.sshPort) >= 1 && Number(form.sshPort) <= 65535 ? form.sshPort : "22";
  const remoteFingerprintCommand = safeFingerprintHost ? `ssh-keyscan -p ${safeFingerprintPort} -t ed25519 ${safeFingerprintHost} 2>/dev/null | ssh-keygen -lf - -E sha256` : "";

  async function copyFingerprintCommand(kind: "local" | "remote", command: string) {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopiedFingerprintCommand(kind);
      window.setTimeout(() => setCopiedFingerprintCommand(""), 1_800);
    } catch {
      setNotice({ tone: "error", message: "浏览器无法访问剪贴板，请手动选中命令复制。" });
    }
  }

  async function saveNode(event: FormEvent) {
    event.preventDefault(); setBusy("save-node"); setNotice(null);
    try {
      await api(editing ? `/api/nodes/${editing.id}` : "/api/nodes", {
        method: editing ? "PATCH" : "POST",
        body: JSON.stringify({ ...form, sshPort: Number(form.sshPort) }),
      });
      setShowForm(false); setNotice({ tone: "success", message: editing ? "节点配置已保存。" : "节点已创建，安全部署任务已加入队列。" });
      await onRefresh();
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
    finally { setBusy(""); }
  }

  async function loadDiagnostics(node: NodeRecord) {
    setDiagnosticNode(node); setDiagnostics(null); setDiagnosticsBusy(true);
    try {
      const result = await api<NodeDiagnostics>(`/api/nodes/${node.id}`);
      setDiagnostics(result);
      if (result.node) setDiagnosticNode(result.node);
    }
    catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
    finally { setDiagnosticsBusy(false); }
  }

  const diagnosticNodeId = diagnosticNode?.id;
  useEffect(() => {
    if (!diagnosticNodeId) return;
    const timer = window.setInterval(() => {
      void api<NodeDiagnostics>(`/api/nodes/${diagnosticNodeId}`).then((result) => {
        setDiagnostics(result);
        if (result.node) setDiagnosticNode(result.node);
      }).catch(() => undefined);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [diagnosticNodeId]);

  async function operate(node: NodeRecord, action: "status-agent" | "restart-agent" | "bootstrap" | "delete") {
    const descriptions = {
      "restart-agent": `确定重启 ${node.name} 的 Agent 吗？`,
      bootstrap: `确定重新安装/修复 ${node.name} 吗？这会通过已验证的 SSH 凭据重新部署 Agent。`,
      delete: `确定删除节点 ${node.name} 吗？此操作不会自动销毁云服务器。`,
      "status-agent": "",
    };
    if (action !== "status-agent" && !window.confirm(descriptions[action])) return;
    setBusy(`${node.id}:${action}`); setNotice(null);
    try {
      if (action === "delete") await api(`/api/nodes/${node.id}`, { method: "DELETE" });
      else if (action === "bootstrap") await api(`/api/nodes/${node.id}`, { method: "POST", body: JSON.stringify({ action }) });
      else await api(`/api/nodes/${node.id}/actions`, { method: "POST", body: JSON.stringify({ action }) });
      setNotice({ tone: "success", message: action === "delete" ? "节点已删除。" : "操作已加入队列，可在节点诊断中跟踪进度。" });
      setOperationNode(null);
      await onRefresh();
      if (diagnosticNode?.id === node.id && action !== "delete") await loadDiagnostics(node);
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
    finally { setBusy(""); }
  }

  async function batch(action: "status-agent" | "restart-agent" | "bootstrap") {
    const ids = [...selected];
    if (!ids.length) return;
    if (action !== "status-agent" && !window.confirm(`确定对选中的 ${ids.length} 个节点执行“${action === "bootstrap" ? "重新安装/修复" : "重启 Agent"}”吗？`)) return;
    setBusy(`batch:${action}`); setNotice(null);
    try {
      const result = await api<{ accepted: string[]; skipped: string[]; queued: number }>("/api/nodes/batch-actions", { method: "POST", body: JSON.stringify({ action, nodeIds: ids }) });
      setNotice({ tone: result.skipped.length ? "info" : "success", message: `已加入队列 ${result.queued} 个，跳过 ${result.skipped.length} 个正在执行任务或不存在的节点。` });
      setSelected(new Set()); await onRefresh();
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
    finally { setBusy(""); }
  }

  const allSelected = nodes.length > 0 && selected.size === nodes.length;
  return <>
    <PageHeader eyebrow="EDGE FLEET" title="节点运维" description="部署、修复和诊断 Agent，并对节点执行批量运维操作。" actions={<><button className="button ghost" onClick={() => void onRefresh()}>刷新</button><button className="button primary" onClick={openCreate} disabled={!regions.length}>+ 添加节点</button></>} />
    {!regions.length && <InlineNotice notice={{ tone: "info", message: "添加节点前，请先在“区域”中创建至少一个区域。" }} />}
    <InlineNotice notice={notice} />
    {selected.size > 0 && <div className="batch-bar"><b>已选择 {selected.size} 个节点</b><span><button className="button ghost small" disabled={Boolean(busy)} onClick={() => void batch("status-agent")}>检查 Agent</button><button className="button ghost small" disabled={Boolean(busy)} onClick={() => void batch("restart-agent")}>重启 Agent</button><button className="button warning small" disabled={Boolean(busy)} onClick={() => void batch("bootstrap")}>批量修复</button></span></div>}
    <section className="panel flush">
      <div className="table-wrap"><table className="node-table action-table"><thead><tr><th className="check"><input type="checkbox" aria-label="选择全部节点" checked={allSelected} onChange={(event) => setSelected(event.target.checked ? new Set(nodes.map((node) => node.id)) : new Set())} /></th><th>节点</th><th>状态</th><th>Agent</th><th>负载</th><th>策略</th><th className="align-right">操作</th></tr></thead><tbody>{nodes.map((node) => <tr key={node.id}>
        <td className="check"><input type="checkbox" aria-label={`选择 ${node.name}`} checked={selected.has(node.id)} onChange={(event) => setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(node.id); else next.delete(node.id); return next; })} /></td>
        <td><button className="node-detail-trigger" onClick={() => void loadDiagnostics(node)}><i className={`state-dot ${node.status}`} /><span><b>{node.name}</b><small>{node.ip} · {node.place}</small></span><em>查看详情</em></button></td>
        <td><Pill value={node.status} /><small>{node.latency} · {node.last_seen}</small>{node.status === "provisioning" && <button className="progress-link" onClick={() => void loadDiagnostics(node)}>查看部署进度 →</button>}</td>
        <td><b>{node.version || "unknown"}</b><small>{node.ssh_user || "root"}:{node.ssh_port || 22}</small></td>
        <td>{node.metrics ? <><b>CPU {node.metrics.cpuPercent.toFixed(0)}%</b><small>内存 {node.metrics.memory.percent.toFixed(0)}% · 磁盘 {node.metrics.disk.percent.toFixed(0)}%</small></> : <span className="muted">暂无指标</span>}</td>
        <td><b>{node.deployment_policy || "standard"}</b><small>policy v{node.policy_version || 0}</small></td>
        <td className="align-right"><div className="operation-buttons"><button className="text-button detail-button" onClick={() => void loadDiagnostics(node)}>详情 / 进度</button><button className="text-button" onClick={() => openEdit(node)}>配置</button><button className="more-button" onClick={() => setOperationNode(node)}>更多 <span>•••</span></button></div></td>
      </tr>)}</tbody></table></div>
      {!nodes.length && <Empty>尚未部署节点。创建区域后即可添加第一台服务器。</Empty>}
    </section>

    {showForm && <Modal title={editing ? `编辑 ${editing.name}` : "添加节点"} description={editing ? "留空凭据表示保持当前 SSH 凭据。" : "节点会先验证 SSH 主机，再加入安全部署队列。"} onClose={() => setShowForm(false)}>
      <form className="form-grid" onSubmit={saveNode}>
        <label className="span-2">节点名称<input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Tokyo Edge" /></label>
        <label>公网 IPv4<input required value={form.ip} onChange={(event) => setForm({ ...form, ip: event.target.value })} placeholder="203.0.113.10" /></label>
        <label>区域<select required value={form.regionId} onChange={(event) => setForm({ ...form, regionId: event.target.value })}><option value="">选择区域</option>{regions.map((region) => <option key={region.id} value={region.id}>{region.name} · {region.country}</option>)}</select></label>
        <label>SSH 用户<input required value={form.sshUser} onChange={(event) => setForm({ ...form, sshUser: event.target.value })} /></label>
        <label>SSH 端口<input required type="number" min="1" max="65535" value={form.sshPort} onChange={(event) => setForm({ ...form, sshPort: event.target.value })} /></label>
        {!editing && <label>部署模板<select value={form.deploymentTemplate} onChange={(event) => setForm({ ...form, deploymentTemplate: event.target.value })}><option value="standard">Standard（推荐）</option><option value="wireguard">仅 WireGuard</option><option value="openvpn">仅 OpenVPN</option><option value="agent-only">仅 Agent</option></select></label>}
        <label>凭据类型<select value={form.credentialType} onChange={(event) => setForm({ ...form, credentialType: event.target.value as NodeForm["credentialType"] })}><option value="password">SSH 密码</option><option value="private_key">私钥 PEM</option></select></label>
        <label className="span-2">{editing ? "新凭据（可留空）" : "SSH 凭据"}<textarea required={!editing} rows={form.credentialType === "private_key" ? 6 : 2} value={form.secret} onChange={(event) => setForm({ ...form, secret: event.target.value })} autoComplete="new-password" /></label>
        <div className="fingerprint-field span-2"><div className="fingerprint-label"><label htmlFor="host-fingerprint">SSH 主机指纹（生产环境必填）</label><button type="button" className="help-toggle" onClick={() => setShowFingerprintGuide((current) => !current)} aria-expanded={showFingerprintGuide}>{showFingerprintGuide ? "收起说明" : "如何获取？"}</button></div><input id="host-fingerprint" value={form.hostFingerprint} onChange={(event) => setForm({ ...form, hostFingerprint: event.target.value })} placeholder="SHA256:…" />{showFingerprintGuide && <aside className="fingerprint-guide"><b>推荐：在目标节点的可信控制台获取</b><p>通过云厂商控制台登录目标 VPN 节点，执行下面的命令：</p><div className="fingerprint-command"><code>{localFingerprintCommand}</code><button type="button" onClick={() => void copyFingerprintCommand("local", localFingerprintCommand)}>{copiedFingerprintCommand === "local" ? "已复制" : "复制命令"}</button></div><p>可以把整行输出直接粘贴到上面的输入框，系统会自动提取其中的 <strong>SHA256:</strong> 指纹。</p><b>快捷读取：从 Controller 或自己的终端执行</b>{remoteFingerprintCommand ? <div className="fingerprint-command"><code>{remoteFingerprintCommand}</code><button type="button" onClick={() => void copyFingerprintCommand("remote", remoteFingerprintCommand)}>{copiedFingerprintCommand === "remote" ? "已复制" : "复制命令"}</button></div> : <p>填写公网 IPv4 后，这里会自动生成带 IP 和 SSH 端口的命令。</p>}<small><code>ssh-keyscan</code> 只能读取指纹，不能证明主机身份。首次添加节点时，请与云厂商控制台里的本机指纹核对。如果没有 Ed25519 主机密钥，可将文件名改为 <code>/etc/ssh/ssh_host_rsa_key.pub</code>。</small></aside>}</div>
        <div className="form-actions span-2"><button type="button" className="button ghost" onClick={() => setShowForm(false)}>取消</button><button className="button primary" disabled={busy === "save-node"}>{busy === "save-node" ? "保存中…" : editing ? "保存配置" : "添加并部署"}</button></div>
      </form>
    </Modal>}

    {operationNode && <Modal title="节点操作" description={`${operationNode.name} · ${operationNode.ip}`} onClose={() => setOperationNode(null)}>
      <div className="node-operation-summary"><span className={`state-dot ${operationNode.status}`} /><span><b>{operationNode.name}</b><small>{operationNode.place} · {operationNode.version}</small></span><Pill value={operationNode.status} /></div>
      <div className="operation-grid">
        <button disabled={Boolean(busy)} onClick={() => void operate(operationNode, "status-agent")}><span className="operation-symbol">✓</span><span><b>检查 Agent</b><small>读取服务状态并记录诊断结果，不会重启服务。</small></span><em>安全</em></button>
        <button disabled={Boolean(busy)} onClick={() => void operate(operationNode, "restart-agent")}><span className="operation-symbol">↻</span><span><b>重启 Agent</b><small>重启远端 Agent 服务，短时间内会中断状态上报。</small></span><em>需确认</em></button>
        <button className="warning-operation" disabled={Boolean(busy)} onClick={() => void operate(operationNode, "bootstrap")}><span className="operation-symbol">⇧</span><span><b>重新安装 / 修复</b><small>通过已保存的 SSH 凭据重新部署并同步 Agent 身份。</small></span><em>需确认</em></button>
        <button className="danger-operation" disabled={Boolean(busy)} onClick={() => void operate(operationNode, "delete")}><span className="operation-symbol">×</span><span><b>删除节点</b><small>从 Controller 移除节点，不会销毁对应的云服务器。</small></span><em>危险</em></button>
      </div>
      <div className="form-actions operation-footer"><button className="button ghost" onClick={() => setOperationNode(null)}>关闭</button></div>
    </Modal>}

    {diagnosticNode && <Modal wide title={`${diagnosticNode.name} · 节点详情`} description="部署进度、操作日志、Agent 连通性和 VPN 协议运行状态。" onClose={() => { setDiagnosticNode(null); setDiagnostics(null); }}>
      <div className="diagnostic-toolbar"><span><i className="live-mark" /> 每 5 秒自动刷新</span><button className="button ghost small" disabled={diagnosticsBusy} onClick={() => void loadDiagnostics(diagnosticNode)}>立即刷新</button><button className="button ghost small" disabled={Boolean(busy)} onClick={() => void operate(diagnosticNode, "status-agent")}>检查 Agent</button><button className="button warning small" disabled={Boolean(busy)} onClick={() => void operate(diagnosticNode, "bootstrap")}>重新安装 / 修复</button></div>
      {diagnosticsBusy && !diagnostics ? <Empty>正在读取诊断信息…</Empty> : diagnostics && <div className="diagnostics">
        {diagnostics.actions[0] ? <section className={`current-job ${diagnostics.actions[0].status}`}>
          <div className="current-job-head"><div><p className="eyebrow">CURRENT / LATEST JOB</p><h3>{actionLabel(diagnostics.actions[0].action)}</h3><span>{phaseLabel(diagnostics.actions[0].current_phase)} · <Pill value={diagnostics.actions[0].status} /></span></div><time>{formatTime(diagnostics.actions[0].finished_at || diagnostics.actions[0].started_at || diagnostics.actions[0].created_at)}</time></div>
          <div className="job-progress"><i style={{ width: `${Math.min(Math.max(diagnostics.actions[0].progress || 0, 0), 100)}%` }} /><span>{diagnostics.actions[0].progress || 0}%</span></div>
          {diagnostics.actions[0].error && <pre className="job-error">{diagnostics.actions[0].error}</pre>}
        </section> : <InlineNotice notice={{ tone: "info", message: "该节点还没有部署或运维任务记录。" }} />}
        <div className="diagnostic-cards"><article><small>节点</small><b><Pill value={diagnostics.connectivity?.status || diagnosticNode.status} /></b><span>{diagnosticNode.ip}</span></article><article><small>Agent 通道</small><b>{diagnostics.connectivity?.agentChannel || "unknown"}</b><span>{formatTime(diagnostics.connectivity?.lastAuthenticatedHeartbeat)}</span></article><article><small>防火墙</small><b>{diagnostics.connectivity?.firewall.manager || "unknown"}</b><span>{diagnostics.connectivity?.firewall.inputPolicy || "—"}</span></article><article><small>资源</small><b>{diagnosticNode.metrics ? `CPU ${diagnosticNode.metrics.cpuPercent.toFixed(0)}%` : "暂无指标"}</b><span>{diagnosticNode.metrics ? `内存 ${diagnosticNode.metrics.memory.percent.toFixed(0)}% · 网络 ↓ ${formatBytes(diagnosticNode.metrics.network.rxBytesPerSecond)}/s` : "等待心跳上报"}</span></article></div>
        {diagnostics.connectivity?.note && <div className="inline-notice info">{diagnostics.connectivity.note}</div>}
        <section className="deployment-log"><div className="diagnostic-section-head"><div><h3>部署与操作日志</h3><p>Controller 记录的 Bootstrap、Agent 和修复任务事件，最新事件在最上方。</p></div><span>{diagnostics.actionEvents.length} 条事件</span></div>{diagnostics.actionEvents.length ? <div className="event-list">{diagnostics.actionEvents.slice(0, 100).map((event) => <div key={event.id}><time>{formatTime(event.created_at)}</time><Pill value={event.level} /><span><b>{phaseLabel(event.phase)}</b>{event.message}</span></div>)}</div> : <Empty>还没有部署或操作日志。</Empty>}</section>
        <section><h3>VPN 协议运行状态</h3>{diagnostics.connectivity?.protocols.length ? <div className="protocol-grid">{diagnostics.connectivity.protocols.map((protocol) => <article key={protocol.protocol}><div><b>{protocol.protocol}</b><Pill value={protocol.state} /></div><small>{protocol.transport}:{protocol.port} · {protocol.listening ? "正在监听" : "未监听"} · runtime {protocol.runtimeActive ? "active" : "inactive"}</small><small>Host FW: {protocol.hostFirewall} · Cloud FW: {protocol.cloudFirewall}</small>{protocol.lastError && <p>{protocol.lastError}</p>}</article>)}</div> : <Empty>没有 Agent 协议状态。</Empty>}</section>
        <section><h3>配置同步任务</h3>{diagnostics.reconcile.tasks.length ? <div className="action-list">{diagnostics.reconcile.tasks.slice(0, 20).map((task) => <article key={task.id}><div><b>{task.protocol} · {task.taskType}</b><Pill value={task.status} /></div><small>revision {task.desiredRevision} · 尝试 {task.attempts} 次 · {formatTime(task.createdAt)}</small>{task.lastError && <p>{task.lastError}</p>}</article>)}</div> : <Empty>没有待处理的配置同步任务。</Empty>}</section>
        <section><h3>任务历史与原始输出</h3>{diagnostics.actions.length ? <div className="operation-history-list">{diagnostics.actions.map((action) => <details key={action.id} defaultOpen={action.id === diagnostics.actions[0]?.id && action.status === "failed"}><summary><span><b>{actionLabel(action.action)}</b><small>{phaseLabel(action.current_phase)} · {action.progress || 0}%</small></span><Pill value={action.status} /><time>{formatTime(action.finished_at || action.started_at || action.created_at)}</time><i>⌄</i></summary><div>{action.error && <><b>错误</b><pre className="history-error">{action.error}</pre></>}{action.output && <><b>原始输出</b><pre>{action.output}</pre></>}{!action.error && !action.output && <p>该任务没有保存额外输出。</p>}</div></details>)}</div> : <Empty>没有历史任务。</Empty>}</section>
      </div>}
    </Modal>}
  </>;
}

export function ServicesPage({ nodes }: { nodes: NodeRecord[] }) {
  const [services, setServices] = useState<VpnService[]>([]);
  const [policy, setPolicy] = useState<DeploymentPolicyOverview | null>(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const nodeMap = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);

  async function refresh() {
    try {
      const [serviceResult, policyResult] = await Promise.all([api<{ services: VpnService[] }>("/api/vpn-services"), api<DeploymentPolicyOverview>("/api/deployment-policy")]);
      setServices(serviceResult.services || []); setPolicy(policyResult);
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
  }
  useEffect(() => {
    void Promise.all([
      api<{ services: VpnService[] }>("/api/vpn-services"),
      api<DeploymentPolicyOverview>("/api/deployment-policy"),
    ]).then(([serviceResult, policyResult]) => {
      setServices(serviceResult.services || []); setPolicy(policyResult);
    }).catch((error: Error) => setNotice({ tone: "error", message: error.message }));
  }, []);

  async function serviceAction(service: VpnService, action: "enable" | "disable" | "restart" | "redeploy") {
    const actionLabel = { enable: "启用", disable: "停用", restart: "重启服务", redeploy: "重新部署" }[action];
    if (!window.confirm(`确定对 ${nodeMap.get(service.node_id)?.name || service.node_id} 的 ${service.protocol} 执行“${actionLabel}”吗？`)) return;
    const key = `${service.node_id}:${service.protocol}`; setBusy(key); setNotice(null);
    try {
      await api(`/api/nodes/${service.node_id}/services`, { method: "POST", body: JSON.stringify({ protocol: service.protocol, action }) });
      setNotice({ tone: "success", message: `${actionLabel}操作已提交，可在节点详情的配置同步任务中查看进度。` }); await refresh();
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
    finally { setBusy(""); }
  }

  async function rollout(mode: "canary" | "batch") {
    const label = mode === "canary" ? "单节点灰度" : "批量更新";
    if (!window.confirm(`确定启动 Standard 策略${label}吗？只会处理状态可用且发生漂移的节点。`)) return;
    setBusy(`rollout:${mode}`); setNotice(null);
    try {
      const result = await api<{ rollout: { totalTargets: number; queuedTargets: number; failedTargets: number } }>("/api/deployment-policy", { method: "POST", body: JSON.stringify({ mode, limit: 25 }) });
      setNotice({ tone: "success", message: `策略发布已创建：目标 ${result.rollout.totalTargets}，已排队 ${result.rollout.queuedTargets}，失败 ${result.rollout.failedTargets}。` }); await refresh();
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
    finally { setBusy(""); }
  }

  return <>
    <PageHeader eyebrow="VPN SERVICES" title="VPN 服务" description="管理每个节点的协议服务，并以灰度或批量方式修复 Standard 策略漂移。" actions={<button className="button ghost" onClick={() => void refresh()}>刷新</button>} />
    <InlineNotice notice={notice} />
    {policy && <section className="policy-banner"><div><p className="eyebrow">STANDARD POLICY V{policy.standard.version}</p><h2>标准部署策略</h2><p>{policy.standard.protocols.map((item) => `${item.protocol} ${item.transport}:${item.listenPort}`).join(" · ") || "当前没有启用的标准协议"}</p></div><div className="policy-counts"><span><b>{policy.counts.standardNodes}</b>标准节点</span><span><b>{policy.counts.driftedNodes}</b>策略漂移</span><span><b>{policy.counts.blockedNodes}</b>暂不可更新</span></div><div className="policy-actions"><button className="button ghost" disabled={Boolean(busy) || !policy.counts.eligibleNodes} onClick={() => void rollout("canary")}>灰度 1 台</button><button className="button primary" disabled={Boolean(busy) || !policy.counts.eligibleNodes} onClick={() => void rollout("batch")}>批量更新</button></div></section>}
    {policy?.driftedNodes.length ? <section className="panel"><div className="panel-head"><div><p className="eyebrow">POLICY DRIFT</p><h2>待同步节点</h2></div></div><div className="compact-list">{policy.driftedNodes.map((node) => <div key={node.id}><span className={`state-dot ${node.eligible ? "online" : "attention"}`} /><span><b>{node.name}</b><small>缺少：{node.missingProtocols.join(", ") || "策略版本"} · {node.reason}</small></span><Pill value={node.eligible ? "eligible" : "blocked"} /></div>)}</div></section> : null}
    <section className="panel flush">
      <div className="table-wrap"><table className="action-table"><thead><tr><th>节点</th><th>协议</th><th>监听</th><th>服务状态</th><th>更新时间</th><th className="align-right">操作</th></tr></thead><tbody>{services.map((service) => <tr key={`${service.node_id}:${service.protocol}`}>
        <td><b>{nodeMap.get(service.node_id)?.name || service.node_id}</b><small>{nodeMap.get(service.node_id)?.ip}</small></td><td><b>{service.protocol}</b><small>{service.subnet}</small></td><td>{service.transport}:{service.listen_port}<small>DNS {service.dns.join(", ")}</small></td><td><Pill value={!service.enabled ? "disabled" : service.status} />{service.last_error && <small className="error-text">{service.last_error}</small>}</td><td>{formatTime(service.updated_at)}</td><td className="align-right"><span className="row-actions">{service.enabled ? <><button className="text-button danger-text" disabled={busy === `${service.node_id}:${service.protocol}`} onClick={() => void serviceAction(service, "disable")}>停用</button><button className="text-button" disabled={busy === `${service.node_id}:${service.protocol}`} onClick={() => void serviceAction(service, "restart")}>重启服务</button></> : <button className="text-button" disabled={busy === `${service.node_id}:${service.protocol}`} onClick={() => void serviceAction(service, "enable")}>启用</button>}<button className="text-button" disabled={busy === `${service.node_id}:${service.protocol}`} onClick={() => void serviceAction(service, "redeploy")}>重新部署</button></span></td>
      </tr>)}</tbody></table></div>{!services.length && <Empty>还没有 VPN 服务。部署节点后，服务会在此出现。</Empty>}
    </section>
    {policy?.rollouts.length ? <section className="panel"><div className="panel-head"><div><p className="eyebrow">ROLLOUT HISTORY</p><h2>策略发布记录</h2></div></div><div className="table-wrap"><table><thead><tr><th>时间</th><th>模式</th><th>版本</th><th>状态</th><th>结果</th></tr></thead><tbody>{policy.rollouts.map((rollout) => <tr key={rollout.id}><td>{formatTime(rollout.createdAt)}</td><td>{rollout.mode}</td><td>v{rollout.fromVersion} → v{rollout.toVersion}</td><td><Pill value={rollout.status} /></td><td>{rollout.succeededTargets} 成功 / {rollout.queuedTargets} 处理中 / {rollout.blockedTargets + rollout.failedTargets} 异常</td></tr>)}</tbody></table></div></section> : null}
  </>;
}

export function RegionsPage({ regions, nodes, onRefresh }: { regions: Region[]; nodes: NodeRecord[]; onRefresh: () => Promise<void> }) {
  const [editing, setEditing] = useState<Region | null>(null);
  const [form, setForm] = useState({ name: "", country: "", code: "" });
  const [locationChoice, setLocationChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  function edit(region: Region) {
    const preset = regionPresets.find((item) => item.name === region.name && item.code === region.code);
    setEditing(region); setForm({ name: region.name, country: region.country, code: region.code });
    setLocationChoice(preset ? `preset:${preset.id}` : region.name === countryName(region.code) ? `country:${region.code}` : "custom");
  }
  function clear() { setEditing(null); setForm({ name: "", country: "", code: "" }); setLocationChoice(""); }
  function chooseLocation(value: string) {
    setLocationChoice(value);
    if (value.startsWith("preset:")) {
      const preset = regionPresets.find((item) => item.id === value.slice(7));
      if (preset) setForm({ name: preset.name, country: countryName(preset.code), code: preset.code });
    } else if (value.startsWith("country:")) {
      const code = value.slice(8);
      const country = countryName(code);
      setForm({ name: country, country, code });
    } else if (value === "custom" && !editing) {
      setForm({ name: "", country: "", code: "" });
    }
  }
  function chooseCountry(code: string) {
    const option = countryOptions.find((item) => item.code === code);
    setForm((current) => ({ ...current, country: option?.country || countryName(code), code }));
  }
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setNotice(null);
    try {
      await api(editing ? `/api/regions/${editing.id}` : "/api/regions", { method: editing ? "PATCH" : "POST", body: JSON.stringify(form) });
      setNotice({ tone: "success", message: editing ? "区域已更新。" : "区域已创建。" }); clear(); await onRefresh();
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
    finally { setBusy(false); }
  }
  async function remove(region: Region) {
    if (!window.confirm(`确定删除区域 ${region.name} · ${region.country} 吗？仍有关联节点时系统会拒绝删除。`)) return;
    try { await api(`/api/regions/${region.id}`, { method: "DELETE" }); setNotice({ tone: "success", message: "区域已删除。" }); await onRefresh(); }
    catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
  }
  return <>
    <PageHeader eyebrow="REGIONS" title="区域管理" description="维护节点所在区域；区域用于展示、分组和部署选择。" />
    <InlineNotice notice={notice} />
    <div className="region-layout">
      <section className="panel"><div className="panel-head"><div><p className="eyebrow">REGION DIRECTORY</p><h2>区域列表</h2></div></div>{regions.length ? <div className="region-list">{regions.map((region) => <article key={region.id}><span className="region-code">{region.code}</span><span className="grow"><b>{region.name}</b><small>{region.country} · {nodes.filter((node) => node.region_id === region.id).length} 个节点</small></span><span className="row-actions"><button className="text-button" onClick={() => edit(region)}>编辑</button><button className="text-button danger-text" onClick={() => void remove(region)}>删除</button></span></article>)}</div> : <Empty>尚未创建区域。</Empty>}</section>
      <section className="panel sticky-panel"><div className="panel-head"><div><p className="eyebrow">{editing ? "EDIT REGION" : "NEW REGION"}</p><h2>{editing ? "编辑区域" : "创建区域"}</h2></div></div><form className="stack-form" onSubmit={save}><label>服务器位置<select required value={locationChoice} onChange={(event) => chooseLocation(event.target.value)}><option value="">请选择服务器所在地</option>{presetGroups.map((group) => <optgroup key={group} label={`常用机房 · ${group}`}>{regionPresets.filter((item) => item.group === group).map((item) => <option key={item.id} value={`preset:${item.id}`}>{item.label}</option>)}</optgroup>)}<optgroup label="全球国家 / 地区">{countryOptions.map((item) => <option key={item.code} value={`country:${item.code}`}>{item.label}</option>)}</optgroup><option value="custom">自定义位置（城市未列出）</option></select><small>选择常用城市或国家后，下面三项会自动联动。</small></label><label>城市 / 区域显示名称<input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如 Tokyo、US West" /></label>{locationChoice === "custom" ? <label>国家 / 地区<select required value={form.code} onChange={(event) => chooseCountry(event.target.value)}><option value="">请选择国家 / 地区</option>{form.code && !countryOptions.some((item) => item.code === form.code) && <option value={form.code}>{form.country} ({form.code})</option>}{countryOptions.map((item) => <option key={item.code} value={item.code}>{item.label}</option>)}</select></label> : <label>国家 / 地区<input required readOnly value={form.country} placeholder="自动填写" /></label>}<label>区域代码（ISO）<input required readOnly value={form.code} placeholder="自动填写" /></label><div className="form-actions">{editing && <button type="button" className="button ghost" onClick={clear}>取消</button>}<button className="button primary" disabled={busy}>{busy ? "保存中…" : "保存区域"}</button></div></form></section>
    </div>
  </>;
}

export function ControllerPage({ onSettingsChange }: { onSettingsChange: (settings: ControllerInfo["settings"]) => void }) {
  const [info, setInfo] = useState<ControllerInfo | null>(null);
  const [form, setForm] = useState({ displayName: "", locationLabel: "", latitude: "", longitude: "" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  async function refresh() {
    try {
      const result = await api<ControllerInfo>("/api/controller"); setInfo(result); onSettingsChange(result.settings);
      setForm({ displayName: result.settings.display_name, locationLabel: result.settings.location_label, latitude: result.settings.latitude === null ? "" : String(result.settings.latitude), longitude: result.settings.longitude === null ? "" : String(result.settings.longitude) });
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
  }
  useEffect(() => {
    void api<ControllerInfo>("/api/controller").then((result) => {
      setInfo(result);
      onSettingsChange(result.settings);
      setForm({ displayName: result.settings.display_name, locationLabel: result.settings.location_label, latitude: result.settings.latitude === null ? "" : String(result.settings.latitude), longitude: result.settings.longitude === null ? "" : String(result.settings.longitude) });
    }).catch((error: Error) => setNotice({ tone: "error", message: error.message }));
  }, [onSettingsChange]);
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setNotice(null);
    try {
      const result = await api<ControllerInfo>("/api/controller", { method: "PUT", body: JSON.stringify({ displayName: form.displayName, locationLabel: form.locationLabel, latitude: form.latitude === "" ? null : Number(form.latitude), longitude: form.longitude === "" ? null : Number(form.longitude) }) });
      setInfo(result); onSettingsChange(result.settings); setNotice({ tone: "success", message: "Controller 设置已保存，全球拓扑已同步更新。" });
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
    finally { setBusy(false); }
  }
  return <>
    <PageHeader eyebrow="CONTROLLER" title="Controller" description="查看控制面运行状态，并维护对外展示的名称与位置。" actions={<button className="button ghost" onClick={() => void refresh()}>刷新状态</button>} />
    <InlineNotice notice={notice} />
    {info ? <><section className="controller-hero"><div><span className="live-mark" /> <Pill value={info.status} /><h2>{info.settings.display_name}</h2><p>{info.publicOrigin}</p></div><div className="controller-stats"><span><small>构建版本</small><b>{info.build}</b></span><span><small>运行时</small><b>Node {info.runtime.nodeVersion}</b></span><span><small>运行时间</small><b>{Math.floor(info.runtime.uptimeSeconds / 3600)} 小时</b></span><span><small>内存</small><b>{formatBytes(info.runtime.rssBytes)}</b></span><span><small>Load 1m</small><b>{info.runtime.load1.toFixed(2)}</b></span><span><small>公网 IP</small><b>{info.publicIp || "未检测"}</b></span></div></section><div className="two-column controller-layout"><section className="panel"><div className="panel-head"><div><p className="eyebrow">PRESENTATION</p><h2>显示与位置</h2></div></div><form className="stack-form" onSubmit={save}><label>Controller 名称<input required value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} /></label><label>位置名称<input value={form.locationLabel} onChange={(event) => setForm({ ...form, locationLabel: event.target.value })} placeholder="Singapore · SG" /></label><div className="split-fields"><label>纬度<input type="number" min="-90" max="90" step="any" value={form.latitude} onChange={(event) => setForm({ ...form, latitude: event.target.value })} /></label><label>经度<input type="number" min="-180" max="180" step="any" value={form.longitude} onChange={(event) => setForm({ ...form, longitude: event.target.value })} /></label></div><small>经纬度必须同时填写或同时留空。当前来源：{info.settings.location_source}</small><div className="form-actions"><button className="button primary" disabled={busy}>{busy ? "保存中…" : "保存设置"}</button></div></form></section><section className="panel"><div className="panel-head"><div><p className="eyebrow">RUNTIME</p><h2>运行详情</h2></div></div><dl className="detail-list"><div><dt>Public Host</dt><dd>{info.publicHost}</dd></div><div><dt>Heap Used</dt><dd>{formatBytes(info.runtime.heapUsedBytes)}</dd></div><div><dt>RSS</dt><dd>{formatBytes(info.runtime.rssBytes)}</dd></div><div><dt>最近观测</dt><dd>{formatTime(info.runtime.observedAt)}</dd></div></dl></section></div></> : <Empty>正在读取 Controller 状态…</Empty>}
  </>;
}

export function LogsPage({ nodes }: { nodes: NodeRecord[] }) {
  const [logs, setLogs] = useState<OperationalLogLine[]>([]);
  const [available, setAvailable] = useState(true);
  const [filters, setFilters] = useState({ nodeId: "", level: "", hours: "24" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
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
    const typed = window.prompt(`这是不可逆操作。请输入 ${confirmation} 以确认删除${filters.nodeId ? "当前节点" : "全部系统"}日志。`, "");
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
