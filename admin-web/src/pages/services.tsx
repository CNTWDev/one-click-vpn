import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useConfirm } from "../confirm-dialog";
import { Icon } from "../icons";
import { href, useQueryParam } from "../router";
import { protocolName, statusLabel, statusTone, type Tone, worstTone } from "../status";
import { useToast } from "../toast";
import type { DeploymentPolicyOverview, NodeRecord, VpnService } from "../types";
import { BatchBar, Empty, includesText, InlineNotice, Menu, Modal, type Notice, PageHeader, Pill, StateDot, TableToolbar, Time } from "./shared";
import { normalizeRealityDefaults, RealityTargetSetup, type RealityDefaults } from "./reality-target-setup";

type ServiceAction = "enable" | "disable" | "restart" | "redeploy";
const actionLabels: Record<ServiceAction, string> = { enable: "启用", disable: "停用", restart: "重启服务", redeploy: "重新部署" };
const serviceTone = (service: VpnService): Tone => service.enabled ? statusTone(service.status) : "neutral";
const serviceLabel = (service: VpnService) => service.enabled ? statusLabel(service.status) : "已停用";
const toneGroups: Record<string, (tone: Tone) => boolean> = { all: () => true, healthy: (tone) => tone === "success", progress: (tone) => tone === "progress", issue: (tone) => tone === "warning" || tone === "danger" };
const toneRank: Record<Tone, number> = { danger: 0, warning: 1, progress: 2, neutral: 3, success: 4 };

export function ServicesPage({ nodes }: { nodes: NodeRecord[] }) {
  const [services, setServices] = useState<VpnService[]>([]);
  const [policy, setPolicy] = useState<DeploymentPolicyOverview | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [editingService, setEditingService] = useState<VpnService | null>(null);
  const [serverName, setServerName] = useState("");
  const [servicePort, setServicePort] = useState(443);
  const [defaults, setDefaults] = useState<RealityDefaults | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tab, setTab] = useQueryParam("tab", "status");
  const [search, setSearch] = useQueryParam("q");
  const [filter, setFilter] = useQueryParam("filter", "all");
  const [sort, setSort] = useQueryParam("sort", "name");
  const confirm = useConfirm();
  const toast = useToast();
  const nodeMap = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);

  async function load() {
    const [serviceResult, policyResult, defaultResult] = await Promise.all([api<{ services: VpnService[] }>("/api/vpn-services"), api<DeploymentPolicyOverview>("/api/deployment-policy"), api<RealityDefaults>("/api/reality-defaults")]);
    return { services: serviceResult.services || [], policy: policyResult, defaults: normalizeRealityDefaults(defaultResult) };
  }
  async function refresh() {
    try { const result = await load(); setServices(result.services); setPolicy(result.policy); setDefaults(result.defaults); setNotice(null); }
    catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
  }
  useEffect(() => {
    void load().then((result) => { setServices(result.services); setPolicy(result.policy); setDefaults(result.defaults); })
      .catch((error: Error) => setNotice({ tone: "error", message: error.message })).finally(() => setLoaded(true));
  }, []);

  // One row per node; each protocol becomes a badge coloured by its state.
  const rows = useMemo(() => {
    const grouped = new Map<string, VpnService[]>();
    for (const service of services) grouped.set(service.node_id, [...(grouped.get(service.node_id) || []), service]);
    return [...grouped.entries()].map(([nodeId, items]) => {
      const node = nodeMap.get(nodeId);
      const order = ["wireguard", "openvpn", "vless"];
      items.sort((left, right) => (order.indexOf(left.protocol) + 99) % 99 - (order.indexOf(right.protocol) + 99) % 99);
      return { nodeId, name: node?.name || nodeId, ip: node?.ip || "", place: node?.place || "", services: items, tone: worstTone(items.map(serviceTone)), updatedAt: items.map((item) => item.updated_at).sort().at(-1) || null };
    });
  }, [services, nodeMap]);
  const chips = [["all", "全部"], ["healthy", "正常"], ["progress", "进行中"], ["issue", "需关注"]].map(([value, label]) => ({ value, label, count: rows.filter((row) => toneGroups[value](row.tone)).length }));
  const visible = rows.filter((row) => (toneGroups[filter] || toneGroups.all)(row.tone) && includesText(search, row.name, row.ip, row.place))
    .sort((left, right) => sort === "status" ? toneRank[left.tone] - toneRank[right.tone] || left.name.localeCompare(right.name) : left.name.localeCompare(right.name, "zh-CN"));
  const selectedRows = visible.filter((row) => selected.has(row.nodeId));

  async function serviceAction(service: VpnService, action: ServiceAction) {
    const label = actionLabels[action];
    if (!await confirm({
      title: `${label} ${protocolName(service.protocol)}`,
      message: `确定对 ${nodeMap.get(service.node_id)?.name || service.node_id} 的 ${protocolName(service.protocol)} 执行“${label}”吗？${action === "disable" ? "使用该协议的客户端将无法连接此节点。" : ""}`,
      confirmLabel: label,
      danger: action === "disable",
    })) return;
    const key = `${service.node_id}:${service.protocol}`; setBusy(key); setNotice(null);
    try {
      await api(`/api/nodes/${service.node_id}/services`, { method: "POST", body: JSON.stringify({ protocol: service.protocol, action }) });
      toast(`${label}操作已提交，可在节点详情的配置同步任务中查看进度。`); await refresh();
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
    finally { setBusy(""); }
  }

  // Batch restart / redeploy loops over the existing per-protocol endpoint for every enabled service on the chosen nodes.
  async function batchServices(action: "restart" | "redeploy", targets = selectedRows) {
    const items = targets.flatMap((row) => row.services.filter((service) => service.enabled));
    if (!items.length) { toast("所选节点没有已启用的协议。", "info"); return; }
    if (!await confirm({ title: `批量${actionLabels[action]}`, message: `将对 ${targets.length} 个节点上的 ${items.length} 个已启用协议执行“${actionLabels[action]}”。${action === "redeploy" ? "重新部署期间相关连接可能短暂中断。" : ""}`, confirmLabel: "确认执行" })) return;
    setBusy(`batch:${action}`); setNotice(null);
    const failures: string[] = [];
    for (const service of items) {
      try { await api(`/api/nodes/${service.node_id}/services`, { method: "POST", body: JSON.stringify({ protocol: service.protocol, action }) }); }
      catch (error) { failures.push(`${nodeMap.get(service.node_id)?.name || service.node_id} · ${protocolName(service.protocol)}：${(error as Error).message}`); }
    }
    if (failures.length) setNotice({ tone: "error", message: `${failures.length} 项提交失败：${failures.join("；")}` });
    if (items.length > failures.length) toast(`已提交 ${items.length - failures.length} 项${actionLabels[action]}，可在节点详情中查看进度。`);
    setSelected(new Set()); setBusy(""); await refresh();
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
      toast(`策略发布已创建：目标 ${result.rollout.totalTargets}，已排队 ${result.rollout.queuedTargets}，失败 ${result.rollout.failedTargets}。`); await refresh();
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
    finally { setBusy(""); }
  }

  function openAdvanced(service: VpnService) { setEditingService(service); setServicePort(service.listen_port || 443); setServerName(""); setNotice(null); }
  async function saveService(event: React.FormEvent) {
    event.preventDefault();
    if (!editingService) return;
    const vless = editingService.protocol === "vless";
    if (!await confirm({
      title: "修改单节点协议配置",
      message: `仅覆盖 ${nodeMap.get(editingService.node_id)?.name || editingService.node_id} 上 ${protocolName(editingService.protocol)} 的${vless ? "端口 / 目标" : "端口"}，节点的部署策略保持不变。保存后会重新部署该协议；修改端口后客户端需刷新订阅或重新获取配置。${vless ? "更换 VLESS 目标为平滑切换：旧 SNI 在过渡期内仍然有效，客户端下次刷新订阅时自动使用新目标。" : ""}`,
      confirmLabel: "保存并部署",
    })) return;
    setBusy("service-settings"); setNotice(null);
    try {
      await api(`/api/nodes/${editingService.node_id}/services`, { method: "POST", body: JSON.stringify({ protocol: editingService.protocol, action: "redeploy", customize: true, listenPort: servicePort, ...(vless ? { serverName } : {}) }) });
      setEditingService(null); toast("单节点协议配置已提交，请查看服务同步状态。"); await refresh();
    } catch (e) { setNotice({ tone: "error", message: (e as Error).message }); } finally { setBusy(""); }
  }

  function badge(service: VpnService) {
    const key = `${service.node_id}:${service.protocol}`;
    return <Menu key={service.protocol} triggerClassName={`proto-badge tone-${serviceTone(service)}`} trigger={<><i />{protocolName(service.protocol)}<small>{serviceLabel(service)}</small></>}
      header={<><b>{protocolName(service.protocol)} · {nodeMap.get(service.node_id)?.name || service.node_id}</b><small>{service.transport}:{service.listen_port}{service.subnet && service.subnet !== "—" ? ` · ${service.subnet}` : ""} · <Pill value={service.enabled ? service.status : "disabled"} /></small>{service.last_error && <small className="error-text">{service.last_error}</small>}</>}
      items={[
        ...(service.enabled ? [{ label: "重启服务", disabled: busy === key, onSelect: () => void serviceAction(service, "restart") }] : []),
        { label: "重新部署", disabled: busy === key, onSelect: () => void serviceAction(service, "redeploy") },
        { label: "高级设置", hint: "端口 / 目标覆盖", onSelect: () => openAdvanced(service) },
        "divider",
        service.enabled ? { label: "停用协议", danger: true, disabled: busy === key, onSelect: () => void serviceAction(service, "disable") } : { label: "启用协议", disabled: busy === key, onSelect: () => void serviceAction(service, "enable") },
      ]} />;
  }

  const allSelected = visible.length > 0 && visible.every((row) => selected.has(row.nodeId));
  const tabs: Array<[string, string, string?]> = [["status", "服务状态", String(rows.length)], ["policy", "策略发布", policy?.counts.driftedNodes ? String(policy.counts.driftedNodes) : undefined], ["reality", "REALITY 设置", defaults ? defaults.mode === "auto" ? "自动" : "自定义" : undefined]];
  return <>
    <PageHeader title="VPN 服务" description="管理各节点的协议服务与标准部署策略。Agent 程序升级请到“节点运维”。" actions={<button className="button ghost" onClick={() => void refresh()}><Icon name="refresh" size={16} />刷新</button>} />
    <div className="tabs" role="tablist" aria-label="VPN 服务">{tabs.map(([value, label, badgeText]) => <button key={value} role="tab" aria-selected={tab === value} className={tab === value ? "active" : ""} onClick={() => setTab(value)}>{label}{badgeText && <em>{badgeText}</em>}</button>)}</div>
    {!editingService && <InlineNotice notice={notice} onRetry={notice?.tone === "error" ? () => void refresh() : undefined} />}

    {tab === "status" && <section className="panel flush table-panel">
      <TableToolbar search={search} onSearch={setSearch} placeholder="搜索节点名称或 IP" chips={chips} chip={filter} onChip={setFilter} sort={sort} onSort={setSort} sortOptions={[["name", "节点名称"], ["status", "状态（异常优先）"]]} />
      <BatchBar count={selectedRows.length} unit="个节点" onClear={() => setSelected(new Set())}>
        <button className="button ghost small" disabled={Boolean(busy)} onClick={() => void batchServices("restart")}>批量重启</button>
        <button className="button primary small" disabled={Boolean(busy)} onClick={() => void batchServices("redeploy")}>批量重新部署</button>
      </BatchBar>
      <div className="table-wrap"><table className="data-table service-table"><thead><tr><th className="check"><input type="checkbox" aria-label="选择全部节点" checked={allSelected} onChange={(event) => setSelected(event.target.checked ? new Set(visible.map((row) => row.nodeId)) : new Set())} /></th><th>节点</th><th>协议（点击徽标操作）</th><th>更新时间</th><th className="align-right">操作</th></tr></thead><tbody>{visible.map((row) => <tr key={row.nodeId} className={selected.has(row.nodeId) ? "selected" : ""}>
        <td className="check"><input type="checkbox" aria-label={`选择 ${row.name}`} checked={selected.has(row.nodeId)} onChange={(event) => setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(row.nodeId); else next.delete(row.nodeId); return next; })} /></td>
        <td className="cell-main"><a className="node-detail-trigger" href={href("nodes", { focus: row.nodeId })}><StateDot tone={row.tone} /><span><b>{row.name}</b><small>{row.ip}{row.place ? ` · ${row.place}` : ""}</small></span></a></td>
        <td className="cell-status"><div className="badge-row">{row.services.map(badge)}</div>{row.services.filter((item) => item.enabled && item.last_error).slice(0, 1).map((item) => <small key={item.protocol} className="error-text">{protocolName(item.protocol)}：{item.last_error}</small>)}</td>
        <td className="m-hide"><Time value={row.updatedAt} /></td>
        <td className="align-right cell-actions"><div className="row-actions"><a className="button ghost small" href={href("nodes", { focus: row.nodeId })}>节点详情</a><Menu label={`${row.name} 的更多操作`} items={[
          { label: "重启全部协议", disabled: Boolean(busy), onSelect: () => void batchServices("restart", [row]) },
          { label: "重新部署全部协议", disabled: Boolean(busy), onSelect: () => void batchServices("redeploy", [row]) },
        ]} /></div></td>
      </tr>)}</tbody></table></div>
      {!visible.length && (!loaded ? <div className="skeleton-block" role="status" aria-label="正在加载服务"><i /><i /><i /></div> : rows.length ? <Empty action={<button className="button ghost" onClick={() => { setSearch(""); setFilter("all"); }}>清除筛选</button>}>没有符合条件的节点。</Empty> : <Empty action={<a className="button primary" href={href("nodes")}>前往节点运维</a>}>还没有 VPN 服务。部署节点后，服务会在此出现。</Empty>)}
    </section>}

    {tab === "policy" && <>
      <InlineNotice notice={{ tone: "info", message: "标准模板自动部署 WireGuard、OpenVPN 和 VLESS，无需逐个协议启用；老标准节点可用“批量同步策略”补齐。自定义及仅 Agent 节点不会被自动覆盖。默认需放行 UDP 51820、UDP 1194、TCP 443。" }} />
      {policy ? <section className="policy-banner"><div><p className="eyebrow">Standard 策略 v{policy.standard.version}</p><h2>标准部署策略</h2><p>{policy.standard.protocols.map((item) => `${protocolName(item.protocol)} ${item.transport}:${item.listenPort}`).join(" · ") || "当前没有启用的标准协议"}</p></div><div className="policy-counts"><span><b>{policy.counts.standardNodes}</b>标准节点</span><span><b>{policy.counts.driftedNodes}</b>策略漂移</span><span><b>{policy.counts.blockedNodes}</b>暂不可更新</span></div><div className="policy-actions"><button className="button ghost" disabled={Boolean(busy) || !policy.counts.eligibleNodes} onClick={() => void rollout("canary")}>灰度 1 台</button><button className="button primary" disabled={Boolean(busy) || !policy.counts.eligibleNodes} onClick={() => void rollout("batch")}>批量同步策略</button></div></section> : loaded ? null : <div className="skeleton-block" role="status"><i /><i /></div>}
      {policy && <section className="panel"><div className="panel-head"><h2>待同步节点</h2><span className="count-badge">{policy.driftedNodes.length}</span></div>{policy.driftedNodes.length ? <div className="compact-list">{policy.driftedNodes.map((node) => <a key={node.id} href={href("nodes", { focus: node.id })}><StateDot tone={node.eligible ? "progress" : "warning"} /><span><b>{node.name}</b><small>缺少：{node.missingProtocols.map(protocolName).join("、") || "策略版本"} · {node.reason}</small></span><Pill value={node.eligible ? "eligible" : "blocked"} /></a>)}</div> : <Empty>当前标准节点已无策略差异。</Empty>}</section>}
      {policy?.rollouts.length ? <section className="panel flush"><div className="panel-head padded"><h2>策略发布记录</h2></div><div className="table-wrap"><table className="data-table"><thead><tr><th>时间</th><th>模式</th><th>版本</th><th>状态</th><th>结果</th></tr></thead><tbody>{policy.rollouts.map((item) => <tr key={item.id}><td><Time value={item.createdAt} /></td><td>{item.mode === "canary" ? "灰度" : item.mode === "batch" ? "批量" : item.mode}</td><td>v{item.fromVersion} → v{item.toVersion}</td><td><Pill value={item.status} /></td><td>{item.succeededTargets} 成功 / {item.queuedTargets} 处理中 / {item.blockedTargets + item.failedTargets} 异常</td></tr>)}</tbody></table></div></section> : null}
    </>}

    {tab === "reality" && (defaults ? <RealityTargetSetup key={`${defaults.mode}:${defaults.serverName}`} defaults={defaults} onSaved={(value) => { setDefaults(value); void refresh(); }} /> : !loaded && <div className="skeleton-block" role="status"><i /><i /></div>)}

    {editingService && <Modal title={`${protocolName(editingService.protocol)} · 单节点高级设置`} description={`${nodeMap.get(editingService.node_id)?.name || editingService.node_id} · 仅覆盖此节点上该协议的设置，通常无需修改。`} onClose={() => setEditingService(null)} dirty={servicePort !== (editingService.listen_port || 443) || Boolean(serverName)}
      footer={<><InlineNotice notice={notice} /><div className="form-actions"><button type="button" className="button ghost" onClick={() => setEditingService(null)}>取消</button><button type="submit" form="service-form" className="button primary" disabled={Boolean(busy)}>{busy === "service-settings" ? "提交中…" : "保存并部署"}</button></div></>}>
      <form id="service-form" className="stack-form" onSubmit={saveService}>
        <label>监听端口<input type="number" min={1} max={65535} required value={servicePort} onChange={(e) => setServicePort(Number(e.target.value))} /><small>仅在端口冲突等特殊情况下修改；不会占用或关闭其他服务的端口。请同步调整安全组规则。</small></label>
        {editingService.protocol === "vless" && <label>覆盖目标域名<input maxLength={253} value={serverName} onChange={(e) => setServerName(e.target.value)} placeholder="留空保留当前目标" /><small>更换目标为平滑切换：旧 SNI 在过渡期内仍然有效，客户端下次刷新订阅时自动使用新目标。</small></label>}
        <p className="form-note">只影响这一个节点上的 {protocolName(editingService.protocol)}，不会把节点切换为自定义部署策略。</p>
      </form>
    </Modal>}
  </>;
}
