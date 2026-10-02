import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useConfirm } from "../confirm-dialog";
import type { DeploymentPolicyOverview, NodeRecord, VpnService } from "../types";
import { Empty, formatTime, InlineNotice, type Notice, PageHeader, Pill } from "./shared";

export function ServicesPage({ nodes }: { nodes: NodeRecord[] }) {
  const [services, setServices] = useState<VpnService[]>([]);
  const [policy, setPolicy] = useState<DeploymentPolicyOverview | null>(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [realityNode, setRealityNode] = useState("");
  const [serverName, setServerName] = useState("");
  const [realityPort, setRealityPort] = useState(443);
  const confirm = useConfirm();
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

  async function enableReality(event: React.FormEvent) {
    event.preventDefault();
    if (!await confirm({ title: "部署 VLESS + REALITY", message: "将下载校验过的 Xray 内核并部署新服务。请确保目标支持 TLS 1.3 / HTTP/2、端口未占用，并在云安全组放行 TCP 端口。已有服务不会自动迁移。", confirmLabel: "部署" })) return;
    setBusy("reality"); setNotice(null);
    try {
      await api(`/api/nodes/${realityNode}/services`, { method: "POST", body: JSON.stringify({ protocol: "vless", action: "enable", transport: "tcp", listenPort: realityPort, serverName }) });
      setNotice({ tone: "success", message: "已提交部署，请查看下方服务状态。旧 Agent 请先在节点运维中升级 Agent。" }); await refresh();
    } catch (e) { setNotice({ tone: "error", message: (e as Error).message }); } finally { setBusy(""); }
  }

  return <>
    <PageHeader eyebrow="VPN SERVICES" title="VPN 服务" description="管理每个节点的协议服务，并以灰度或批量方式修复 Standard 策略漂移。" actions={<button className="button ghost" onClick={() => void refresh()}>刷新</button>} />
    <InlineNotice notice={notice} />
    <p className="inline-notice info">这里仅管理 VPN 协议与策略，不更新 Agent 程序。Agent 升级请到“节点运维”。{policy && !policy.counts.eligibleNodes ? " 当前没有可同步的策略差异；离线或能力不足的节点需先恢复 Agent。" : ""}</p>
    <section className="panel"><div className="panel-head"><div><p className="eyebrow">SUBSCRIPTION PROTOCOL</p><h2>启用 VLESS + REALITY</h2><p>需 Agent 2.7+、Linux amd64/arm64。需显式启用；请选择空闲端口。启用后该节点按自定义策略管理。</p></div></div><form className="stack-form" onSubmit={enableReality}><label>节点<select required value={realityNode} onChange={(e) => setRealityNode(e.target.value)}><option value="">选择节点</option>{nodes.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}</select></label><label>REALITY 公网目标域名<input required value={serverName} onChange={(e) => setServerName(e.target.value)} placeholder="支持 TLS 1.3 / HTTP/2 的域名，不含 https://" /></label><label>TCP 监听端口<input type="number" min={1} max={65535} required value={realityPort} onChange={(e) => setRealityPort(Number(e.target.value))} /></label><p>目标会在节点上校验；无有效配置的节点可修正目标后重试；已有有效配置时不能直接更换目标。配置权限变化会重启此协议服务，现有连接可能短暂重连。</p><button className="button primary" disabled={Boolean(busy)}>部署新服务</button></form></section>
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
