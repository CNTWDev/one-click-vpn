import { useEffect, useMemo, useState } from "react";
import { x25519 } from "@noble/curves/ed25519.js";
import { RegionMap } from "./region-map";
import { createZipBlob } from "./zip";

type User = { email: string; displayName: string };
type Region = { id: string; name: string; country: string; code: string; protocols: string[]; status: string; protocolNodeCounts?: Record<string, number> };
type Profile = { id: string; credentialId?: string | null; displayName?: string | null; nodeName?: string | null; regionalNodeCount?: number; regionCode?: string | null; regionName?: string | null; protocol: string; status: string; issuedAt: string; expiresAt: string };
type Credential = {
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
const stateLabel = (value: string) => ({ online: "在线", offline: "离线", "never-connected": "尚未连接", "telemetry-delayed": "状态未知", revoked: "已撤销", expired: "已过期" } as Record<string, string>)[value] || value;
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
  return Number.isNaN(date.getTime()) ? "时间未知" : new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
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
    event.preventDefault(); setBusy(true); setError(""); setNotice(""); setDownload(null);
    let createdCredentialId = "";
    let profileIssued = false;
    try {
      const privateBytes = protocol === "wireguard" ? x25519.utils.randomSecretKey() : null;
      const clientPrivateKey = privateBytes ? base64(privateBytes) : undefined;
      const publicKey = privateBytes ? base64(x25519.getPublicKey(privateBytes)) : undefined;
      const created = await api<{ credential: Credential }>("/api/v1/credentials", { method: "POST", body: JSON.stringify({ name: name || "我的 VPN", protocol, publicKey }) });
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
      setNotice(`连接凭据「${name}」已创建。配置可以复制到需要使用的客户端。`);
      await refresh(true);
    } catch (caught) {
      if (createdCredentialId && !profileIssued) await api(`/api/v1/credentials/${createdCredentialId}/revoke`, { method: "POST" }).catch(() => undefined);
      setError((caught as Error).message);
      await refresh(true);
    }
    finally { setBusy(false); }
  }

  async function downloadProfiles() {
    if (!selected || !currentProfiles.length) return;
    setBusy(true); setError("");
    try {
      const targets = selected.protocol === "wireguard" ? currentProfiles : [currentProfiles[0]];
      const files = await Promise.all(targets.map(async (profile) => {
        const response = await fetch(`/api/v1/profiles/${profile.id}/download`, { credentials: "include", cache: "no-store" });
        const text = await response.text(); if (!response.ok) throw new Error(text || "配置下载失败");
        return { name: profileFilename({ ...profile, displayName: selected.name }), text };
      }));
      if (files.length === 1) saveText(files[0].name, files[0].text);
      else saveBlob(`${filenamePart(selected.name, "credential")}-${selected.protocol === "wireguard" ? "WG" : "OV"}.zip`, createZipBlob(files));
      setNotice("配置下载已开始。");
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }

  async function renameCredential() {
    if (!selected) return;
    const next = window.prompt("新的凭据名称", selected.name)?.trim();
    if (!next || next === selected.name) return;
    try { await api(`/api/v1/credentials/${selected.id}`, { method: "PATCH", body: JSON.stringify({ name: next }) }); await refresh(true); setNotice("凭据名称已更新，不会影响现有配置。"); }
    catch (caught) { setError((caught as Error).message); }
  }

  async function revokeCredential() {
    if (!selected || !window.confirm(`撤销「${selected.name}」？\n\n所有复制出去的配置都会失效，此操作不能自动恢复。`)) return;
    try { await api(`/api/v1/credentials/${selected.id}/revoke`, { method: "POST" }); await refresh(true); setNotice("凭据及其全部配置已撤销。"); }
    catch (caught) { setError((caught as Error).message); }
  }

  function saveDownload() {
    if (!download) return;
    if (download.text) saveText(download.name, download.text);
    else if (download.files) saveBlob(download.name, createZipBlob(download.files));
  }

  return <main className="dashboard"><header><div className="brand"><span className="brand-mark"><i /><i /><i /></span><span>NORTHSTAR <em>VPN</em></span></div><div className="account"><span>{user.displayName.slice(0, 1).toUpperCase()}</span><div><b>{user.displayName}</b><small>{user.email}</small></div><button onClick={onLogout}>退出</button></div></header>
    <section className="welcome"><div><p className="kicker">CREDENTIAL ACCESS</p><h1>你好，{user.displayName}。</h1><p>创建、命名和管理连接凭据；配置可以复制到任意客户端使用。</p></div><span className="active-badge">● 已审核</span></section>
    <section className="stats"><article><small>近 30 天总流量</small><strong>{formatBytes(usage?.totals.totalBytes)}</strong><span>上传 {formatBytes(usage?.totals.uploadBytes)} · 下载 {formatBytes(usage?.totals.downloadBytes)}</span></article><article><small>在线凭据</small><strong>{onlineCount}</strong><span>{credentials.reduce((sum, item) => sum + item.connectionCount, 0)} 个连接会话</span></article><article><small>有效凭据</small><strong>{credentials.filter((item) => item.status === "active").length}</strong><span>共 {credentials.length} 份</span></article><article><small>数据更新时间</small><strong className="stats-time">{updatedAt ? activityLabel(updatedAt) : "暂无"}</strong><span>页面每 20 秒自动刷新</span></article></section>
    <RegionMap regions={regions} selectedRegionId={regionId} onSelect={selectRegion} />
    <div className="grid"><section className="card"><div className="card-head"><div><p className="kicker">CREATE CREDENTIAL</p><h2>创建连接凭据</h2></div><span className="muted">一个名称，一份独立身份</span></div><form className="form-grid" onSubmit={createCredential}><label>凭据名称<input required value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：个人 VPN" /></label><label>区域<select value={regionId} onChange={(event) => selectRegion(event.target.value)}><option value="">自动选择</option>{regions.map((region) => <option key={region.id} value={region.id}>{region.name} · {region.country}{region.status !== "available" ? "（不可用）" : ""}</option>)}</select></label><label>协议<select value={protocol} onChange={(event) => setProtocol(event.target.value)}>{availableProtocols.map((item) => <option key={item} value={item}>{protocolLabel(item)}</option>)}</select></label><button className="primary" disabled={busy || !regions.some((item) => item.status === "available")}>{busy ? "生成中…" : "创建并下载配置"}<span>→</span></button></form>{protocol === "wireguard" && <p className="credential-warning">同一 WireGuard 凭据可以复制，但建议同一时间只在一个客户端连接；多端并发请创建多份凭据。</p>}{download && <div className="download-box"><b>配置已经准备好</b><p>可重复下载并复制到需要使用的客户端。撤销凭据后，所有副本同时失效。</p><button className="secondary" onClick={saveDownload}>下载 {download.name}</button></div>}{notice && <p className="success">{notice}</p>}{error && <p className="error">{error}</p>}</section><section className="card"><div className="card-head"><div><p className="kicker">LAST 30 DAYS</p><h2>流量趋势</h2></div><span className="muted">按 UTC 日期汇总</span></div><div className="bars">{(usage?.daily || []).slice(-14).map((day) => <div key={day.day} title={`${day.day} ${formatBytes(day.totalBytes)}`}><i style={{ height: `${Math.max(6, day.totalBytes / maxDay * 100)}%` }} /><small>{day.day.slice(5)}</small></div>)}</div></section></div>
    <section className="device-hub"><div className="device-hub-head"><div><p className="kicker">ACCESS CREDENTIALS</p><h2>我的连接凭据</h2><p>平台不区分配置被复制到哪些设备，只汇总每份凭据的连接、流量和状态。</p></div><div className="device-hub-head-actions"><b>{onlineCount} 在线 · {credentials.length} 份凭据</b><button type="button" className="refresh-button" disabled={refreshing} onClick={() => void refresh()}><span className={refreshing ? "refresh-icon spinning" : "refresh-icon"}>↻</span>{refreshing ? "刷新中…" : "刷新数据"}</button><small>{updatedAt ? `更新于 ${dateLabel(updatedAt)}` : "等待首次同步"}</small></div></div><div className="device-hub-layout"><div className="device-list">{credentials.length ? credentials.map((credential) => <button type="button" className={`device-card ${selected?.id === credential.id ? "selected" : ""}`} key={credential.id} onClick={() => setSelectedId(credential.id)}><span className="protocol-icon">{credential.protocol === "wireguard" ? "WG" : "OV"}</span><span className="device-card-main"><strong>{credential.name}</strong><small>{protocolLabel(credential.protocol)} · …{credential.identitySuffix}</small><small>{stateLabel(credential.state)}{credential.connectionCount ? ` · ${credential.connectionCount} 个连接` : ""} · 30 天 {formatBytes(credential.totalBytes)}</small></span><span className={`presence-dot ${credential.online ? "online" : ""}`} /></button>) : <p className="empty">还没有连接凭据，请先创建一份。</p>}</div>
      {selected ? <article className="device-detail"><div className="device-detail-head"><div><div className="device-title-line"><span className={`presence-dot ${selected.online ? "online" : ""}`} /><h3>{selected.name}</h3><span className={`status-pill ${selected.status}`}>{stateLabel(selected.state)}</span></div><p>{protocolLabel(selected.protocol)} · 身份 …{selected.identitySuffix} · 创建于 {dateLabel(selected.createdAt)}</p></div><div className="credential-actions"><button className="text-link" onClick={() => void renameCredential()}>改名</button>{selected.status === "active" && <button className="danger-link" onClick={() => void revokeCredential()}>撤销凭据</button>}</div></div><div className="device-metrics"><div><small>近 30 天总流量</small><strong>{formatBytes(selected.totalBytes)}</strong></div><div><small>上传</small><strong>{formatBytes(selected.uploadBytes)}</strong></div><div><small>下载</small><strong>{formatBytes(selected.downloadBytes)}</strong></div><div><small>当前连接</small><strong>{selected.connectionCount}</strong><span>{selected.online ? "服务端正在观测连接" : selected.state === "telemetry-delayed" ? "节点上报延迟" : activityLabel(selected.lastActivityAt)}</span></div></div>
        {selected.protocol === "openvpn" && selected.certificate && <div className="credential-section"><div className="section-title"><div><p className="kicker">OPENVPN CERTIFICATE</p><h4>证书信息</h4></div><span>{statusLabel(selected.status)}</span></div><div className="certificate-summary"><span><small>序列号</small><code>{selected.certificate.serial || "—"}</code></span><span><small>SHA-256 指纹</small><code>{selected.certificate.fingerprint || "—"}</code></span><span><small>有效期至</small><b>{dateLabel(selected.certificate.notAfter)}</b></span></div><details><summary>查看公开证书</summary><pre>{selected.certificate.pem}</pre></details></div>}
        <div className="credential-section"><div className="section-title"><div><p className="kicker">CURRENT CONFIGS</p><h4>当前连接配置</h4></div><span>{currentProfiles.length} 份</span></div>{currentProfiles.length ? currentProfiles.map((profile, index) => <div className="credential-row" key={profile.id}><span className="protocol-icon">{profile.protocol === "wireguard" ? "WG" : "OV"}</span><div className="credential-main"><strong>{profile.regionCode || "AUTO"} · {profile.regionName || "自动区域"}{profile.nodeName ? ` · ${profile.nodeName}` : ""}</strong><small>签发 {dateLabel(profile.issuedAt)} · 到期 {dateLabel(profile.expiresAt)} · {statusLabel(profile.status)}</small></div><div className="credential-actions">{index === 0 ? <button className="text-link" disabled={busy} onClick={() => void downloadProfiles()}>{busy ? "处理中…" : currentProfiles.length > 1 ? "下载配置包" : "下载配置"}</button> : <span className="muted">同组配置</span>}</div></div>) : <p className="empty">该凭据暂无有效配置。</p>}</div>
        <div className="credential-history"><div className="section-title"><div><p className="kicker">CONFIG HISTORY</p><h4>配置历史</h4></div><span>{historyProfiles.length} 份</span></div>{historyProfiles.length ? <div className="history-list">{historyProfiles.slice(0, 8).map((profile) => <div key={profile.id}><span>{profile.regionCode || "AUTO"} · {protocolLabel(profile.protocol)}</span><small>{statusLabel(profile.status)} · 签发于 {dateLabel(profile.issuedAt)}</small></div>)}</div> : <p className="empty">暂时没有历史配置。</p>}</div></article> : <div className="device-detail empty-detail"><span className="status-icon">＋</span><h3>创建第一份连接凭据</h3><p>创建后可查看在线连接、流量、证书信息和配置下载入口。</p></div>}</div></section>
    <footer>Northstar · OpenVPN 在线状态来自服务端会话 · WireGuard 在线状态依据最近握手或流量 · 数据每 20 秒自动刷新</footer>
  </main>;
}
