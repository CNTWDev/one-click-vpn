import { consoleLanguage, t, useConsoleLanguage } from "../i18n";
/* eslint-disable react-hooks/set-state-in-effect */
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { api, networkErrorMessage } from "../api";
import { useConfirm } from "../confirm-dialog";
import { Icon } from "../icons";
import { setQuery, useQueryParam, useRoute } from "../router";
import { protocolName, statusLabel, statusTone } from "../status";
import { useToast } from "../toast";
import type { NodeDiagnostics, NodeRecord, Region } from "../types";
import { liveRate, NodeDiagnosticsView } from "./node-diagnostics";
import { BatchBar, Empty, formatBytes, formatRate, formatTime, includesText, InlineNotice, Menu, Meter, Modal, type Notice, PageHeader, Pill, StateDot, TableToolbar, Time } from "./shared";

/** Numeric dotted-version compare ("2.7.1" < "2.10.0"); non-numeric parts are ignored. */
function compareVersions(left: string, right: string): number {
  const a = left.match(/\d+/g)?.map(Number) || [], b = right.match(/\d+/g)?.map(Number) || [];
  for (let index = 0; index < Math.max(a.length, b.length); index++) if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0);
  return 0;
}

type NodeForm = {
  name: string; ip: string; regionId: string; sshUser: string; sshPort: string; secret: string;
  credentialType: "password" | "private_key"; sshPrivilegeMode: "root" | "sudo"; deploymentTemplate: string;
  /** New nodes: install with a one-time command on the server, or deploy over SSH from here. */
  method: "command" | "ssh"; forgetCredential: boolean;
};
type Install = { nodeName: string; command: string; expiresAt: string };
type NodeAction = "status-agent" | "restart-agent" | "upgrade-agent" | "bootstrap" | "delete";

/** Public-interface rate from the latest heartbeat; hidden once the heartbeat goes stale. */

const blankNodeForm: NodeForm = { name: "", ip: "", regionId: "", sshUser: "root", sshPort: "22", secret: "", credentialType: "password", sshPrivilegeMode: "root", deploymentTemplate: "standard", method: "command", forgetCredential: true };
const statusRank = { danger: 0, warning: 1, progress: 2, neutral: 3, success: 4 };


/** Names like "1.2.3.4@Singapore" wrap after the "@" before breaking inside a word. */
const breakAfterAt = (name: string) => name.split("@").flatMap((part, index) => index ? ["@", <wbr key={index} />, part] : [part]);
export function NodesPage({ nodes, regions, loading, onRefresh }: { nodes: NodeRecord[]; regions: Region[]; loading: boolean; onRefresh: () => Promise<void> }) {
  useConsoleLanguage();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [form, setForm] = useState<NodeForm>(blankNodeForm);
  const [initialForm, setInitialForm] = useState<NodeForm>(blankNodeForm);
  const [editing, setEditing] = useState<NodeRecord | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [formNotice, setFormNotice] = useState<Notice | null>(null);
  const [diagnosticNode, setDiagnosticNode] = useState<NodeRecord | null>(null);
  const [diagnostics, setDiagnostics] = useState<NodeDiagnostics | null>(null);
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false);
  // Id of the node whose diagnostics modal is open; responses for any other id (or after close) are stale.
  const diagnosticRequestRef = useRef<string | null>(null);
  const [testedFingerprint, setTestedFingerprint] = useState("");
  const [targetVersion, setTargetVersion] = useState("");
  const [batchResults, setBatchResults] = useState<Array<{ nodeId: string; status: string; reason?: string }>>([]);
  const [install, setInstall] = useState<Install | null>(null);
  const confirm = useConfirm();
  const toast = useToast();
  const { query } = useRoute();
  const focus = query.get("focus") || "";
  const [search, setSearch] = useQueryParam("q");
  const [filter, setFilter] = useQueryParam("filter", "all");
  const [sort, setSort] = useQueryParam("sort", "name");
  useEffect(() => {
    void api<{ version: string }>("/api/nodes/agent-release").then((result) => setTargetVersion(result.version))
      .catch((error: Error) => setNotice({ tone: "error", message: t("无法读取 Agent 目标版本：{0}", [error.message]) }));
  }, []);

  const needsUpgrade = (node: NodeRecord) => Boolean(targetVersion && node.version && node.version !== "unknown" && compareVersions(node.version, targetVersion) < 0);
  const matchers: Record<string, (node: NodeRecord) => boolean> = {
    all: () => true, online: (node) => node.status === "online", attention: (node) => node.status !== "online",
    offline: (node) => node.status === "offline", provisioning: (node) => node.status === "provisioning", upgrade: needsUpgrade,
  };
  const chips = [["all", t("全部")], ["online", t("在线")], ["attention", t("需关注")], ["offline", t("离线")], ["provisioning", t("部署中")], ["upgrade", t("需升级")]]
    .map(([value, label]) => ({ value, label, count: nodes.filter(matchers[value]).length }))
    .filter((chip) => chip.value === "all" || chip.value === filter || chip.count > 0);
  const regionName = useMemo(() => new Map(regions.map((region) => [region.id, region.name])), [regions]);
  const visible = nodes
    .filter((node) => (matchers[filter] || matchers.all)(node) && includesText(search, node.name, node.ip, node.place, regionName.get(node.region_id)))
    .sort((left, right) => sort === "status" ? statusRank[statusTone(left.status)] - statusRank[statusTone(right.status)] || left.name.localeCompare(right.name)
      : sort === "cpu" ? (right.metrics?.cpuPercent ?? -1) - (left.metrics?.cpuPercent ?? -1)
        : sort === "rate" ? (liveRate(right)?.tx ?? -1) - (liveRate(left)?.tx ?? -1)
        : sort === "traffic" ? (right.monthlyTraffic?.txBytes ?? -1) - (left.monthlyTraffic?.txBytes ?? -1)
        : sort === "region" ? (regionName.get(left.region_id) || "").localeCompare(regionName.get(right.region_id) || "") || left.name.localeCompare(right.name)
          : left.name.localeCompare(right.name, consoleLanguage.locale()));
  const visibleIds = new Set(visible.map((node) => node.id));
  const selectedIds = [...selected].filter((id) => visibleIds.has(id));
  // Results for nodes that no longer exist (deleted) are dropped instead of showing raw ids.
  const shownResults = batchResults.filter((result) => nodes.some((node) => node.id === result.nodeId));

  function openCreate() {
    const next = { ...blankNodeForm, regionId: regions[0]?.id || "" };
    setEditing(null); setForm(next); setInitialForm(next); setTestedFingerprint(""); setFormNotice(null); setShowForm(true);
  }

  function openEdit(node: NodeRecord) {
    const sshUser = node.ssh_user || "root";
    const next: NodeForm = { name: node.name, ip: node.ip, regionId: node.region_id || "", sshUser, sshPort: String(node.ssh_port || 22), secret: "", credentialType: node.credential_type === "private_key" ? "private_key" : "password", sshPrivilegeMode: node.ssh_privilege_mode === "sudo" || (node.ssh_privilege_mode === "auto" && sshUser !== "root") ? "sudo" : "root", deploymentTemplate: node.deployment_policy || "standard", method: "ssh", forgetCredential: false };
    setEditing(node); setForm(next); setInitialForm(next); setTestedFingerprint(""); setFormNotice(null); setShowForm(true);
  }

  async function saveNode(event: FormEvent) {
    event.preventDefault(); setBusy("save-node"); setFormNotice(null);
    try {
      const result = await api<{ install?: { command: string; expiresAt: string } }>(editing ? `/api/nodes/${editing.id}` : "/api/nodes", {
        method: editing ? "PATCH" : "POST",
        body: JSON.stringify({ ...form, sshPort: Number(form.sshPort) }),
      });
      setShowForm(false);
      if (result.install) setInstall({ nodeName: form.name, ...result.install });
      else toast(editing ? t("节点配置已保存。") : t("节点已创建，安全部署任务已加入队列。"));
      await onRefresh();
    } catch (error) { setFormNotice({ tone: "error", message: (error as Error).message }); }
    finally { setBusy(""); }
  }

  async function loadPrivateKey(file: File | undefined) {
    if (!file) return;
    if (file.size > 60 * 1024) { setFormNotice({ tone: "error", message: t("SSH 私钥文件不能超过 60 KB。") }); return; }
    let secret: string;
    try { secret = await file.text(); }
    catch { setFormNotice({ tone: "error", message: t("无法读取 SSH 私钥文件。") }); return; }
    setForm((current) => ({ ...current, credentialType: "private_key", secret }));
    setTestedFingerprint("");
  }

  async function testSshConnection() {
    setBusy("test-ssh"); setFormNotice(null); setTestedFingerprint("");
    try {
      const result = await api<{ ok: boolean; fingerprint: string; sshPrivilegeMode: "root" | "sudo" }>("/api/nodes/test-connection", {
        method: "POST",
        body: JSON.stringify({ ...form, nodeId: editing?.id, sshPort: Number(form.sshPort) }),
      });
      setTestedFingerprint(result.fingerprint);
      setFormNotice({ tone: "success", message: t("SSH 连接与{0}验证通过，主机指纹已自动读取。", [result.sshPrivilegeMode === "sudo" ? t("免密 sudo") : t("root 权限")]) });
    } catch (error) { setFormNotice({ tone: "error", message: (error as Error).message }); }
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

  // The URL (?focus=<id>) decides which node detail is open, so links, refresh and back/forward all work.
  const openDetail = (node: NodeRecord) => setQuery({ focus: node.id }, "push");
  const closeDetail = () => setQuery({ focus: null });
  useEffect(() => {
    if (!focus) { if (diagnosticRequestRef.current) closeDiagnostics(); return; }
    if (diagnosticRequestRef.current === focus) return;
    const node = nodes.find((item) => item.id === focus);
    if (node) void loadDiagnostics(node);
  }, [focus, nodes]);

  const diagnosticNodeId = diagnosticNode?.id;
  useEffect(() => {
    if (!diagnosticNodeId) return;
    const timer = window.setInterval(() => {
      void api<NodeDiagnostics>(`/api/nodes/${diagnosticNodeId}`).then((result) => {
        if (diagnosticRequestRef.current !== diagnosticNodeId) return;
        setDiagnostics(result);
        if (result.node) setDiagnosticNode(result.node);
        // The Controller answers again, so an earlier connection error no longer applies.
        setNotice((current) => current?.message === networkErrorMessage() ? null : current);
      }).catch(() => undefined);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [diagnosticNodeId]);

  async function showInstallCommand(node: NodeRecord) {
    setBusy(`${node.id}:install`); setNotice(null);
    try {
      const result = await api<{ install: { command: string; expiresAt: string } }>(`/api/nodes/${node.id}`, { method: "POST", body: JSON.stringify({ action: "install-command" }) });
      setInstall({ nodeName: node.name, ...result.install });
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
    finally { setBusy(""); }
  }

  async function clearCredential(node: NodeRecord) {
    if (!await confirm({ title: t("清除 SSH 凭据"), message: t("删除 Controller 保存的 {0} 的 SSH 密码或私钥。之后升级由 Agent 自己完成；重装或修复改用安装命令。", [node.name]), confirmLabel: t("清除") })) return;
    setBusy(`${node.id}:clear`); setNotice(null);
    try {
      await api(`/api/nodes/${node.id}`, { method: "POST", body: JSON.stringify({ action: "clear-credential" }) });
      toast(t("SSH 凭据已清除。")); await onRefresh();
      if (diagnosticRequestRef.current === node.id) await loadDiagnostics(node);
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
    finally { setBusy(""); }
  }

  async function operate(node: NodeRecord, action: NodeAction) {
    // Without a stored credential the node repairs itself from the install command.
    if (action === "bootstrap" && node.has_ssh_credential === false) { await showInstallCommand(node); return; }
    const descriptions = {
      "upgrade-agent": t("将 {0} 从 {1} 升级至 {2}。Agent 自己下载并校验新版本（旧版 Agent 通过 SSH 更新），90 秒内未上报会自动回滚，保留身份和 VPN 配置。", [node.name, node.version || t("未知版本"), targetVersion]),
      "restart-agent": t("确定重启 {0} 的 Agent 吗？短时间内会中断状态上报。", [node.name]),
      bootstrap: t("确定重新安装/修复 {0} 吗？这会重新部署 Agent，并为标准模板节点自动补齐缺少的协议（含 VLESS）。保留已有密钥和单节点配置；自定义模板不会被覆盖。", [node.name]),
      delete: t("将从 Controller 移除节点 {0}（{1}）。此操作不可撤销，且不会自动销毁云服务器。", [node.name, node.ip]),
      "status-agent": "",
    };
    const titles = { "upgrade-agent": t("升级 Agent"), "restart-agent": t("重启 Agent"), bootstrap: t("重新安装 / 修复"), delete: t("删除节点"), "status-agent": "" };
    if (action !== "status-agent" && !await confirm({
      title: titles[action],
      message: descriptions[action],
      confirmLabel: titles[action],
      danger: action === "delete",
      ...(action === "delete" ? { confirmText: node.name } : {}),
    })) return;
    setBusy(`${node.id}:${action}`); setNotice(null);
    try {
      if (action === "delete") await api(`/api/nodes/${node.id}`, { method: "DELETE" });
      else if (action === "bootstrap") await api(`/api/nodes/${node.id}`, { method: "POST", body: JSON.stringify({ action }) });
      else await api(`/api/nodes/${node.id}/actions`, { method: "POST", body: JSON.stringify({ action }) });
      toast(action === "delete" ? t("节点 {0} 已删除。", [node.name]) : t("操作已加入队列，可在节点详情中跟踪进度。"));
      if (action === "delete") {
        setSelected((current) => { const next = new Set(current); next.delete(node.id); return next; });
        if (diagnosticRequestRef.current === node.id) closeDetail();
      }
      await onRefresh();
      if (action !== "delete" && diagnosticRequestRef.current === node.id) await loadDiagnostics(node);
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
    finally { setBusy(""); }
  }

  async function batch(action: "status-agent" | "restart-agent" | "upgrade-agent" | "bootstrap") {
    const ids = selectedIds;
    if (!ids.length) return;
    const batchLabel = action === "upgrade-agent" ? t("升级 Agent 至 {0}", [targetVersion]) : action === "bootstrap" ? t("重新安装/修复") : action === "status-agent" ? t("检查 Agent") : t("重启 Agent");
    if (action !== "status-agent" && !await confirm({
      title: t("批量{0}", [batchLabel]),
      message: t("确定对选中的 {0} 个节点执行“{1}”吗？", [ids.length, batchLabel]),
      confirmLabel: t("确认执行"),
    })) return;
    setBusy(`batch:${action}`); setNotice(null); setBatchResults([]);
    try {
      const result = await api<{ accepted: string[]; skipped: string[]; queued: number; results: Array<{ nodeId: string; status: string; reason?: string }> }>("/api/nodes/batch-actions", { method: "POST", body: JSON.stringify({ action, nodeIds: ids }) });
      setBatchResults(result.results || []);
      toast(t("已加入队列 {0} 个，未提交 {1} 个；逐台结果见列表上方。", [result.queued, result.skipped.length]), result.skipped.length ? "info" : "success");
      setSelected(new Set(result.skipped)); await onRefresh();
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
    finally { setBusy(""); }
  }

  // Batch delete loops over the existing per-node DELETE endpoint.
  async function batchDelete() {
    const targets = nodes.filter((node) => selectedIds.includes(node.id));
    if (!targets.length || !await confirm({
      title: t("删除 {0} 个节点", [targets.length]),
      message: t("将从 Controller 移除：{0}。此操作不可撤销，且不会自动销毁云服务器。", [targets.map((node) => node.name).join("、")]),
      confirmLabel: t("永久删除"),
      danger: true,
      confirmText: t("删除 {0} 个节点", [targets.length]),
    })) return;
    setBusy("batch:delete"); setNotice(null);
    const failed: NodeRecord[] = [];
    const reasons: string[] = [];
    for (const node of targets) {
      try { await api(`/api/nodes/${node.id}`, { method: "DELETE" }); }
      catch (error) { failed.push(node); reasons.push(`${node.name}：${(error as Error).message}`); }
    }
    setSelected(new Set(failed.map((node) => node.id)));
    if (failed.length) setNotice({ tone: "error", message: t("{0} 个节点删除失败：{1}", [failed.length, reasons.join("；")]) });
    if (targets.length > failed.length) toast(t("已删除 {0} 个节点。", [targets.length - failed.length]));
    setBusy(""); await onRefresh();
  }

  function rowMenu(node: NodeRecord) {
    return <Menu label={t("{0} 的更多操作", [node.name])} items={[
      { label: t("编辑配置"), onSelect: () => openEdit(node) },
      { label: t("升级 Agent"), hint: needsUpgrade(node) ? `${node.version} → ${targetVersion}` : t("已是目标版本"), disabled: Boolean(busy) || !targetVersion, onSelect: () => void operate(node, "upgrade-agent") },
      { label: t("检查 Agent"), hint: t("只读，不重启服务"), disabled: Boolean(busy), onSelect: () => void operate(node, "status-agent") },
      { label: t("重启 Agent"), disabled: Boolean(busy), onSelect: () => void operate(node, "restart-agent") },
      { label: t("重新安装 / 修复"), hint: node.has_ssh_credential === false ? t("用安装命令") : undefined, disabled: Boolean(busy), onSelect: () => void operate(node, "bootstrap") },
      { label: t("安装命令"), hint: t("在节点上运行，1 小时内有效"), disabled: Boolean(busy), onSelect: () => void showInstallCommand(node) },
      ...(node.has_ssh_credential ? [{ label: t("清除 SSH 凭据"), disabled: Boolean(busy), onSelect: () => void clearCredential(node) }] : []),
      "divider",
      { label: t("删除节点"), danger: true, disabled: Boolean(busy), onSelect: () => void operate(node, "delete") },
    ]} />;
  }

  // One column keeps the table within 1440 px in every locale; the drawer shows the full in/out split.
  function trafficCell(node: NodeRecord) {
    const rate = liveRate(node);
    const traffic = node.monthlyTraffic;
    if (!rate && !traffic) return <span className="muted" title={needsUpgrade(node) ? t("升级 Agent 后显示") : t("等待心跳上报")}>—</span>;
    return <><b>{rate ? `↑ ${formatRate(rate.tx)}` : "—"}</b><small>{traffic ? t("本月 {0}", [formatBytes(traffic.txBytes)]) : "—"}</small></>;
  }

  function trafficTitle(node: NodeRecord) {
    const rate = liveRate(node);
    const traffic = node.monthlyTraffic;
    return [
      rate && t("近 30 秒：出 {0} · 入 {1}", [formatRate(rate.tx), formatRate(rate.rx)]),
      traffic && t("本月：出 {0} · 入 {1}（UTC 自然月，自 {2} 起）", [formatBytes(traffic.txBytes), formatBytes(traffic.rxBytes), formatTime(traffic.trackedSince)]),
    ].filter(Boolean).join("\n") || undefined;
  }

  const allSelected = visible.length > 0 && visible.every((node) => selected.has(node.id));
  const formDirty = showForm && JSON.stringify(form) !== JSON.stringify(initialForm);
  const byCommand = !editing && form.method === "command";
  return <>
    <PageHeader title={t("节点运维")} description={<>{t("部署、修复和诊断 Agent。Controller 当前提供 Agent")} <b className="mono">{targetVersion || "…"}</b>{t("，升级保留身份和 VPN 配置。")}</>} actions={<><button className="button ghost" onClick={() => void onRefresh()}><Icon name="refresh" size={16} />{t("刷新")}</button><button className="button primary" onClick={openCreate} disabled={!regions.length}><Icon name="plus" size={16} />{t("添加节点")}</button></>} />
    {!regions.length && <InlineNotice notice={{ tone: "info", message: t("添加节点前，请先在“区域管理”中创建至少一个区域。") }} />}
    <InlineNotice notice={notice} />
    {shownResults.length > 0 && <section className="panel result-panel"><div className="panel-head"><h2>{t("逐台提交结果")}</h2><button className="text-button" onClick={() => setBatchResults([])}>{t("关闭")}</button></div><div className="compact-list">{shownResults.map((result) => { const node = nodes.find((item) => item.id === result.nodeId)!; return <div key={result.nodeId}><StateDot value={result.reason ? "attention" : "queued"} /><span><b>{node.name}</b><small>{result.reason || t("已排队，不代表执行完成；请在详情中查看进度。")}</small></span><button className="button ghost small" onClick={() => openDetail(node)}>{t("查看进度")}</button></div>; })}</div></section>}
    <section className="panel flush table-panel">
      <TableToolbar search={search} onSearch={setSearch} placeholder={t("搜索名称、IP 或区域")} chips={chips} chip={filter} onChip={setFilter} sort={sort} onSort={setSort} sortOptions={[["name", t("名称")], ["status", t("状态（异常优先）")], ["cpu", t("CPU 负载")], ["rate", t("实时出站网速")], ["traffic", t("本月出站流量")], ["region", t("区域")]]} />
      <BatchBar count={selectedIds.length} unit={t("个节点")} onClear={() => setSelected(new Set())}>
        <button className="button primary small" disabled={Boolean(busy) || !targetVersion} onClick={() => void batch("upgrade-agent")}>{t("升级 Agent")}</button>
        <button className="button ghost small" disabled={Boolean(busy)} onClick={() => void batch("status-agent")}>{t("检查")}</button>
        <button className="button ghost small" disabled={Boolean(busy)} onClick={() => void batch("restart-agent")}>{t("重启")}</button>
        <button className="button ghost small" disabled={Boolean(busy)} onClick={() => void batch("bootstrap")}>{t("重新安装 / 修复")}</button>
        <button className="button danger small" disabled={Boolean(busy)} onClick={() => void batchDelete()}>{t("删除")}</button>
      </BatchBar>
      <div className="table-wrap"><table className="data-table cards node-table"><thead><tr><th className="check"><input type="checkbox" aria-label={t("选择全部节点")} checked={allSelected} onChange={(event) => setSelected(event.target.checked ? new Set(visible.map((node) => node.id)) : new Set())} /></th><th>{t("节点")}</th><th>{t("状态")}</th><th>Agent</th><th>{t("负载")}</th><th>{t("流量")}</th><th>{t("策略")}</th><th className="align-right">{t("操作")}</th></tr></thead><tbody>{visible.map((node) => <tr key={node.id} className={selected.has(node.id) ? "selected" : ""}>
        <td className="check"><input type="checkbox" aria-label={t("选择 {0}", [node.name])} checked={selected.has(node.id)} onChange={(event) => setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(node.id); else next.delete(node.id); return next; })} /></td>
        <td className="cell-main"><button className="node-detail-trigger" onClick={() => openDetail(node)}><StateDot value={node.status} /><span><b>{breakAfterAt(node.name)}</b><small>{node.ip} · {node.place}</small></span></button></td>
        <td className="cell-status"><Pill value={node.status} /><small>{node.latency} · {node.last_seen}</small></td>
        <td className="m-hide"><b className="mono">{node.version || "—"}</b>{needsUpgrade(node) ? <button className="upgrade-chip" disabled={Boolean(busy)} onClick={() => void operate(node, "upgrade-agent")} title={t("点击升级 Agent")}>{t("升级到 {0}", [targetVersion])}</button> : <small>{node.ssh_user || "root"}@{node.ssh_port || 22}</small>}</td>
        <td className="m-hide">{node.metrics ? <div className="meters"><Meter label="CPU" value={node.metrics.cpuPercent} /><Meter label={t("内存")} value={node.metrics.memory.percent} /><Meter label={t("磁盘")} value={node.metrics.disk.percent} /></div> : <span className="muted">{t("暂无指标")}</span>}</td>
        <td className="m-hide nowrap" title={trafficTitle(node)}>{trafficCell(node)}</td>
        <td className="m-hide"><b>{node.deployment_policy === "custom" ? t("自定义") : node.deployment_policy === "agent-only" ? t("仅 Agent") : node.deployment_policy === "standard" || !node.deployment_policy ? t("标准") : node.deployment_policy}</b><small>{t("策略 v")}{node.policy_version || 0}</small></td>
        <td className="align-right cell-actions"><div className="row-actions"><button className="button ghost small" onClick={() => openDetail(node)}>{node.status === "provisioning" ? t("部署进度") : t("详情")}</button>{rowMenu(node)}</div></td>
      </tr>)}</tbody></table></div>
      {!visible.length && (loading && !nodes.length ? <div className="skeleton-block" role="status" aria-label={t("正在加载节点")}><i /><i /><i /></div> : nodes.length ? <Empty action={<button className="button ghost" onClick={() => { setSearch(""); setFilter("all"); }}>{t("清除筛选")}</button>}>{t("没有符合条件的节点。")}</Empty> : <Empty action={regions.length ? <button className="button primary" onClick={openCreate}>{t("添加第一台节点")}</button> : <a className="button primary" href="#/regions">{t("先创建区域")}</a>}>{t("尚未部署节点。")}</Empty>)}
    </section>

    {showForm && <Modal title={editing ? t("编辑 {0}", [editing.name]) : t("添加节点")} description={editing ? t("留空凭据表示保持当前 SSH 凭据。") : byCommand ? t("在服务器上以 root 运行一行命令即可接入，Controller 不保存任何 SSH 凭据。") : t("节点会先验证 SSH 主机，再加入安全部署队列。")} onClose={() => setShowForm(false)} dirty={formDirty}
      footer={<><InlineNotice notice={formNotice} /><div className="form-actions">{!byCommand && <button type="button" className="button ghost" disabled={Boolean(busy) || !form.ip || !form.sshUser || (!editing && !form.secret)} onClick={() => void testSshConnection()}>{busy === "test-ssh" ? t("测试中…") : t("测试 SSH 连接")}</button>}<span className="grow" /><button type="button" className="button ghost" disabled={busy === "save-node"} onClick={() => setShowForm(false)}>{t("取消")}</button><button type="submit" form="node-form" className="button primary" disabled={Boolean(busy)}>{busy === "save-node" ? t("保存中…") : editing ? t("保存配置") : byCommand ? t("生成安装命令") : t("添加并部署")}</button></div></>}>
      <form id="node-form" className="form-grid" onSubmit={saveNode}>
        {!editing && <div className="tabs span-2" role="radiogroup" aria-label={t("接入方式")}>{([["command", t("安装命令（推荐）")], ["ssh", t("SSH 部署")]] as const).map(([value, label]) => <button key={value} type="button" role="radio" aria-checked={form.method === value} className={form.method === value ? "active" : ""} onClick={() => setForm({ ...form, method: value })}>{label}</button>)}</div>}
        <label className="span-2">{t("节点名称")}<input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Tokyo Edge" /></label>
        <label>{t("公网 IPv4")}<input required value={form.ip} onChange={(event) => { setForm({ ...form, ip: event.target.value }); setTestedFingerprint(""); }} placeholder="203.0.113.10" /></label>
        <label>{t("区域")}<select required value={form.regionId} onChange={(event) => setForm({ ...form, regionId: event.target.value })}><option value="">{t("选择区域")}</option>{regions.map((region) => <option key={region.id} value={region.id}>{region.name} · {region.country}</option>)}</select></label>
        {!byCommand && <>
        <label>{t("SSH 用户")}<input required value={form.sshUser} onChange={(event) => { setForm({ ...form, sshUser: event.target.value }); setTestedFingerprint(""); }} /></label>
        <label>{t("SSH 端口")}<input required type="number" min="1" max="65535" value={form.sshPort} onChange={(event) => { setForm({ ...form, sshPort: event.target.value }); setTestedFingerprint(""); }} /></label>
        <label>{t("凭据类型")}<select value={form.credentialType} onChange={(event) => { setForm({ ...form, credentialType: event.target.value as NodeForm["credentialType"], secret: "" }); setTestedFingerprint(""); }}><option value="password">{t("SSH 密码")}</option><option value="private_key">{t("SSH 私钥")}</option></select></label>
        <label>{t("远程权限")}<select value={form.sshPrivilegeMode} onChange={(event) => { setForm({ ...form, sshPrivilegeMode: event.target.value as NodeForm["sshPrivilegeMode"] }); setTestedFingerprint(""); }}><option value="root">{t("直接使用 root")}</option><option value="sudo">{t("非 root + 免密 sudo")}</option></select><small>{form.sshPrivilegeMode === "sudo" ? t("适合 ubuntu、ec2-user、debian 等云主机账号。") : t("SSH 登录账号必须具有 uid 0。")}</small></label>
        </>}
        {!editing && <label className="span-2">{t("部署模板")}<select value={form.deploymentTemplate} onChange={(event) => setForm({ ...form, deploymentTemplate: event.target.value })}><option value="standard">{t("标准：全部可用协议（推荐）")}</option><option value="wireguard">{t("仅 WireGuard")}</option><option value="openvpn">{t("仅 OpenVPN")}</option><option value="agent-only">{t("仅 Agent")}</option></select><small>{t("标准模板自动部署 WireGuard、OpenVPN、VLESS 和抗封锁通道。REALITY 目标只需在平台配置一次；未配置时其他协议仍可正常部署。")}</small></label>}
        {!byCommand && <>
        <label className="span-2 credential-input">{editing ? t("新凭据（可留空）") : t("SSH 凭据")}{form.credentialType === "private_key" && <span className="credential-file"><input type="file" accept=".pem,.key,text/plain" onChange={(event) => void loadPrivateKey(event.target.files?.[0])} /><em>{t("选择 .pem / .key 文件")}</em></span>}<textarea required={!editing} rows={form.credentialType === "private_key" ? 7 : 2} value={form.secret} onChange={(event) => { setForm({ ...form, secret: event.target.value }); setTestedFingerprint(""); }} autoComplete="new-password" placeholder={form.credentialType === "private_key" ? t("粘贴 OpenSSH、RSA、EC 或 PKCS#8 私钥") : t("输入 SSH 密码")} /><small>{form.credentialType === "private_key" ? t("私钥会在 Controller 使用主密钥加密；暂不支持带口令的私钥。") : t("密码会加密保存，仅用于节点安装和应急修复。")}</small></label>
        <div className="fingerprint-field span-2"><div className="fingerprint-label"><label>{t("服务器身份自动识别")}</label></div><aside className="fingerprint-guide"><b>{t("无需手工生成或填写指纹")}</b><p>{t("添加时，Controller 会通过 SSH 自动读取并固定主机公钥，同时在服务器上读取或生成持久的 TrackNothing 节点 ID。发现重复节点、复用的 SSH host key 或重复 IP/端口时会停止部署。")}</p><small>{t("首次连接采用 TOFU；后续部署和修复必须匹配已固定的主机指纹与节点 ID。")}</small></aside>{testedFingerprint && <div className="ssh-test-result"><b>{t("本次连接读取到的 SSH 指纹")}</b><code>{testedFingerprint}</code><small>{t("保存节点时会重新连接、登记节点 ID，并执行去重检查。")}</small></div>}</div>
        {!editing && <label className="check-line span-2"><input type="checkbox" checked={form.forgetCredential} onChange={(event) => setForm({ ...form, forgetCredential: event.target.checked })} />{t("部署成功后删除 SSH 凭据（推荐，之后由 Agent 自己升级）")}</label>}
        </>}
      </form>
    </Modal>}

    {install && <Modal title={t("{0} · 安装命令", [install.nodeName])} description={t("用 root 在节点上运行（非 root 账号把 | sh 换成 | sudo sh）。命令只能用一次，{0}前有效。", [formatTime(install.expiresAt)])} onClose={() => setInstall(null)}
      footer={<div className="form-actions"><span className="grow" /><button type="button" className="button ghost" onClick={() => setInstall(null)}>{t("关闭")}</button><button type="button" className="button primary" onClick={() => void navigator.clipboard.writeText(install.command).then(() => toast(t("已复制安装命令。")), () => toast(t("无法复制，请手动选择命令。"), "info"))}><Icon name="copy" size={16} />{t("复制命令")}</button></div>}>
      <pre className="install-command"><code>{install.command}</code></pre>
      <p className="form-note">{t("运行后节点自动安装 Agent 并出现在列表中，部署进度可在节点详情查看。需要能访问本 Controller 的 HTTPS 域名，不需要开放 SSH。")}</p>
    </Modal>}

    {diagnosticNode && <Modal wide title={t("{0} · 节点详情", [diagnosticNode.name])} description={`${diagnosticNode.ip} · ${diagnosticNode.place} · ${diagnosticNode.version || "—"}`} onClose={closeDetail}>
      <InlineNotice notice={notice} />
      <div className="diagnostic-toolbar"><span><i className="live-mark" />{t("每 5 秒自动刷新")}</span><button className="button ghost small" disabled={Boolean(busy)} onClick={() => void operate(diagnosticNode, "status-agent")}>{t("检查 Agent")}</button><button className="button ghost small" disabled={Boolean(busy)} onClick={() => void operate(diagnosticNode, "bootstrap")}>{t("重新安装 / 修复")}</button><button className="button ghost small" disabled={Boolean(busy)} onClick={() => void showInstallCommand(diagnosticNode)}>{t("安装命令")}</button>{diagnosticNode.has_ssh_credential && <button className="button ghost small" disabled={Boolean(busy)} onClick={() => void clearCredential(diagnosticNode)}>{t("清除 SSH 凭据")}</button>}{needsUpgrade(diagnosticNode) && <button className="button primary small" disabled={Boolean(busy) || !targetVersion} onClick={() => void operate(diagnosticNode, "upgrade-agent")}>{t("升级 Agent 至 {0}", [targetVersion])}</button>}</div>
      {diagnosticsBusy && !diagnostics ? <div className="skeleton-block" role="status" aria-label={t("正在读取诊断信息")}><i /><i /><i /></div> : diagnostics && <NodeDiagnosticsView node={diagnosticNode} diagnostics={diagnostics} outdated={needsUpgrade(diagnosticNode)} />}
    </Modal>}
  </>;
}
