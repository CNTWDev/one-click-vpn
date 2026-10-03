import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useConfirm } from "../confirm-dialog";
import type { DeploymentPolicyOverview, NodeRecord, VpnService } from "../types";
import { Empty, formatTime, InlineNotice, type Notice, PageHeader, Pill } from "./shared";
import { RealityTargetSetup, type RealityDefaults } from "./reality-target-setup";

export function ServicesPage({ nodes }: { nodes: NodeRecord[] }) {
  const [services, setServices] = useState<VpnService[]>([]);
  const [policy, setPolicy] = useState<DeploymentPolicyOverview | null>(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [editingService, setEditingService] = useState<VpnService | null>(null);
  const [serverName, setServerName] = useState("");
  const [realityPort, setRealityPort] = useState(443);
  const [defaults, setDefaults] = useState<RealityDefaults | null>(null);
  const confirm = useConfirm();
  const nodeMap = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);

  async function refresh() {
    try {
      const [serviceResult, policyResult, defaultResult] = await Promise.all([api<{ services: VpnService[] }>("/api/vpn-services"), api<DeploymentPolicyOverview>("/api/deployment-policy"), api<RealityDefaults>("/api/reality-defaults")]);
      setServices(serviceResult.services || []); setPolicy(policyResult); setDefaults(defaultResult);
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
  }
  useEffect(() => {
    void Promise.all([
      api<{ services: VpnService[] }>("/api/vpn-services"),
      api<DeploymentPolicyOverview>("/api/deployment-policy"),
      api<RealityDefaults>("/api/reality-defaults"),
    ]).then(([serviceResult, policyResult, defaultResult]) => {
      setServices(serviceResult.services || []); setPolicy(policyResult);
      setDefaults(defaultResult);
    }).catch((error: Error) => setNotice({ tone: "error", message: error.message }));
  }, []);

  async function serviceAction(service: VpnService, action: "enable" | "disable" | "restart" | "redeploy") {
    const actionLabel = { enable: "启用", disable: "停用", restart: "重启服务", redeploy: "重新部署" }[action];
    if (!await confirm({
      title: `${actionLabel} ${service.protocol}`,
      message: `确定对 ${nodeMap.get(service.node_id)?.name || service.node_id} 的 ${service.protocol} 执行“${actionLabel}”吗？`,
      confirmLabel: actionLabel,
      danger: action === "disable",
    })) return;
    const key = `${service.node_id}:${service.protocol}`; setBusy(key); setNotice(null);
    try {
      await api(`/api/nodes/${service.node_id}/services`, { method: "POST", body: JSON.stringify({ protocol: service.protocol, action }) });
      setNotice({ tone: "success", message: `${actionLabel}操作已提交，可在节点详情的配置同步任务中查看进度。` }); await refresh();
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
    finally { setBusy(""); }
  }

  async function rollout(mode: "canary" | "batch") {
    const label = mode === "canary" ? "单节点灰度" : "批量同步策略";
    if (!await confirm({
      title: `启动${label}`,
      message: `确定启动 Standard 策略${label}吗？只会处理状态可用且发生漂移的节点，不会升级 Agent。`,
      confirmLabel: `开始${label}`,
    })) return;
    setBusy(`rollout:${mode}`); setNotice(null);
    try {
      const result = await api<{ rollout: { totalTargets: number; queuedTargets: number; failedTargets: number } }>("/api/deployment-policy", { method: "POST", body: JSON.stringify({ mode, limit: 25 }) });
      setNotice({ tone: "success", message: `策略发布已创建：目标 ${result.rollout.totalTargets}，已排队 ${result.rollout.queuedTargets}，失败 ${result.rollout.failedTargets}。` }); await refresh();
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
    finally { setBusy(""); }
  }

  async function saveService(event: React.FormEvent) {
    event.preventDefault();
    if (!editingService) return;
    if (!await confirm({ title: "修改单节点协议配置", message: "此操作属于高级例外设置，会重新部署该协议，并将节点标记为自定义策略。修改端口后需重新获取客户端配置，已有连接可能短暂中断。", confirmLabel: "保存并部署" })) return;
    setBusy("service-settings"); setNotice(null);
    try {
      await api(`/api/nodes/${editingService.node_id}/services`, { method: "POST", body: JSON.stringify({ protocol: editingService.protocol, action: "redeploy", customize: true, listenPort: realityPort, ...(editingService.protocol === "vless" ? { serverName } : {}) }) });
      setNotice({ tone: "success", message: "单节点协议配置已提交，请查看服务同步状态。" }); await refresh();
    } catch (e) { setNotice({ tone: "error", message: (e as Error).message }); } finally { setBusy(""); }
  }

  return <>
    <PageHeader eyebrow="VPN SERVICES" title="VPN 服务" description="管理每个节点的协议服务，并以灰度或批量方式修复 Standard 策略漂移。" actions={<button className="button ghost" onClick={() => void refresh()}>刷新</button>} />
    <InlineNotice notice={notice} />
    <p className="inline-notice info">这里仅管理 VPN 协议与策略，不更新 Agent 程序。Agent 升级请到“节点运维”。{policy && !policy.counts.eligibleNodes ? policy.counts.driftedNodes ? " 有待补齐的协议，请先处理下方阻塞原因。" : " 当前标准节点已无策略差异。" : ""}</p>
    <p className="inline-notice info">标准模板自动部署 WireGuard、OpenVPN 和 VLESS，无需逐个协议启用。老标准节点可在“节点运维”重新安装 / 修复，或使用下方“批量同步策略”补齐。自定义及仅 Agent 节点不会被自动覆盖。默认需放行 UDP 51820、UDP 1194、TCP 443。</p>
    {defaults && <RealityTargetSetup key={defaults.serverName} defaults={defaults} onSaved={(value) => { setDefaults(value); void refresh(); }} />}
    <details className="panel"><summary>高级：单节点协议配置（通常无需修改）</summary>
      <form className="stack-form" onSubmit={saveService}>
        <label>协议服务<select required value={editingService ? `${editingService.node_id}:${editingService.protocol}` : ""} onChange={(event) => { const service = services.find((item) => `${item.node_id}:${item.protocol}` === event.target.value) || null; setEditingService(service); setRealityPort(service?.listen_port || 443); setServerName(""); }}><option value="">选择已有协议服务</option>{services.map((service) => <option key={`${service.node_id}:${service.protocol}`} value={`${service.node_id}:${service.protocol}`}>{nodeMap.get(service.node_id)?.name || service.node_id} · {service.protocol}</option>)}</select></label>
        {editingService && <><label>监听端口<input type="number" min={1} max={65535} required value={realityPort} onChange={(e) => setRealityPort(Number(e.target.value))} /></label>
          {editingService.protocol === "vless" && <label>覆盖目标域名<input maxLength={253} value={serverName} onChange={(e) => setServerName(e.target.value)} placeholder="留空保留已有目标或使用平台默认值" /></label>}
          <p>仅在端口冲突等特殊情况下修改；不会占用或关闭其他服务的端口。请同步调整安全组规则。已有有效 VLESS 配置不能直接更换目标。</p>
          <div><button className="button primary" disabled={Boolean(busy)}>保存并部署</button></div></>}
      </form>
    </details>
    {policy && <section className="policy-banner"><div><p className="eyebrow">STANDARD POLICY V{policy.standard.version}</p><h2>标准部署策略</h2><p>{policy.standard.protocols.map((item) => `${item.protocol} ${item.transport}:${item.listenPort}`).join(" · ") || "当前没有启用的标准协议"}</p></div><div className="policy-counts"><span><b>{policy.counts.standardNodes}</b>标准节点</span><span><b>{policy.counts.driftedNodes}</b>策略漂移</span><span><b>{policy.counts.blockedNodes}</b>暂不可更新</span></div><div className="policy-actions"><button className="button ghost" disabled={Boolean(busy) || !policy.counts.eligibleNodes} onClick={() => void rollout("canary")}>灰度 1 台</button><button className="button primary" disabled={Boolean(busy) || !policy.counts.eligibleNodes} onClick={() => void rollout("batch")}>批量同步策略</button></div></section>}
    {policy?.driftedNodes.length ? <section className="panel"><div className="panel-head"><div><p className="eyebrow">POLICY DRIFT</p><h2>待同步节点</h2></div></div><div className="compact-list">{policy.driftedNodes.map((node) => <div key={node.id}><span className={`state-dot ${node.eligible ? "online" : "attention"}`} /><span><b>{node.name}</b><small>缺少：{node.missingProtocols.join(", ") || "策略版本"} · {node.reason}</small></span><Pill value={node.eligible ? "eligible" : "blocked"} /></div>)}</div></section> : null}
    <section className="panel flush">
      <div className="table-wrap"><table className="action-table"><thead><tr><th>节点</th><th>协议</th><th>监听</th><th>服务状态</th><th>更新时间</th><th className="align-right">操作</th></tr></thead><tbody>{services.map((service) => <tr key={`${service.node_id}:${service.protocol}`}>
        <td><b>{nodeMap.get(service.node_id)?.name || service.node_id}</b><small>{nodeMap.get(service.node_id)?.ip}</small></td><td><b>{service.protocol}</b><small>{service.subnet}</small></td><td>{service.transport}:{service.listen_port}<small>DNS {service.dns.join(", ")}</small></td><td><Pill value={!service.enabled ? "disabled" : service.status} />{service.last_error && <small className="error-text">{service.last_error}</small>}</td><td>{formatTime(service.updated_at)}</td><td className="align-right"><span className="row-actions">{service.enabled ? <><button className="text-button danger-text" disabled={busy === `${service.node_id}:${service.protocol}`} onClick={() => void serviceAction(service, "disable")}>停用</button><button className="text-button" disabled={busy === `${service.node_id}:${service.protocol}`} onClick={() => void serviceAction(service, "restart")}>重启服务</button></> : <button className="text-button" disabled={busy === `${service.node_id}:${service.protocol}`} onClick={() => void serviceAction(service, "enable")}>启用</button>}<button className="text-button" disabled={busy === `${service.node_id}:${service.protocol}`} onClick={() => void serviceAction(service, "redeploy")}>重新部署 VPN</button></span></td>
      </tr>)}</tbody></table></div>{!services.length && <Empty>还没有 VPN 服务。部署节点后，服务会在此出现。</Empty>}
    </section>
    {policy?.rollouts.length ? <section className="panel"><div className="panel-head"><div><p className="eyebrow">ROLLOUT HISTORY</p><h2>策略发布记录</h2></div></div><div className="table-wrap"><table><thead><tr><th>时间</th><th>模式</th><th>版本</th><th>状态</th><th>结果</th></tr></thead><tbody>{policy.rollouts.map((rollout) => <tr key={rollout.id}><td>{formatTime(rollout.createdAt)}</td><td>{rollout.mode}</td><td>v{rollout.fromVersion} → v{rollout.toVersion}</td><td><Pill value={rollout.status} /></td><td>{rollout.succeededTargets} 成功 / {rollout.queuedTargets} 处理中 / {rollout.blockedTargets + rollout.failedTargets} 异常</td></tr>)}</tbody></table></div></section> : null}
  </>;
}
