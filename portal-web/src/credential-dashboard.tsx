import { useEffect, useMemo, useState } from "react";
import { x25519 } from "@noble/curves/ed25519.js";
import { useActionDialog } from "./action-dialog";
import { clientOptions, clientProtocol, clientFormat, clientName, usableCredential, type ClientChoice } from "./client-options";
import { RegionMap } from "./region-map";
import { createZipBlob } from "./zip";

type User = { email: string; displayName: string };
type Region = { id: string; name: string; country: string; code: string; protocols: string[]; status: string; protocolNodeCounts?: Record<string, number> };
type Profile = { id: string; credentialId?: string | null; displayName?: string | null; nodeName?: string | null; regionalNodeCount?: number; regionCode?: string | null; regionName?: string | null; protocol: string; status: string; issuedAt: string; expiresAt: string };
type Credential = {
  expiringSoon: boolean; daysRemaining: number | null;
  userDisabled: boolean; adminDisabled: boolean; accountStatus: string; syncStatus: string;
  id: string; name: string; protocol: string; status: string; state: string; identitySuffix: string;
  online: boolean; connectionCount: number; lastActivityAt?: string | null; lastObservedAt?: string | null;
  profileCount: number; activeProfileCount: number; uploadBytes: number; downloadBytes: number; totalBytes: number;
  expiresAt?: string | null; revokedAt?: string | null; createdAt: string; updatedAt: string;
  certificate?: { id: string; serial?: string | null; subject?: string | null; pem?: string | null; fingerprint?: string; notBefore?: string | null; notAfter?: string | null } | null;
};
type Usage = { totals: { uploadBytes: number; downloadBytes: number; totalBytes: number }; daily: Array<{ day: string; totalBytes: number }>; updatedAt?: string };
type Download = { client: ClientChoice; name: string; text?: string; files?: Array<{ name: string; text: string }> };

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const protocolLabel = (value: string) => value === "wireguard" ? "WireGuard" : value === "openvpn" ? "OpenVPN" : value;
const stateLabel = (value: string) => ({ disabled: "已停用", "admin-disabled": "管理员已停用", "account-disabled": "账号已停用", online: "在线", offline: "离线", "never-connected": "尚未连接", "telemetry-delayed": "状态未知", revoked: "已撤销", expired: "已过期" } as Record<string, string>)[value] || value;
const statusLabel = (value: string) => ({ active: "有效", issued: "待启用", revoked: "已撤销", expired: "已过期" } as Record<string, string>)[value] || value;
const formatBytes = (bytes = 0) => {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
};
const dateLabel = (value?: string | null) => {
  if (!value) return "尚无记录";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
};
const activityLabel = (value?: string | null) => {
  if (!value) return "尚未使用";
  const elapsed = Date.now() - new Date(value).getTime();
  if (elapsed < 60_000) return "刚刚活跃";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  return `${Math.floor(elapsed / 86_400_000)} 天前`;
};
function filenamePart(value: string | null | undefined, fallback: string, maxLength = 18) {
  return (value || "").normalize("NFKC").trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, maxLength) || fallback;
}
function profileFilename(profile: Profile) {
  const extension = profile.protocol === "openvpn" ? "ovpn" : "conf";
  const protocolCode = profile.protocol === "openvpn" ? "OV" : "WG";
  const node = (profile.regionalNodeCount || 0) > 1 ? `${profile.regionalNodeCount}nodes` : filenamePart(profile.nodeName, "node", 12);
  return `${filenamePart(profile.regionCode?.toUpperCase(), "AUTO", 8)}-${filenamePart(profile.displayName, "credential")}-${protocolCode}-${node}.${extension}`;
}
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, credentials: "include", cache: "no-store", headers: { "Content-Type": "application/json", ...(init?.headers || {}) } });
  const text = await response.text();
  const body = text && response.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) as Record<string, unknown> : {};
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : text || `请求失败（HTTP ${response.status}）`);
  return body as T;
}
function saveBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob); const link = document.createElement("a");
  link.href = url; link.download = name; document.body.appendChild(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
function saveText(name: string, text: string) { saveBlob(name, new Blob([text], { type: "text/plain;charset=utf-8" })); }

export function CredentialDashboard({ user, onLogout }: { user: User; onLogout: () => void }) {
  const { ask, dialog } = useActionDialog();
  const [regions, setRegions] = useState<Region[]>([]);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [name, setName] = useState("我的 VPN");
  const [client, setClient] = useState<ClientChoice>("clash");
  const [downloadChoices, setDownloadChoices] = useState<Record<string, ClientChoice>>({});
  const [stale, setStale] = useState(false);
  const protocol = clientProtocol(client);
  const [regionId, setRegionId] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [download, setDownload] = useState<Download | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  const canCreate = regions.some((item) => (!regionId || item.id === regionId) && item.status === "available" && item.protocols.includes(protocol));
  const selected = credentials.find((item) => item.id === selectedId) || credentials[0];
  const selectedProfiles = useMemo(() => profiles.filter((item) => item.credentialId === selected?.id), [profiles, selected?.id]);
  const currentProfiles = selectedProfiles.filter((item) => item.status === "active" || item.status === "issued");
  const historyProfiles = selectedProfiles.filter((item) => item.status !== "active" && item.status !== "issued");
  const onlineCount = credentials.filter((item) => item.online).length;
  const usableCount = credentials.filter((item) => usableCredential(item)).length;
  const selectedClient = selected?.protocol === "openvpn" ? "openvpn" : downloadChoices[selected?.id] || "clash";
  const canDownload = !!selected && usableCredential(selected) && currentProfiles.length > 0;
  const recentDays = (usage?.daily || []).slice(-14);
  const recentTotal = recentDays.reduce((sum, day) => sum + day.totalBytes, 0);
  const maxDay = Math.max(...recentDays.map((item) => item.totalBytes), 1);

  async function refresh(silent = false) {
    if (!silent) setRefreshing(true);
    try {
      const [availability, credentialResult, profileResult, usageResult] = await Promise.all([
        api<{ regions: Region[] }>("/api/v1/availability"),
        api<{ credentials: Credential[] }>("/api/v1/credentials"),
        api<{ profiles: Profile[] }>("/api/v1/profiles"),
        api<Usage>("/api/v1/usage/summary"),
      ]);
      setRegions(availability.regions); setCredentials(credentialResult.credentials || []); setProfiles(profileResult.profiles || []); setUsage(usageResult);
      setUpdatedAt(new Date().toISOString()); setStale(false);
      setSelectedId((current) => credentialResult.credentials.some((item) => item.id === current) ? current : credentialResult.credentials[0]?.id || "");
      setRegionId((current) => current && !availability.regions.some((item) => item.id === current) ? "" : current);
    } catch (caught) { setStale(true); if (!silent) setError((caught as Error).message); }
    finally { if (!silent) setRefreshing(false); }
  }

  useEffect(() => {
    const initial = window.setTimeout(() => { void refresh(); }, 0);
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(true); }, 20_000);
    const onVisible = () => { if (!document.hidden) void refresh(true); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, []);

  function selectRegion(nextRegionId: string) {
    setRegionId(nextRegionId);

  }

  async function createCredential(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !canCreate) return;
    if (!name.trim()) { setError("请输入连接名称，不能只包含空格。"); return; }
    setBusy(true); setError(""); setNotice(""); setDownload(null);
    let createdCredentialId = "";
    let profileIssued = false;
    try {
      const privateBytes = protocol === "wireguard" ? x25519.utils.randomSecretKey() : null;
      const clientPrivateKey = privateBytes ? base64(privateBytes) : undefined;
      const publicKey = privateBytes ? base64(x25519.getPublicKey(privateBytes)) : undefined;
      const created = await api<{ credential: Credential }>("/api/v1/credentials", { method: "POST", body: JSON.stringify({ name: name.trim(), protocol, publicKey }) });
      createdCredentialId = created.credential.id;
      const issued = await api<{ profile: Profile; profiles?: Profile[] }>("/api/v1/profiles", { method: "POST", body: JSON.stringify({ credentialId: created.credential.id, regionId: regionId || undefined, protocol, clientPrivateKey }) });
      profileIssued = true;
      const issuedProfiles = issued.profiles?.length ? issued.profiles : [issued.profile];
      const activated = await Promise.all(issuedProfiles.map(async (item) => ({ ...(await api<{ profile: Profile }>(`/api/v1/profiles/${item.id}/activate`, { method: "POST" })).profile, displayName: name })));
      const files = await Promise.all(activated.map(async (item) => {
        const response = await fetch(`/api/v1/profiles/${item.id}/download${clientFormat(client) === "mihomo" ? "?format=mihomo" : ""}`, { credentials: "include", cache: "no-store" });
        const text = await response.text(); if (!response.ok) throw new Error(text || "配置下载失败");
        return { name: client === "clash" ? profileFilename(item).replace(/\.conf$/, `-${item.id}-Clash.yaml`) : profileFilename(item), text };
      }));
      const prepared: Download = files.length === 1 ? { ...files[0], client } : { name: `${filenamePart(name, "credential")}-${clientName(client)}.zip`, files, client };
      setDownload(prepared);
      if (prepared.text) saveText(prepared.name, prepared.text);
      else if (prepared.files) saveBlob(prepared.name, createZipBlob(prepared.files));
      setDownloadChoices((choices) => ({ ...choices, [created.credential.id]: client }));
      setSelectedId(created.credential.id);
      setNotice(`「${name}」已创建，${clientName(client)} 配置下载已开始。若浏览器未保存，可点击「重新下载」。`);
      await refresh(true);
    } catch (caught) {
      if (createdCredentialId && !profileIssued) await api(`/api/v1/credentials/${createdCredentialId}/revoke`, { method: "POST" }).catch(() => undefined);
      setError((caught as Error).message);
      await refresh(true);
    }
    finally { setBusy(false); }
  }

  async function downloadProfiles(format: "native" | "mihomo" = "native") {
    if (busy || !canDownload || !selected) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const targets = selected.protocol === "wireguard" ? currentProfiles : [currentProfiles[0]];
      const files = await Promise.all(targets.map(async (profile) => {
        const response = await fetch(`/api/v1/profiles/${profile.id}/download${format === "mihomo" ? "?format=mihomo" : ""}`, { credentials: "include", cache: "no-store" });
        const text = await response.text(); if (!response.ok) throw new Error(text || "配置下载失败");
        const filename = profileFilename({ ...profile, displayName: selected.name });
        return { name: format === "mihomo" ? filename.replace(/\.conf$/, `-${profile.id}-Mihomo.yaml`) : filename, text };
      }));
      if (files.length === 1) saveText(files[0].name, files[0].text);
      else saveBlob(`${filenamePart(selected.name, "credential")}-${format === "mihomo" ? "Mihomo" : selected.protocol === "wireguard" ? "WG" : "OV"}.zip`, createZipBlob(files));
      setNotice(format === "mihomo" ? "Mihomo 配置下载已开始。多节点压缩包请先解压，再选择一份 YAML 作为本地配置导入。" : "配置下载已开始。");
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }

  async function renameCredential() {
    if (!selected) return;
    const next = await ask({ title: "修改连接名称", description: "名称只用于区分凭据，不影响现有配置和连接。", confirmLabel: "保存名称", initialValue: selected.name });
    if (!next || next === selected.name) return;
    setBusy(true); setError(""); setNotice("");
    try { await api(`/api/v1/credentials/${selected.id}`, { method: "PATCH", body: JSON.stringify({ name: next }) }); await refresh(true); setNotice("连接名称已更新，不会影响现有配置。"); }
    catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }

  async function revokeCredential() {
    if (!selected || !await ask({ title: `撤销「${selected.name}」？`, description: "节点同步后，所有复制出去的配置都会永久失效。此操作不可恢复；如需暂时停止使用，请选择停用。", confirmLabel: "确认撤销", danger: true })) return;
    setBusy(true); setError(""); setNotice("");
    try { await api(`/api/v1/credentials/${selected.id}/revoke`, { method: "POST" }); await refresh(true); setDownload(null); setNotice("连接已撤销，节点同步后全部配置失效。"); }
    catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }

  async function changeAccess(action: "enable" | "disable" | "delete") {
    if (!selected || !await ask({ title: `${action === "enable" ? "启用" : action === "disable" ? "停用" : "删除"}「${selected.name}」？`, description: action === "delete" ? "节点同步后，所有配置将永久失效，连接从列表移除。历史流量与审计保留，此操作不可恢复。" : action === "disable" ? "节点同步后，所有配置副本将暂停使用。之后可以重新启用，无需重新下载配置。" : "节点同步后恢复使用。管理员或账号限制仍需由管理员解除。", confirmLabel: action === "enable" ? "确认启用" : action === "disable" ? "确认停用" : "确认删除", danger: action === "delete" })) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await api<{ sync: { status: string } }>(`/api/v1/credentials/${selected.id}`, { method: "PATCH", body: JSON.stringify({ action }) });
      setDownload(null);
      setNotice(result.sync.status === "failed" ? "状态已保存，但节点同步失败，请联系管理员重试。" : "操作已保存，请查看节点同步状态。管理员限制只能由管理员解除。");
      await refresh(true);
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }

  async function bulkAccess(action: "disable" | "revoke") {
    if (!await ask({ title: action === "disable" ? "停用全部连接？" : "撤销全部连接？", description: action === "disable" ? "节点同步后，自己的全部有效连接将暂停使用。可以逐个重新启用。" : "节点同步后，自己的全部连接及所有配置副本将永久失效，无法恢复。", confirmLabel: action === "disable" ? "全部停用" : "全部撤销", danger: true })) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await api("/api/v1/credentials", { method: "PATCH", body: JSON.stringify({ action }) });
      setDownload(null); setNotice("批量操作已保存，请查看节点同步状态。"); await refresh(true);
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }

  function prepareReplacement() {
    if (!selected) return;
    setName(`${selected.name}（换发）`);
    setClient(selectedClient);
    const previous = selectedProfiles[0];
    const region = regions.find((item) => item.code === previous?.regionCode);
    if (region) setRegionId(region.id);
    setNotice("已填好换发信息，请在上方创建新凭据并下载配置，然后重新导入所有使用端。旧配置保持原到期时间；新配置验证成功后可撤销旧凭据。");
    document.getElementById("credential-create")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function saveDownload() {
    if (!download) return;
    if (download.text) saveText(download.name, download.text);
    else if (download.files) saveBlob(download.name, createZipBlob(download.files));
  }

  return <main className="dashboard">
    {dialog}
    {(error || notice || busy) && <div className={`action-feedback ${error ? "error" : ""}`} role={error ? "alert" : "status"}><span>{error || (busy ? "正在处理，请稍候…" : notice)}</span>{!busy && <button type="button" aria-label="关闭提示" onClick={() => { setError(""); setNotice(""); }}>×</button>}</div>}
    <header><div className="brand"><span className="brand-mark"><i /><i /><i /></span><span>NORTHSTAR <em>VPN</em></span></div><div className="account"><span>{user.displayName.slice(0, 1).toUpperCase()}</span><div><b>{user.displayName}</b><small>{user.email}</small></div><button onClick={onLogout}>退出</button></div></header>
    <section className="welcome"><div><p className="kicker">MY CONNECTIONS</p><h1>你好，{user.displayName}。</h1><p>选择你使用的客户端，下载后导入，就可以连接。</p></div><span className="active-badge">● 账号已开通</span></section>
    <section className="stats simple-stats" aria-label="使用概览">
      <article><small>近 30 天总流量</small><strong>{usage ? formatBytes(usage.totals.totalBytes) : "—"}</strong><span>上传 {usage ? formatBytes(usage.totals.uploadBytes) : "—"} · 下载 {usage ? formatBytes(usage.totals.downloadBytes) : "—"}</span></article>
      <article><small>正在使用</small><strong>{updatedAt ? onlineCount : "—"}</strong><span>{stale ? "更新中断，显示上次结果" : "有活动的连接"}</span></article>
      <article><small>可用连接</small><strong>{updatedAt ? usableCount : "—"}</strong><span>{credentials.length} 份连接 · 已停用或到期的不计入</span></article>
    </section>
    <div className="grid simple-create-grid">
      <section className="card"><div className="card-head"><div><p className="kicker">GET CONNECTED</p><h2 id="credential-create">创建连接</h2></div><span className="muted">有效期 1 年</span></div>
        <form onSubmit={createCredential}>
          <fieldset className="client-picker" disabled={busy}><legend>你使用哪个客户端？</legend>{clientOptions.map((option) => <label className={client === option.id ? "selected" : ""} key={option.id}><input type="radio" name="client" value={option.id} checked={client === option.id} onChange={() => setClient(option.id)} /><strong>{option.name}</strong><small>{option.description}</small></label>)}</fieldset>
          <div className="form-grid"><label>连接名称<input required disabled={busy} value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：我的连接" /></label><label>连接区域<select disabled={busy} value={regionId} onChange={(event) => selectRegion(event.target.value)}><option value="">自动选择</option>{regions.map((region) => <option key={region.id} value={region.id} disabled={region.status !== "available" || !region.protocols.includes(protocol)}>{region.name}{region.status !== "available" || !region.protocols.includes(protocol) ? "（当前客户端不可用）" : ""}</option>)}</select></label></div>
          {!canCreate && updatedAt && <p className="error" role="status">当前区域暂不支持这个客户端，请更换区域或客户端。</p>}
          <button className="primary create-download" disabled={busy || !canCreate}>{busy ? "处理中…" : "创建并下载"}<span aria-hidden="true">↓</span></button>
          <p className="form-footnote">{client === "clash" ? "支持 Mihomo 内核的 Clash 客户端，不适用于旧版 Clash。" : `下载后导入 ${clientName(client)} 客户端。`} 配置仅供本人使用。</p>
        </form>
        {download && <div className="download-box" role="status"><b>已准备好，下一步导入 {clientName(download.client)}</b><p>{download.files ? "先解压下载的 ZIP，再选择一份配置文件导入。" : "在客户端中选择「导入配置」或「从文件导入」，打开刚下载的文件。"}{download.client === "clash" ? " 启用配置后，打开客户端的系统代理或 TUN。" : " 导入后开启连接。"}{download.client !== "openvpn" ? " 同一份连接请勿在多个客户端同时开启。" : ""}</p><button type="button" className="secondary" onClick={saveDownload}>重新下载</button></div>}
      </section>
      <section className="card traffic-card"><div className="card-head"><div><p className="kicker">USAGE</p><h2>流量趋势</h2></div><span className="muted">近 14 天 · UTC</span></div><div className="traffic-total">{usage ? formatBytes(recentTotal) : "—"}<small>期间累计</small></div>
        {recentTotal > 0 ? <div className="bars" role="img" aria-label={`近 14 天流量，累计 ${formatBytes(recentTotal)}`}>{recentDays.map((day) => <div key={day.day} title={`${day.day} · ${formatBytes(day.totalBytes)}`}><i style={{ height: `${day.totalBytes > 0 ? Math.max(2, day.totalBytes / maxDay * 100) : 0}%` }} /><small>{day.day.slice(5)}</small></div>)}</div> : <div className="usage-empty"><span>↗</span><p>{usage ? "开始连接后，这里会显示流量趋势。" : "正在读取流量…"}</p></div>}
        <p className="form-footnote">流量按连接汇总，不区分安装在哪台设备。</p>
      </section>
    </div>
    <section className="device-hub"><div className="device-hub-head"><div><p className="kicker">YOUR CONNECTIONS</p><h2>我的连接</h2><p>查看使用情况，或重新下载配置。</p></div><div className="device-hub-head-actions"><button type="button" className="refresh-button" disabled={refreshing} onClick={() => void refresh()}>{refreshing ? "刷新中…" : "刷新状态"}</button><small className={stale ? "stale" : ""}>{stale ? "暂时无法更新，以下为上次结果" : updatedAt ? `更新于 ${dateLabel(updatedAt)} · 自动刷新` : "正在读取…"}</small></div></div>
      <div className="device-hub-layout"><div className="device-list">{credentials.length ? credentials.map((credential) => <button type="button" aria-pressed={selected?.id === credential.id} className={`device-card ${selected?.id === credential.id ? "selected" : ""}`} key={credential.id} onClick={() => setSelectedId(credential.id)}><span className="connection-symbol" aria-hidden="true">↗</span><span className="device-card-main"><strong>{credential.name}</strong><small>{stateLabel(credential.state)} · 30 天 {formatBytes(credential.totalBytes)}</small></span><span className={`presence-dot ${credential.online ? "online" : ""}`} /></button>) : <p className="empty">还没有连接，在上方创建第一份即可。</p>}</div>
      {selected ? <article className="device-detail" key={selected.id}>
        <div className="device-detail-head"><div className="device-title-line"><h3>{selected.name}</h3><span className={`status-pill ${selected.state}`}>{stateLabel(selected.state)}</span></div><p>有效期至 {dateLabel(selected.expiresAt)} · 最近活动 {activityLabel(selected.lastActivityAt)}</p></div>
        {selected.syncStatus !== "applied" && <p className="credential-warning" role="status">{selected.syncStatus === "failed" ? "更改尚未成功同步，请联系管理员。" : "更改正在生效，请稍候。"}</p>}
        {(selected.expiringSoon || selected.status === "expired") && <div className="credential-warning"><p>{selected.status === "expired" ? "连接已到期，请换发后重新导入。" : `还有 ${selected.daysRemaining} 天到期，请提前换发。`}</p>{!selected.adminDisabled && !selected.userDisabled && <button className="text-link" disabled={busy} onClick={prepareReplacement}>换发连接</button>}</div>}
        <div className="device-metrics simple-metrics"><div><small>近 30 天流量</small><strong>{formatBytes(selected.totalBytes)}</strong><span>↑ {formatBytes(selected.uploadBytes)} · ↓ {formatBytes(selected.downloadBytes)}</span></div><div><small>当前连接</small><strong>{selected.connectionCount}</strong><span>{selected.state === "telemetry-delayed" ? "状态暂未更新" : selected.online ? "正在使用" : "暂未观测到连接"}</span></div></div>
        <section className="connection-download"><label>下载到哪个客户端？<select disabled={busy} value={selectedClient} onChange={(event) => setDownloadChoices((choices) => ({ ...choices, [selected.id]: event.target.value as ClientChoice }))}>{clientOptions.filter((item) => clientProtocol(item.id) === selected.protocol).map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><button className="primary" disabled={busy || !canDownload} onClick={() => void downloadProfiles(clientFormat(selectedClient))}>下载配置{currentProfiles.length > 1 && selected.protocol !== "openvpn" ? "包" : ""}</button></section>
        <p className="form-footnote">{!usableCredential(selected) ? "当前连接不可用，恢复后才能下载；管理员限制请联系管理员解除。" : selectedClient === "clash" ? "适用于 Mihomo 内核。下载后从文件导入，再开启系统代理或 TUN。" : `下载后导入 ${clientName(selectedClient)}。`}{selected.protocol === "wireguard" && " 同一份连接请勿在多个客户端同时开启。"}</p>
        <details className="connection-disclosure"><summary>管理连接</summary><div className="connection-manage"><button className="text-link" disabled={busy} onClick={() => void renameCredential()}>改名</button>{selected.status === "active" && <button className="text-link" disabled={busy || selected.adminDisabled} onClick={() => void changeAccess(selected.userDisabled ? "enable" : "disable")}>{selected.userDisabled ? "启用" : "停用"}</button>}{selected.status === "active" && <button className="danger-link" disabled={busy} onClick={() => void revokeCredential()}>永久撤销</button>}<button className="danger-link" disabled={busy} onClick={() => void changeAccess("delete")}>删除</button></div><p className="form-footnote">停用可以恢复；撤销或删除会永久作废全部配置副本。</p></details>
        <details className="connection-disclosure"><summary>证书与配置详情</summary>
          <dl className="connection-facts"><div><dt>底层协议</dt><dd>{protocolLabel(selected.protocol)}</dd></div><div><dt>创建时间</dt><dd>{dateLabel(selected.createdAt)}</dd></div><div><dt>连接身份</dt><dd>…{selected.identitySuffix}</dd></div></dl>
          {selected.certificate && <div className="certificate-summary"><span><small>证书到期时间</small><b>{dateLabel(selected.certificate.notAfter)}</b></span><span><small>序列号</small><code>{selected.certificate.serial || "—"}</code></span><span><small>SHA-256 指纹</small><code>{selected.certificate.fingerprint || "—"}</code></span><details><summary>查看公开证书</summary><pre>{selected.certificate.pem}</pre></details></div>}
          <h4>当前配置 · {currentProfiles.length} 份</h4>{currentProfiles.map((profile) => <p className="form-footnote" key={profile.id}>{profile.regionName || "自动区域"} · {profile.nodeName || ""} · {statusLabel(profile.status)} · 到期 {dateLabel(profile.expiresAt)}</p>)}
          {historyProfiles.length > 0 && <><h4>历史配置 · {historyProfiles.length} 份</h4>{historyProfiles.slice(0, 8).map((profile) => <p className="form-footnote" key={profile.id}>{profile.regionName || profile.regionCode} · {statusLabel(profile.status)} · {dateLabel(profile.issuedAt)}</p>)}</>}
        </details>
      </article> : <div className="device-detail empty-detail"><h3>你的连接会显示在这里</h3><p>先在上方选择客户端，创建并下载。</p></div>}
      </div>
      {credentials.length > 0 && <details className="connection-disclosure account-bulk"><summary>全部连接管理</summary><p className="form-footnote">以下操作会影响账号下的全部连接。</p><div className="connection-manage"><button className="secondary" disabled={busy} onClick={() => void bulkAccess("disable")}>停用全部</button><button className="danger-link" disabled={busy} onClick={() => void bulkAccess("revoke")}>永久撤销全部</button></div></details>}
    </section>
    <details className="network-disclosure"><summary>查看可用区域地图</summary><RegionMap regions={regions} selectedRegionId={regionId} onSelect={selectRegion} /></details>
    <footer>Northstar · 配置仅供本人使用，请勿分享或上传第三方转换网站。</footer>
  </main>;
}
