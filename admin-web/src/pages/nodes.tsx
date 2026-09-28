import { type FormEvent, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useConfirm } from "../confirm-dialog";
import type { NodeDiagnostics, NodeRecord, Region } from "../types";
import { Empty, formatBytes, formatTime, InlineNotice, Modal, type Notice, PageHeader, Pill } from "./shared";

function actionLabel(value: string): string {
  return ({ bootstrap: "安装 / 修复 Agent", "status-agent": "检查 Agent", "restart-agent": "重启 Agent" } as Record<string, string>)[value] || value.replaceAll("-", " ");
}

function phaseLabel(value?: string): string {
  if (!value) return "等待开始";
  return value.replaceAll("-", " ").replaceAll("_", " ");
}

type NodeForm = {
  name: string; ip: string; regionId: string; sshUser: string; sshPort: string; secret: string;
  credentialType: "password" | "private_key"; sshPrivilegeMode: "root" | "sudo"; deploymentTemplate: string;
};

const blankNodeForm: NodeForm = { name: "", ip: "", regionId: "", sshUser: "root", sshPort: "22", secret: "", credentialType: "password", sshPrivilegeMode: "root", deploymentTemplate: "standard" };

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
  // Id of the node whose diagnostics modal is open; responses for any other id (or after close) are stale.
  const diagnosticRequestRef = useRef<string | null>(null);
  const [testedFingerprint, setTestedFingerprint] = useState("");
  const confirm = useConfirm();

  function openCreate() {
    setEditing(null); setForm({ ...blankNodeForm, regionId: regions[0]?.id || "" }); setTestedFingerprint(""); setShowForm(true);
  }

  function openEdit(node: NodeRecord) {
    setEditing(node);
    const sshUser = node.ssh_user || "root";
    setForm({ name: node.name, ip: node.ip, regionId: node.region_id || "", sshUser, sshPort: String(node.ssh_port || 22), secret: "", credentialType: node.credential_type || "password", sshPrivilegeMode: node.ssh_privilege_mode === "sudo" || (node.ssh_privilege_mode === "auto" && sshUser !== "root") ? "sudo" : "root", deploymentTemplate: node.deployment_policy || "standard" });
    setTestedFingerprint(""); setShowForm(true);
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

  async function loadPrivateKey(file: File | undefined) {
    if (!file) return;
    if (file.size > 60 * 1024) { setNotice({ tone: "error", message: "SSH 私钥文件不能超过 60 KB。" }); return; }
    let secret: string;
    try { secret = await file.text(); }
    catch { setNotice({ tone: "error", message: "无法读取 SSH 私钥文件。" }); return; }
    setForm((current) => ({ ...current, credentialType: "private_key", secret }));
    setTestedFingerprint("");
  }

  async function testSshConnection() {
    setBusy("test-ssh"); setNotice(null); setTestedFingerprint("");
    try {
      const result = await api<{ ok: boolean; fingerprint: string; sshPrivilegeMode: "root" | "sudo" }>("/api/nodes/test-connection", {
        method: "POST",
        body: JSON.stringify({ ...form, nodeId: editing?.id, sshPort: Number(form.sshPort) }),
      });
      setTestedFingerprint(result.fingerprint);
      setNotice({ tone: "success", message: `SSH 连接与${result.sshPrivilegeMode === "sudo" ? "免密 sudo" : "root 权限"}验证通过，主机指纹已自动读取。` });
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
    finally { setBusy(""); }
  }

  async function loadDiagnostics(node: NodeRecord) {
    diagnosticRequestRef.current = node.id;
    setDiagnosticNode(node); setDiagnostics(null); setDiagnosticsBusy(true);
    try {
      const result = await api<NodeDiagnostics>(`/api/nodes/${node.id}`);
      if (diagnosticRequestRef.current !== node.id) return;
      setDiagnostics(result);
      if (result.node) setDiagnosticNode(result.node);
    }
    catch (error) { if (diagnosticRequestRef.current === node.id) setNotice({ tone: "error", message: (error as Error).message }); }
    finally { if (diagnosticRequestRef.current === node.id) setDiagnosticsBusy(false); }
  }

  function closeDiagnostics() {
    diagnosticRequestRef.current = null;
    setDiagnosticNode(null); setDiagnostics(null); setDiagnosticsBusy(false);
  }

  const diagnosticNodeId = diagnosticNode?.id;
  useEffect(() => {
    if (!diagnosticNodeId) return;
    const timer = window.setInterval(() => {
      void api<NodeDiagnostics>(`/api/nodes/${diagnosticNodeId}`).then((result) => {
        if (diagnosticRequestRef.current !== diagnosticNodeId) return;
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
    const titles = { "restart-agent": "重启 Agent", bootstrap: "重新安装 / 修复", delete: "删除节点", "status-agent": "" };
    if (action !== "status-agent" && !await confirm({
      title: titles[action],
      message: descriptions[action],
      confirmLabel: titles[action],
      danger: action === "delete",
    })) return;
    setBusy(`${node.id}:${action}`); setNotice(null);
    try {
      if (action === "delete") await api(`/api/nodes/${node.id}`, { method: "DELETE" });
      else if (action === "bootstrap") await api(`/api/nodes/${node.id}`, { method: "POST", body: JSON.stringify({ action }) });
      else await api(`/api/nodes/${node.id}/actions`, { method: "POST", body: JSON.stringify({ action }) });
      setNotice({ tone: "success", message: action === "delete" ? "节点已删除。" : "操作已加入队列，可在节点诊断中跟踪进度。" });
      setOperationNode(null);
      await onRefresh();
      if (diagnosticRequestRef.current === node.id) {
        if (action === "delete") closeDiagnostics();
        else await loadDiagnostics(node);
      }
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
    finally { setBusy(""); }
  }

  async function batch(action: "status-agent" | "restart-agent" | "bootstrap") {
    const ids = [...selected];
    if (!ids.length) return;
    const batchLabel = action === "bootstrap" ? "重新安装/修复" : "重启 Agent";
    if (action !== "status-agent" && !await confirm({
      title: `批量${batchLabel}`,
      message: `确定对选中的 ${ids.length} 个节点执行“${batchLabel}”吗？`,
      confirmLabel: "确认执行",
    })) return;
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
        <label>公网 IPv4<input required value={form.ip} onChange={(event) => { setForm({ ...form, ip: event.target.value }); setTestedFingerprint(""); }} placeholder="203.0.113.10" /></label>
        <label>区域<select required value={form.regionId} onChange={(event) => setForm({ ...form, regionId: event.target.value })}><option value="">选择区域</option>{regions.map((region) => <option key={region.id} value={region.id}>{region.name} · {region.country}</option>)}</select></label>
        <label>SSH 用户<input required value={form.sshUser} onChange={(event) => { setForm({ ...form, sshUser: event.target.value }); setTestedFingerprint(""); }} /></label>
        <label>SSH 端口<input required type="number" min="1" max="65535" value={form.sshPort} onChange={(event) => { setForm({ ...form, sshPort: event.target.value }); setTestedFingerprint(""); }} /></label>
        <label>凭据类型<select value={form.credentialType} onChange={(event) => { setForm({ ...form, credentialType: event.target.value as NodeForm["credentialType"], secret: "" }); setTestedFingerprint(""); }}><option value="password">SSH 密码</option><option value="private_key">SSH 私钥</option></select></label>
        <label>远程权限<select value={form.sshPrivilegeMode} onChange={(event) => { setForm({ ...form, sshPrivilegeMode: event.target.value as NodeForm["sshPrivilegeMode"] }); setTestedFingerprint(""); }}><option value="root">直接使用 root</option><option value="sudo">非 root + 免密 sudo</option></select><small>{form.sshPrivilegeMode === "sudo" ? "适合 ubuntu、ec2-user、debian 等云主机账号。" : "SSH 登录账号必须具有 uid 0。"}</small></label>
        {!editing && <label className="span-2">部署模板<select value={form.deploymentTemplate} onChange={(event) => setForm({ ...form, deploymentTemplate: event.target.value })}><option value="standard">Standard（推荐）</option><option value="wireguard">仅 WireGuard</option><option value="openvpn">仅 OpenVPN</option><option value="agent-only">仅 Agent</option></select></label>}
        <label className="span-2 credential-input">{editing ? "新凭据（可留空）" : "SSH 凭据"}{form.credentialType === "private_key" && <span className="credential-file"><input type="file" accept=".pem,.key,text/plain" onChange={(event) => void loadPrivateKey(event.target.files?.[0])} /><em>选择 .pem / .key 文件</em></span>}<textarea required={!editing} rows={form.credentialType === "private_key" ? 7 : 2} value={form.secret} onChange={(event) => { setForm({ ...form, secret: event.target.value }); setTestedFingerprint(""); }} autoComplete="new-password" placeholder={form.credentialType === "private_key" ? "粘贴 OpenSSH、RSA、EC 或 PKCS#8 私钥" : "输入 SSH 密码"} /><small>{form.credentialType === "private_key" ? "私钥会在 Controller 使用主密钥加密；暂不支持带口令的私钥。" : "密码会加密保存，仅用于节点安装和应急修复。"}</small></label>
        <div className="fingerprint-field span-2"><div className="fingerprint-label"><label>服务器身份自动识别</label></div><aside className="fingerprint-guide"><b>无需手工生成或填写指纹</b><p>添加时，Controller 会通过 SSH 自动读取并固定主机公钥，同时在服务器上读取或生成持久的 Northstar 节点 ID。发现重复节点、复用的 SSH host key 或重复 IP/端口时会停止部署。</p><small>首次连接采用 TOFU；后续部署和修复必须匹配已固定的主机指纹与节点 ID。</small></aside>{testedFingerprint && <div className="ssh-test-result"><b>本次连接读取到的 SSH 指纹</b><code>{testedFingerprint}</code><small>保存节点时会重新连接、登记节点 ID，并执行去重检查。</small></div>}</div>
        <div className="form-actions span-2"><button type="button" className="button ghost" disabled={Boolean(busy)} onClick={() => setShowForm(false)}>取消</button><button type="button" className="button ghost" disabled={Boolean(busy) || !form.ip || !form.sshUser || (!editing && !form.secret)} onClick={() => void testSshConnection()}>{busy === "test-ssh" ? "测试中…" : "测试 SSH 连接"}</button><button className="button primary" disabled={Boolean(busy)}>{busy === "save-node" ? "保存中…" : editing ? "保存配置" : "添加并部署"}</button></div>
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

    {diagnosticNode && <Modal wide title={`${diagnosticNode.name} · 节点详情`} description="部署进度、操作日志、Agent 连通性和 VPN 协议运行状态。" onClose={closeDiagnostics}>
      <div className="diagnostic-toolbar"><span><i className="live-mark" /> 每 5 秒自动刷新</span><button className="button ghost small" disabled={diagnosticsBusy} onClick={() => void loadDiagnostics(diagnosticNode)}>立即刷新</button><button className="button ghost small" disabled={Boolean(busy)} onClick={() => void operate(diagnosticNode, "status-agent")}>检查 Agent</button><button className="button warning small" disabled={Boolean(busy)} onClick={() => void operate(diagnosticNode, "bootstrap")}>重新安装 / 修复</button></div>
      {diagnosticsBusy && !diagnostics ? <Empty>正在读取诊断信息…</Empty> : diagnostics && <div className="diagnostics">
        {diagnostics.actions[0] ? <section className={`current-job ${diagnostics.actions[0].status}`}>
          <div className="current-job-head"><div><p className="eyebrow">CURRENT / LATEST JOB</p><h3>{actionLabel(diagnostics.actions[0].action)}</h3><span>{phaseLabel(diagnostics.actions[0].current_phase)} · <Pill value={diagnostics.actions[0].status} /></span></div><time>{formatTime(diagnostics.actions[0].finished_at || diagnostics.actions[0].started_at || diagnostics.actions[0].created_at)}</time></div>
          <div className="job-progress"><i style={{ width: `${Math.min(Math.max(diagnostics.actions[0].progress || 0, 0), 100)}%` }} /><span>{diagnostics.actions[0].progress || 0}%</span></div>
          {diagnostics.actions[0].error && <pre className="job-error">{diagnostics.actions[0].error}</pre>}
        </section> : <InlineNotice notice={{ tone: "info", message: "该节点还没有部署或运维任务记录。" }} />}
        <div className="diagnostic-cards"><article><small>节点身份</small><b><Pill value={diagnostics.connectivity?.status || diagnosticNode.status} /></b><span title={diagnosticNode.node_identity || undefined}>{diagnosticNode.ip}{diagnosticNode.node_identity ? ` · ID …${diagnosticNode.node_identity.slice(-8)}` : " · 等待首次身份绑定"}</span></article><article><small>Agent 通道</small><b>{diagnostics.connectivity?.agentChannel || "unknown"}</b><span>{formatTime(diagnostics.connectivity?.lastAuthenticatedHeartbeat)}</span></article><article><small>防火墙</small><b>{diagnostics.connectivity?.firewall.manager || "unknown"}</b><span>{diagnostics.connectivity?.firewall.inputPolicy || "—"}</span></article><article><small>资源</small><b>{diagnosticNode.metrics ? `CPU ${diagnosticNode.metrics.cpuPercent.toFixed(0)}%` : "暂无指标"}</b><span>{diagnosticNode.metrics ? `内存 ${diagnosticNode.metrics.memory.percent.toFixed(0)}% · 网络 ↓ ${formatBytes(diagnosticNode.metrics.network.rxBytesPerSecond)}/s` : "等待心跳上报"}</span></article></div>
        {diagnostics.connectivity?.note && <div className="inline-notice info">{diagnostics.connectivity.note}</div>}
        <section className="deployment-log"><div className="diagnostic-section-head"><div><h3>部署与操作日志</h3><p>Controller 记录的 Bootstrap、Agent 和修复任务事件，最新事件在最上方。</p></div><span>{diagnostics.actionEvents.length} 条事件</span></div>{diagnostics.actionEvents.length ? <div className="event-list">{diagnostics.actionEvents.slice(0, 100).map((event) => <div key={event.id}><time>{formatTime(event.created_at)}</time><Pill value={event.level} /><span><b>{phaseLabel(event.phase)}</b>{event.message}</span></div>)}</div> : <Empty>还没有部署或操作日志。</Empty>}</section>
        <section><h3>VPN 协议运行状态</h3>{diagnostics.connectivity?.protocols.length ? <div className="protocol-grid">{diagnostics.connectivity.protocols.map((protocol) => <article key={protocol.protocol}><div><b>{protocol.protocol}</b><Pill value={protocol.state} /></div><small>{protocol.transport}:{protocol.port} · {protocol.listening ? "正在监听" : "未监听"} · runtime {protocol.runtimeActive ? "active" : "inactive"}</small><small>Host FW: {protocol.hostFirewall} · Cloud FW: {protocol.cloudFirewall}</small>{protocol.lastError && <p>{protocol.lastError}</p>}</article>)}</div> : <Empty>没有 Agent 协议状态。</Empty>}</section>
        <section><h3>配置同步任务</h3>{diagnostics.reconcile.tasks.length ? <div className="action-list">{diagnostics.reconcile.tasks.slice(0, 20).map((task) => <article key={task.id}><div><b>{task.protocol} · {task.taskType}</b><Pill value={task.status} /></div><small>revision {task.desiredRevision} · 尝试 {task.attempts} 次 · {formatTime(task.createdAt)}</small>{task.lastError && <p>{task.lastError}</p>}</article>)}</div> : <Empty>没有待处理的配置同步任务。</Empty>}</section>
        <section><h3>任务历史与原始输出</h3>{diagnostics.actions.length ? <div className="operation-history-list">{diagnostics.actions.map((action) => <details key={action.id} open={action.id === diagnostics.actions[0]?.id && action.status === "failed"}><summary><span><b>{actionLabel(action.action)}</b><small>{phaseLabel(action.current_phase)} · {action.progress || 0}%</small></span><Pill value={action.status} /><time>{formatTime(action.finished_at || action.started_at || action.created_at)}</time><i>⌄</i></summary><div>{action.error && <><b>错误</b><pre className="history-error">{action.error}</pre></>}{action.output && <><b>原始输出</b><pre>{action.output}</pre></>}{!action.error && !action.output && <p>该任务没有保存额外输出。</p>}</div></details>)}</div> : <Empty>没有历史任务。</Empty>}</section>
      </div>}
    </Modal>}
  </>;
}
