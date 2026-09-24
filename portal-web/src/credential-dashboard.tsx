import { useEffect, useMemo, useState } from "react";
import { x25519 } from "@noble/curves/ed25519.js";
import { useActionDialog } from "./action-dialog";
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
type Download = { name: string; text?: string; files?: Array<{ name: string; text: string }> };

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
  const [protocol, setProtocol] = useState("wireguard");
  const [regionId, setRegionId] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [download, setDownload] = useState<Download | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  const selectedRegion = regions.find((item) => item.id === regionId);
  const availableProtocols = selectedRegion?.protocols || ["wireguard", "openvpn"];
  const canCreate = regions.some((item) => (!regionId || item.id === regionId) && item.status === "available" && item.protocols.includes(protocol));
  const selected = credentials.find((item) => item.id === selectedId) || credentials[0];
  const selectedProfiles = useMemo(() => profiles.filter((item) => item.credentialId === selected?.id), [profiles, selected?.id]);
  const currentProfiles = selectedProfiles.filter((item) => item.status === "active" || item.status === "issued");
  const historyProfiles = selectedProfiles.filter((item) => item.status !== "active" && item.status !== "issued");
  const onlineCount = credentials.filter((item) => item.online).length;
  const maxDay = Math.max(...(usage?.daily || []).map((item) => item.totalBytes), 1);

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
      setUpdatedAt(new Date().toISOString());
      setSelectedId((current) => credentialResult.credentials.some((item) => item.id === current) ? current : credentialResult.credentials[0]?.id || "");
      setRegionId((current) => {
        const next = current || availability.regions.find((item) => item.status === "available")?.id || availability.regions[0]?.id || "";
        const region = availability.regions.find((item) => item.id === next);
        if (region) setProtocol((currentProtocol) => region.protocols.includes(currentProtocol) ? currentProtocol : region.protocols[0] || "wireguard");
        return next;
      });
    } catch (caught) { if (!silent) setError((caught as Error).message); }
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
    const region = regions.find((item) => item.id === nextRegionId);
    if (region && !region.protocols.includes(protocol)) setProtocol(region.protocols[0] || "wireguard");
  }

  async function createCredential(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !canCreate) return;
    if (!name.trim()) { setError("请输入凭据名称，不能只包含空格。"); return; }
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
        const response = await fetch(`/api/v1/profiles/${item.id}/download`, { credentials: "include", cache: "no-store" });
        const text = await response.text(); if (!response.ok) throw new Error(text || "配置下载失败");
        return { name: profileFilename(item), text };
      }));
      setDownload(files.length === 1 ? files[0] : { name: `${filenamePart(name, "credential")}-${protocol === "wireguard" ? "WG" : "OV"}.zip`, files });
      setSelectedId(created.credential.id);
      setNotice(`连接凭据「${name}」已创建。请点击「下载配置」保存文件，再导入客户端。`);
      await refresh(true);
    } catch (caught) {
      if (createdCredentialId && !profileIssued) await api(`/api/v1/credentials/${createdCredentialId}/revoke`, { method: "POST" }).catch(() => undefined);
      setError((caught as Error).message);
      await refresh(true);
    }
    finally { setBusy(false); }
  }

  async function downloadProfiles(format: "native" | "mihomo" = "native") {
    if (!selected || !currentProfiles.length) return;
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
    const next = await ask({ title: "修改凭据名称", description: "名称只用于区分凭据，不影响现有配置和连接。", confirmLabel: "保存名称", initialValue: selected.name });
    if (!next || next === selected.name) return;
    setBusy(true); setError(""); setNotice("");
    try { await api(`/api/v1/credentials/${selected.id}`, { method: "PATCH", body: JSON.stringify({ name: next }) }); await refresh(true); setNotice("凭据名称已更新，不会影响现有配置。"); }
    catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }

  async function revokeCredential() {
    if (!selected || !await ask({ title: `撤销「${selected.name}」？`, description: "节点同步后，所有复制出去的配置都会永久失效。此操作不可恢复；如需暂时停止使用，请选择停用。", confirmLabel: "确认撤销", danger: true })) return;
    setBusy(true); setError(""); setNotice("");
    try { await api(`/api/v1/credentials/${selected.id}/revoke`, { method: "POST" }); await refresh(true); setDownload(null); setNotice("凭据已撤销，节点同步后全部配置失效。"); }
    catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }

  async function changeAccess(action: "enable" | "disable" | "delete") {
    if (!selected || !await ask({ title: `${action === "enable" ? "启用" : action === "disable" ? "停用" : "删除"}「${selected.name}」？`, description: action === "delete" ? "节点同步后，所有配置将永久失效，凭据从列表移除。历史流量与审计保留，此操作不可恢复。" : action === "disable" ? "节点同步后，所有配置副本将暂停使用。之后可以重新启用，无需重新下载配置。" : "节点同步后恢复使用。管理员或账号限制仍需由管理员解除。", confirmLabel: action === "enable" ? "确认启用" : action === "disable" ? "确认停用" : "确认删除", danger: action === "delete" })) return;
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
    if (!await ask({ title: action === "disable" ? "停用全部凭据？" : "撤销全部凭据？", description: action === "disable" ? "节点同步后，自己的全部有效凭据将暂停使用。可以逐个重新启用。" : "节点同步后，自己的全部凭据及所有配置副本将永久失效，无法恢复。", confirmLabel: action === "disable" ? "全部停用" : "全部撤销", danger: true })) return;
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
    setProtocol(selected.protocol);
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

  return <main className="dashboard">{dialog}{(error || notice || busy) && <div className={`action-feedback ${error ? "error" : ""}`} role={error ? "alert" : "status"}><span>{error || (busy ? "正在处理，请稍候…" : notice)}</span>{!busy && <button type="button" aria-label="关闭提示" onClick={() => { setError(""); setNotice(""); }}>×</button>}</div>}<header><div className="brand"><span className="brand-mark"><i /><i /><i /></span><span>NORTHSTAR <em>VPN</em></span></div><div className="account"><span>{user.displayName.slice(0, 1).toUpperCase()}</span><div><b>{user.displayName}</b><small>{user.email}</small></div><button onClick={onLogout}>退出</button></div></header>
    <section className="welcome"><div><p className="kicker">CREDENTIAL ACCESS</p><h1>你好，{user.displayName}。</h1><p>创建、命名和管理连接凭据；配置可以复制到任意客户端使用。</p></div><span className="active-badge">● 已审核</span></section>
    <section className="stats"><article><small>近 30 天总流量</small><strong>{formatBytes(usage?.totals.totalBytes)}</strong><span>上传 {formatBytes(usage?.totals.uploadBytes)} · 下载 {formatBytes(usage?.totals.downloadBytes)}</span></article><article><small>在线凭据</small><strong>{onlineCount}</strong><span>{credentials.reduce((sum, item) => sum + item.connectionCount, 0)} 个连接会话</span></article><article><small>有效凭据</small><strong>{credentials.filter((item) => item.status === "active").length}</strong><span>共 {credentials.length} 份</span></article><article><small>数据更新时间</small><strong className="stats-time">{updatedAt ? activityLabel(updatedAt) : "暂无"}</strong><span>页面每 20 秒自动刷新</span></article></section>
    <RegionMap regions={regions} selectedRegionId={regionId} onSelect={selectRegion} />
    <div className="grid"><section className="card"><div className="card-head"><div><p className="kicker">CREATE CREDENTIAL</p><h2 id="credential-create">创建连接凭据</h2></div><span className="muted">新凭据默认有效 365 天</span></div><form className="form-grid" onSubmit={createCredential}><label>凭据名称<input required value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：个人 VPN" /></label><label>区域<select value={regionId} onChange={(event) => selectRegion(event.target.value)}><option value="">自动选择</option>{regions.map((region) => <option key={region.id} value={region.id}>{region.name} · {region.country}{region.status !== "available" ? "（不可用）" : ""}</option>)}</select></label><label>协议<select value={protocol} onChange={(event) => setProtocol(event.target.value)}>{availableProtocols.map((item) => <option key={item} value={item}>{protocolLabel(item)}</option>)}</select></label><button className="primary" disabled={busy || !canCreate}>{busy ? "处理中…" : "创建配置"}<span>→</span></button></form>{protocol === "wireguard" && <p className="credential-warning">同一 WireGuard 凭据可以复制，但建议同一时间只在一个客户端连接；多端并发请创建多份凭据。</p>}{download && <div className="download-box"><b>配置已经准备好</b><p>可重复下载并复制到需要使用的客户端。撤销凭据后，所有副本同时失效。</p><button className="secondary" onClick={saveDownload}>下载配置</button><small className="download-filename">{download.name}</small></div>}</section><section className="card"><div className="card-head"><div><p className="kicker">LAST 30 DAYS</p><h2>流量趋势</h2></div><span className="muted">按 UTC 日期汇总</span></div><div className="bars">{(usage?.daily || []).slice(-14).map((day) => <div key={day.day} title={`${day.day} ${formatBytes(day.totalBytes)}`}><i style={{ height: `${Math.max(6, day.totalBytes / maxDay * 100)}%` }} /><small>{day.day.slice(5)}</small></div>)}</div></section></div>
    <section className="device-hub"><div className="device-hub-head"><div><p className="kicker">ACCESS CREDENTIALS</p><h2>我的连接凭据</h2><p>平台不区分配置被复制到哪些设备，只汇总每份凭据的连接、流量和状态。</p></div><div className="device-hub-head-actions"><b>{onlineCount} 在线 · {credentials.length} 份凭据</b><button type="button" className="refresh-button" disabled={refreshing} onClick={() => void refresh()}><span className={refreshing ? "refresh-icon spinning" : "refresh-icon"}>↻</span>{refreshing ? "刷新中…" : "刷新数据"}</button><small>{updatedAt ? `更新于 ${dateLabel(updatedAt)}` : "等待首次同步"}</small></div></div><div className="credential-bulk-toolbar"><p>停用可恢复；撤销后，所有配置副本永久失效。</p><div role="group" aria-label="全部凭据操作"><button className="secondary" disabled={busy || !credentials.length} onClick={() => void bulkAccess("disable")}>停用全部凭据</button><button disabled={busy || !credentials.length} className="danger-link" onClick={() => void bulkAccess("revoke")}>撤销全部凭据</button></div></div><div className="device-hub-layout"><div className="device-list">{credentials.length ? credentials.map((credential) => <button type="button" className={`device-card ${selected?.id === credential.id ? "selected" : ""}`} key={credential.id} onClick={() => setSelectedId(credential.id)}><span className="protocol-icon">{credential.protocol === "wireguard" ? "WG" : "OV"}</span><span className="device-card-main"><strong>{credential.name}</strong><small>{protocolLabel(credential.protocol)} · …{credential.identitySuffix}</small><small>{stateLabel(credential.state)}{credential.connectionCount ? ` · ${credential.connectionCount} 个连接` : ""} · 30 天 {formatBytes(credential.totalBytes)}</small></span><span className={`presence-dot ${credential.online ? "online" : ""}`} /></button>) : <p className="empty">还没有连接凭据，请先创建一份。</p>}</div>
      {selected ? <article className="device-detail"><div className="device-detail-head"><div><div className="device-title-line"><span className={`presence-dot ${selected.online ? "online" : ""}`} /><h3>{selected.name}</h3><span className={`status-pill ${selected.state}`}>{stateLabel(selected.state)}</span></div><p>{protocolLabel(selected.protocol)} · 身份 …{selected.identitySuffix} · 创建于 {dateLabel(selected.createdAt)}</p></div><div className="credential-actions"><button className="text-link" disabled={busy} onClick={() => void renameCredential()}>改名</button>{selected.status === "active" && <button className="text-link" disabled={busy || selected.adminDisabled} onClick={() => void changeAccess(selected.userDisabled ? "enable" : "disable")}>{selected.userDisabled ? "启用" : "停用"}</button>}<button className="danger-link" disabled={busy} onClick={() => void changeAccess("delete")}>删除</button><small>节点同步：{({ pending: "生效中", applied: "已生效", failed: "同步失败" } as Record<string, string>)[selected.syncStatus]}</small>{selected.status === "active" && <button className="danger-link" disabled={busy} onClick={() => void revokeCredential()}>撤销凭据</button>}</div></div><div className="credential-warning"><b>连接有效期至 {dateLabel(selected.expiresAt)}</b><p>停用和撤销可以提前终止使用。新配置与所属凭据共用到期时间，重新下载不会延长有效期。旧证书沿用原期限；已过期的历史配置需换发。</p>{(selected.expiringSoon || selected.status === "expired") && <p>{selected.status === "expired" ? "已到期，请换发并重新导入配置。" : `将在 ${selected.daysRemaining} 天内到期，请提前换发并重新导入。`}</p>}{!selected.adminDisabled && !selected.userDisabled && (selected.status === "active" || selected.status === "expired") && <button className="text-link" onClick={prepareReplacement}>换发新凭据</button>}</div><div className="device-metrics"><div><small>近 30 天总流量</small><strong>{formatBytes(selected.totalBytes)}</strong></div><div><small>上传</small><strong>{formatBytes(selected.uploadBytes)}</strong></div><div><small>下载</small><strong>{formatBytes(selected.downloadBytes)}</strong></div><div><small>当前连接</small><strong>{selected.connectionCount}</strong><span>{selected.online ? "服务端正在观测连接" : selected.state === "telemetry-delayed" ? "节点上报延迟" : activityLabel(selected.lastActivityAt)}</span></div></div>
        {selected.protocol === "openvpn" && selected.certificate && <div className="credential-section"><div className="section-title"><div><p className="kicker">OPENVPN CERTIFICATE</p><h4>证书信息</h4></div><span>{statusLabel(selected.status)}</span></div><div className="certificate-summary"><span><small>序列号</small><code>{selected.certificate.serial || "—"}</code></span><span><small>SHA-256 指纹</small><code>{selected.certificate.fingerprint || "—"}</code></span><span><small>证书实际到期时间</small><b>{dateLabel(selected.certificate.notAfter)}</b></span></div><details><summary>查看公开证书</summary><pre>{selected.certificate.pem}</pre></details></div>}
        {selected.protocol === "wireguard" && <section className="mihomo-export"><div><h4>Clash / Mihomo 客户端</h4><p>复用当前 WireGuard 凭据，下载后以本地配置导入支持 WireGuard 的 Mihomo 客户端，再开启系统代理或 TUN。默认将接管的流量交给所选节点，不自动启用 TUN。</p><p>配置含私钥，请勿分享或上传转换网站。同一凭据请勿在多个客户端同时连接；有效期、停用和撤销规则不变。多节点时下载 ZIP，解压后选择一份 YAML 导入。</p></div><button type="button" className="secondary" disabled={busy || !currentProfiles.length || selected.status !== "active" || selected.userDisabled || selected.adminDisabled || selected.accountStatus !== "active"} onClick={() => void downloadProfiles("mihomo")}>下载 Mihomo 配置{currentProfiles.length > 1 ? "包" : ""}</button></section>}
        <div className="credential-section"><div className="section-title"><div><p className="kicker">CURRENT CONFIGS</p><h4>当前连接配置</h4></div><span>{currentProfiles.length} 份</span></div>{currentProfiles.length ? currentProfiles.map((profile, index) => <div className="credential-row" key={profile.id}><span className="protocol-icon">{profile.protocol === "wireguard" ? "WG" : "OV"}</span><div className="credential-main"><strong>{profile.regionCode || "AUTO"} · {profile.regionName || "自动区域"}{profile.nodeName ? ` · ${profile.nodeName}` : ""}</strong><small>签发 {dateLabel(profile.issuedAt)} · 配置可用至 {dateLabel(profile.expiresAt)} · {statusLabel(profile.status)}</small></div><div className="credential-actions">{index === 0 ? <button className="text-link" disabled={busy} onClick={() => void downloadProfiles()}>{busy ? "处理中…" : currentProfiles.length > 1 ? "下载配置包" : "下载配置"}</button> : <span className="muted">同组配置</span>}</div></div>) : <p className="empty">该凭据暂无有效配置。</p>}</div>
        <div className="credential-history"><div className="section-title"><div><p className="kicker">CONFIG HISTORY</p><h4>配置历史</h4></div><span>{historyProfiles.length} 份</span></div>{historyProfiles.length ? <div className="history-list">{historyProfiles.slice(0, 8).map((profile) => <div key={profile.id}><span>{profile.regionCode || "AUTO"} · {protocolLabel(profile.protocol)}</span><small>{statusLabel(profile.status)} · 签发于 {dateLabel(profile.issuedAt)}</small></div>)}</div> : <p className="empty">暂时没有历史配置。</p>}</div></article> : <div className="device-detail empty-detail"><span className="status-icon">＋</span><h3>创建第一份连接凭据</h3><p>创建后可查看在线连接、流量、证书信息和配置下载入口。</p></div>}</div></section>
    <footer>Northstar · OpenVPN 在线状态来自服务端会话 · WireGuard 在线状态依据最近握手或流量 · 数据每 20 秒自动刷新</footer>
  </main>;
}
