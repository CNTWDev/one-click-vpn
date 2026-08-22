/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { x25519 } from "@noble/curves/ed25519.js";
import { RegionMap } from "./region-map";
import { createZipBlob } from "./zip";
import "./styles.css";
import "./profile-actions.css";
import "./region-map.css";

type User = { id: string; email: string; displayName: string; role: string; status: string; rejectionReason?: string | null };
type Region = { id: string; name: string; country: string; code: string; protocols: string[]; status: string; onlineNodeCount?: number; healthyNodeCount?: number; protocolNodeCounts?: Record<string, number> };
type Device = { id: string; displayName: string; platform: string; publicKey: string; status: string; createdAt?: string; lastSeenAt?: string | null };
type Profile = { id: string; deviceId: string; displayName?: string | null; nodeId: string; nodeName?: string | null; regionalNodeCount?: number; regionCode?: string | null; regionName?: string | null; protocol: string; status: string; issuedAt: string; expiresAt: string };
type GeneratedDownload = { profileId: string; name: string; text?: string; files?: Array<{ name: string; text: string }> };
type Usage = { totals: { uploadBytes: number; downloadBytes: number; totalBytes: number }; daily: Array<{ day: string; totalBytes: number }>; updatedAt?: string };
type DeviceUsage = { deviceId: string; displayName: string; platform: string; uploadBytes: number; downloadBytes: number; totalBytes: number };
type CredentialUsage = { profileId: string; deviceId: string; displayName: string; protocol: string; regionName: string; regionCode: string; credentialSuffix: string; profileStatus?: string; online: boolean; lastActivityAt?: string | null; observedAt?: string | null; firstSeenAt?: string | null; lastSeenAt?: string | null; issuedAt?: string; uploadBytes: number; downloadBytes: number; totalBytes: number };

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
function saveTextFile(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
function saveBlobFile(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = name; link.style.display = "none";
  document.body.appendChild(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
const formatBytes = (bytes: number) => {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
};
function filenamePart(value: string | null | undefined, fallback: string, maxLength = 18): string {
  const cleaned = (value || "").normalize("NFKC").trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return cleaned.slice(0, maxLength) || fallback;
}
function profileFilename(profile: Profile): string {
  const extension = profile.protocol === "openvpn" ? "ovpn" : "conf";
  const protocolCode = profile.protocol === "openvpn" ? "OV" : profile.protocol === "wireguard" ? "WG" : filenamePart(profile.protocol, "VPN", 4).toUpperCase();
  const shortId = filenamePart(profile.id.split("_").at(-1)?.slice(-4), "cfg", 4);
  const regionCode = filenamePart(profile.regionCode?.toUpperCase(), "AUTO", 8);
  const regionName = profile.regionName ? `-${filenamePart(profile.regionName, "region", 14)}` : "";
  const node = (profile.regionalNodeCount || 0) > 1 ? `-${profile.regionalNodeCount}nodes` : profile.nodeName ? `-${filenamePart(profile.nodeName, "node", 12)}-${shortId}` : `-${shortId}`;
  return `${regionCode}${regionName}-${filenamePart(profile.displayName, "device")}-${protocolCode}${node}.${extension}`;
}
function bundleFilename(profile: Profile, count: number): string {
  const protocolCode = profile.protocol === "wireguard" ? "WG" : "OV";
  return `${filenamePart(profile.regionCode?.toUpperCase(), "AUTO", 8)}-${filenamePart(profile.regionName, "region", 14)}-${filenamePart(profile.displayName, "device")}-${protocolCode}-${count}nodes.zip`;
}
function activityLabel(value?: string | null): string {
  if (!value) return "尚未使用";
  const elapsed = Date.now() - new Date(value).getTime();
  if (elapsed < 60_000) return "刚刚使用";
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)} 分钟前使用`;
  if (elapsed < 24 * 60 * 60_000) return `${Math.floor(elapsed / 3_600_000)} 小时前使用`;
  return `${Math.floor(elapsed / 86_400_000)} 天前使用`;
}
function dateTimeLabel(value?: string | null): string {
  if (!value) return "尚无记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}
function protocolLabel(protocol: string): string {
  return protocol === "wireguard" ? "WireGuard" : protocol === "openvpn" ? "OpenVPN" : protocol;
}
function profileStatusLabel(status: string): string {
  return status === "active" ? "已启用" : status === "issued" ? "待使用" : status === "revoked" ? "已撤销" : status === "expired" ? "已过期" : status;
}
function latestTime(values: Array<string | null | undefined>): string | null {
  return values.filter(Boolean).sort((left, right) => new Date(right!).getTime() - new Date(left!).getTime())[0] || null;
}
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, credentials: "include", headers: { "Content-Type": "application/json", ...(init?.headers || {}) } });
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  if (!contentType.includes("application/json")) throw new Error(`API 返回了非 JSON 响应（HTTP ${response.status}），请检查 Portal 的 /api/ 反向代理。`);
  const body = text ? JSON.parse(text) as Record<string, unknown> : {};
  if (!response.ok) throw Object.assign(new Error(typeof body.error === "string" ? body.error : `请求失败（HTTP ${response.status}）`), { body, status: response.status });
  return body as T;
}

function Brand() { return <div className="brand"><span className="brand-mark"><i /><i /><i /></span><span>NORTHSTAR <em>VPN</em></span></div>; }

function Auth({ mode, onMode, onUser }: { mode: "login" | "register"; onMode: (mode: "login" | "register") => void; onUser: (user: User) => void }) {
  const [form, setForm] = useState({ displayName: "", email: "", password: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const result = await api<{ user: User; message?: string }>(mode === "login" ? "/api/v1/auth/web-login" : "/api/v1/auth/register", { method: "POST", body: JSON.stringify(form) });
      if (!result.user?.id) throw new Error("登录接口返回异常，请检查 Portal 的 /api/ 反向代理。");
      onUser(result.user);
    } catch (err) {
      const error = err as Error & { body?: { user?: User } };
      if (error.body?.user) onUser(error.body.user);
      else setError(error.message);
    } finally { setBusy(false); }
  }
  return <main className="auth-layout"><section className="auth-intro"><Brand /><p className="kicker">PRIVATE NETWORK FOR PEOPLE AROUND YOU</p><h1>连接到你<br /><span>信任的网络。</span></h1><p className="intro-copy">账号审核通过后，即可选择可用区域，生成 WireGuard 或 OpenVPN 配置。简单、透明，不做复杂套餐。</p><div className="trust"><span>●</span><div><b>人工审核</b><small>仅限受邀和熟悉的用户使用</small></div></div></section><form className="auth-panel" onSubmit={submit}><p className="kicker">{mode === "login" ? "WELCOME BACK" : "REQUEST ACCESS"}</p><h2>{mode === "login" ? "登录 Northstar" : "申请使用 VPN"}</h2><p className="muted">{mode === "login" ? "使用已审核的账号继续。" : "提交后由管理员人工审核。"}</p>{mode === "register" && <label>称呼<input required value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="例如：小王" /></label>}<label>邮箱<input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="you@example.com" /></label><label>密码<input type="password" minLength={12} required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="至少 12 位" /></label><button className="primary" disabled={busy}>{busy ? "处理中…" : mode === "login" ? "登录" : "提交申请"}<span>→</span></button>{error && <p className="error">{error}</p>}<button type="button" className="text-button" onClick={() => onMode(mode === "login" ? "register" : "login")}>{mode === "login" ? "还没有账号？申请使用" : "已有账号？返回登录"}</button></form></main>;
}

function Pending({ user, onLogout }: { user: User; onLogout: () => void }) { return <main className="center-page"><Brand /><div className="status-card"><span className="status-icon">…</span><p className="kicker">APPLICATION RECEIVED</p><h1>等待管理员审核</h1><p>账号 <b>{user.email}</b> 已提交。审核通过后即可登录并生成 VPN 配置。</p>{user.status === "rejected" && <p className="error">申请未通过：{user.rejectionReason || "请联系管理员"}</p>}<button className="secondary" onClick={onLogout}>返回</button></div></main>; }

// Kept as a rollback reference while the unified device center is rolled out.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function DashboardLegacy({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [regions, setRegions] = useState<Region[]>([]); const [devices, setDevices] = useState<Device[]>([]); const [profiles, setProfiles] = useState<Profile[]>([]); const [usage, setUsage] = useState<Usage | null>(null); const [credentialUsage, setCredentialUsage] = useState<CredentialUsage[]>([]);
  const [deviceName, setDeviceName] = useState("我的设备"); const [regionId, setRegionId] = useState(""); const [protocol, setProtocol] = useState("wireguard"); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState(""); const [error, setError] = useState(""); const [download, setDownload] = useState<GeneratedDownload | null>(null); const [downloadingProfileId, setDownloadingProfileId] = useState(""); const [revokingProfileId, setRevokingProfileId] = useState(""); const [profileDownloadNotice, setProfileDownloadNotice] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const selectedRegion = regions.find((item) => item.id === regionId); const protocols = selectedRegion?.protocols || ["wireguard", "openvpn"]; const selectedProtocolNodeCount = selectedRegion?.protocolNodeCounts?.[protocol] || 0;
  async function refresh() { const [availability, deviceResult, profileResult, usageResult, credentialResult] = await Promise.all([api<{ regions: Region[] }>("/api/v1/availability"), api<{ devices: Device[] }>("/api/v1/devices"), api<{ profiles: Profile[] }>("/api/v1/profiles"), api<Usage>("/api/v1/usage/summary"), api<{ credentials: CredentialUsage[] }>("/api/v1/usage/credentials")]); setRegions(availability.regions); setDevices(deviceResult.devices); setProfiles(profileResult.profiles); setUsage(usageResult); setCredentialUsage(credentialResult.credentials || []); if (!regionId) { const preferred = availability.regions.find((item) => item.status === "available") || availability.regions[0]; if (preferred) setRegionId(preferred.id); } }
  useEffect(() => { void refresh().catch((err) => setError((err as Error).message)); }, []);
  useEffect(() => { if (selectedRegion && !selectedRegion.protocols.includes(protocol)) setProtocol(selectedRegion.protocols[0] || "wireguard"); }, [selectedRegion, protocol]);
  async function createProfile(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setNotice(""); setDownload(null);
    try {
      const privateBytes = protocol === "wireguard" ? x25519.utils.randomSecretKey() : null;
      const clientPrivateKey = privateBytes ? base64(privateBytes) : undefined;
      const publicKey = privateBytes ? base64(x25519.getPublicKey(privateBytes)) : "openvpn-managed";
      const device = await api<{ device: Device }>("/api/v1/devices", {
        method: "POST",
        body: JSON.stringify({ displayName: deviceName || "我的设备", platform: "web", appVersion: "portal-0.2.0", publicKey }),
      });
      setDevices((items) => [device.device, ...items]);
      const issued = await api<{ profile: Profile; profiles?: Profile[] }>("/api/v1/profiles", {
        method: "POST",
        body: JSON.stringify({ deviceId: device.device.id, regionId: regionId || undefined, protocol, clientPrivateKey }),
      });
      const issuedProfiles = issued.profiles?.length ? issued.profiles : [issued.profile];
      const activeProfiles = await Promise.all(issuedProfiles.map(async (profile) => {
        const active = await api<{ profile: Profile }>(`/api/v1/profiles/${profile.id}/activate`, { method: "POST" });
        return { active: active.profile, issued: profile };
      }));
      const files = await Promise.all(activeProfiles.map(async ({ active, issued: source }) => {
        const response = await fetch(`/api/v1/profiles/${active.id}/download`, { credentials: "include" });
        const text = await response.text();
        if (!response.ok) throw new Error(text || "配置下载失败");
        const profile = {
          ...active,
          displayName: source.displayName || device.device.displayName,
          nodeName: source.nodeName,
          regionalNodeCount: source.regionalNodeCount,
          regionCode: source.regionCode || selectedRegion?.code,
          regionName: source.regionName || selectedRegion?.name,
        };
        return { name: profileFilename(profile), text, profile };
      }));
      if (files.length === 1) {
        setDownload({ profileId: files[0].profile.id, name: files[0].name, text: files[0].text });
        setNotice(protocol === "openvpn" && selectedRegion && (selectedRegion.protocolNodeCounts?.openvpn || 0) > 1
          ? `区域配置已生成，内含 ${selectedRegion.protocolNodeCounts?.openvpn} 个 OpenVPN 节点，可自动故障切换。`
          : "配置已生成，请下载后导入对应 VPN 客户端。");
      } else {
        setDownload({
          profileId: files[0].profile.id,
          name: bundleFilename(files[0].profile, files.length),
          files: files.map(({ name, text }) => ({ name, text })),
        });
        setNotice(`已生成 ${files.length} 个 WireGuard 节点配置，请下载 ZIP 后按需导入。`);
      }
      await refresh();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  async function revoke(device: Device) { if (!confirm(`撤销 ${device.displayName}？`)) return; try { await api(`/api/v1/devices/${device.id}/revoke`, { method: "POST" }); await refresh(); } catch (err) { setError((err as Error).message); } }
  function saveDownload() { if (download?.text) saveTextFile(download.name, download.text); else if (download?.files) saveBlobFile(download.name, createZipBlob(download.files)); }
  async function downloadProfile(profile: Profile) {
    setDownloadingProfileId(profile.id); setProfileDownloadNotice(null);
    try {
      const siblings = profile.protocol === "wireguard"
        ? availableProfiles.filter((item) => item.deviceId === profile.deviceId && item.protocol === profile.protocol)
        : [profile];
      const files = await Promise.all(siblings.map(async (item) => {
        const response = await fetch(`/api/v1/profiles/${item.id}/download`, { credentials: "include" });
        const text = await response.text();
        if (!response.ok) {
          let message = text || `配置下载失败（HTTP ${response.status}）`;
          try { const body = JSON.parse(text) as { error?: string }; if (body.error) message = body.error; } catch { /* plain-text error */ }
          throw new Error(message);
        }
        return { name: profileFilename(item), text };
      }));
      if (files.length > 1) saveBlobFile(bundleFilename(profile, files.length), createZipBlob(files));
      else saveTextFile(files[0].name, files[0].text);
      setProfileDownloadNotice({ tone: "success", message: files.length > 1 ? `包含 ${files.length} 个节点的配置包已开始下载。` : "下载已开始。" });
    } catch (err) {
      setProfileDownloadNotice({ tone: "error", message: (err as Error).message });
    } finally { setDownloadingProfileId(""); }
  }
  async function revokeProfile(profile: Profile) {
    const device = devices.find((item) => item.id === profile.deviceId);
    if (!device) { setProfileDownloadNotice({ tone: "error", message: "找不到该配置关联的设备，请刷新后重试。" }); return; }
    const siblingCount = profiles.filter((item) => item.deviceId === profile.deviceId && (item.status === "active" || item.status === "issued")).length;
    if (!confirm(`确定撤销这${siblingCount > 1 ? `组 ${siblingCount} 份` : "份"} ${profile.protocol === "wireguard" ? "WireGuard" : "OpenVPN"} 配置吗？\n\n同一设备下已导入客户端的配置都会失效。`)) return;
    setRevokingProfileId(profile.id); setProfileDownloadNotice(null);
    try {
      await api(`/api/v1/devices/${device.id}/revoke`, { method: "POST" });
      if (download?.profileId === profile.id) setDownload(null);
      await refresh();
      setProfileDownloadNotice({ tone: "success", message: "配置已撤销，节点正在同步失效状态。" });
    } catch (err) {
      setProfileDownloadNotice({ tone: "error", message: (err as Error).message });
    } finally { setRevokingProfileId(""); }
  }
  const maxDay = Math.max(...(usage?.daily || []).map((item) => item.totalBytes), 1);
  const availableProfiles = profiles.filter((profile) => profile.status === "active" || profile.status === "issued");
  const usageByProfile = new Map(credentialUsage.map((item) => [item.profileId, item]));
  return <main className="dashboard"><header><Brand /><div className="account"><span>{user.displayName.slice(0, 1).toUpperCase()}</span><div><b>{user.displayName}</b><small>{user.email}</small></div><button onClick={onLogout}>退出</button></div></header><section className="welcome"><div><p className="kicker">ACCOUNT ACTIVE</p><h1>你好，{user.displayName}。</h1><p>账号已审核，可以使用所有当前健康的 VPN 区域。</p></div><span className="active-badge">● 已审核</span></section><section className="stats"><article><small>本期总流量</small><strong>{formatBytes(usage?.totals.totalBytes || 0)}</strong><span>最近 30 天</span></article><article><small>下载</small><strong>{formatBytes(usage?.totals.downloadBytes || 0)}</strong><span>服务端发送给设备</span></article><article><small>上传</small><strong>{formatBytes(usage?.totals.uploadBytes || 0)}</strong><span>服务端收到的设备流量</span></article></section><RegionMap regions={regions} selectedRegionId={regionId} onSelect={setRegionId} /><div className="grid"><section className="card"><div className="card-head"><div><p className="kicker">GET CONNECTED</p><h2>生成 VPN 配置</h2></div><span className="muted">{selectedProtocolNodeCount > 1 ? `${selectedProtocolNodeCount} 个健康节点 · ${protocol === "openvpn" ? "自动切换" : "配置包"}` : "WireGuard 推荐"}</span></div><form className="form-grid" onSubmit={createProfile}><label>设备名称<input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} /></label><label>区域<select value={regionId} onChange={(e) => setRegionId(e.target.value)}><option value="">自动选择</option>{regions.map((region) => <option key={region.id} value={region.id}>{region.name} · {region.country} {region.status !== "available" ? "（不可用）" : ""}</option>)}</select></label><label>协议<select value={protocol} onChange={(e) => setProtocol(e.target.value)}>{protocols.map((item) => <option key={item} value={item}>{item === "wireguard" ? "WireGuard" : "OpenVPN"}</option>)}</select></label><button className="primary" disabled={busy || !regions.some((item) => item.status === "available")}>{busy ? "生成中…" : "生成并下载配置"}<span>→</span></button></form>{download && <div className="download-box"><b>配置已经准备好</b><p>{download.files ? `压缩包包含 ${download.files.length} 个节点配置；同一时间只需启用其中一个。` : "私钥已包含在配置中，请只保存到自己的设备。"}</p><button className="secondary" onClick={saveDownload}>下载 {download.name}</button>{download.text && <details><summary>查看配置文本</summary><pre>{download.text}</pre></details>}{download.files && <div className="bundle-files">{download.files.map((file) => <span key={file.name}>{file.name}</span>)}</div>}</div>}{notice && <p className="success">{notice}</p>}{error && <p className="error">{error}</p>}</section><section className="card"><div className="card-head"><div><p className="kicker">LAST 30 DAYS</p><h2>流量趋势</h2></div><span className="muted">约 1–2 分钟延迟</span></div><div className="bars">{(usage?.daily || []).slice(-14).map((day) => <div key={day.day} title={`${day.day} ${formatBytes(day.totalBytes)}`}><i style={{ height: `${Math.max(6, day.totalBytes / maxDay * 100)}%` }} /><small>{day.day.slice(5)}</small></div>)}</div></section></div><div className="grid lower"><section className="card"><div className="card-head"><div><p className="kicker">DEVICES</p><h2>我的设备</h2></div><b>{devices.filter((item) => item.status === "active").length} 个活动设备</b></div>{devices.length ? devices.map((device) => <div className="list-row" key={device.id}><span className="device-icon">{device.platform === "web" ? "WEB" : "VPN"}</span><div><b>{device.displayName}</b><small>{device.platform} · {device.status}</small></div>{device.status === "active" && <button className="danger-link" onClick={() => void revoke(device)}>撤销</button>}</div>) : <p className="empty">还没有设备，生成一份配置即可添加。</p>}</section><section className="card"><div className="card-head"><div><p className="kicker">PROFILES</p><h2>最近配置</h2></div><b>{availableProfiles.length} 个可用</b></div>{availableProfiles.slice(0, 5).map((profile) => { const item = usageByProfile.get(profile.id); return <div className="list-row profile-usage-row" key={profile.id}><span className="protocol-icon">{profile.protocol === "wireguard" ? "WG" : "OV"}</span><div><b><span className={`usage-state ${item?.online ? "online" : "idle"}`} />{profile.regionCode || "AUTO"} · {profile.protocol === "wireguard" ? "WireGuard" : "OpenVPN"}{(profile.regionalNodeCount || 0) > 1 ? ` · ${profile.regionalNodeCount} 节点自动切换` : profile.nodeName ? ` · ${profile.nodeName}` : ""}</b><small>{item?.online ? "使用中" : activityLabel(item?.lastActivityAt)} · 30 天 {formatBytes(item?.totalBytes || 0)}{item?.credentialSuffix ? ` · 凭据 …${item.credentialSuffix}` : ""}</small></div><div className="list-actions"><button className="text-link" disabled={Boolean(downloadingProfileId) || Boolean(revokingProfileId)} onClick={() => void downloadProfile(profile)}>{downloadingProfileId === profile.id ? "下载中…" : "下载"}</button><button className="danger-link" disabled={Boolean(downloadingProfileId) || Boolean(revokingProfileId)} onClick={() => void revokeProfile(profile)}>{revokingProfileId === profile.id ? "撤销中…" : "撤销"}</button></div></div>; })}{!availableProfiles.length && <p className="empty">还没有可用配置，生成后会显示在这里。</p>}{profileDownloadNotice && <p className={profileDownloadNotice.tone}>{profileDownloadNotice.message}</p>}</section></div><footer>Northstar · 流量统计仅用于查看，不包含配额或计费 · 数据以 UTC 日期汇总</footer></main>;
}

function Dashboard({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [regions, setRegions] = useState<Region[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [deviceUsage, setDeviceUsage] = useState<DeviceUsage[]>([]);
  const [credentialUsage, setCredentialUsage] = useState<CredentialUsage[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [deviceName, setDeviceName] = useState("我的设备");
  const [regionId, setRegionId] = useState("");
  const [protocol, setProtocol] = useState("wireguard");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [viewUpdatedAt, setViewUpdatedAt] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [download, setDownload] = useState<GeneratedDownload | null>(null);
  const [downloadingProfileId, setDownloadingProfileId] = useState("");
  const [profileDownloadNotice, setProfileDownloadNotice] = useState<{ tone: "success" | "error"; message: string } | null>(null);

  const selectedRegion = regions.find((item) => item.id === regionId);
  const protocols = selectedRegion?.protocols || ["wireguard", "openvpn"];
  const availableProfiles = profiles.filter((profile) => profile.status === "active" || profile.status === "issued");
  const usageByProfile = new Map(credentialUsage.map((item) => [item.profileId, item]));
  const usageByDevice = new Map(deviceUsage.map((item) => [item.deviceId, item]));
  const profilesByDevice = new Map<string, Profile[]>();
  profiles.forEach((profile) => profilesByDevice.set(profile.deviceId, [...(profilesByDevice.get(profile.deviceId) || []), profile]));
  const credentialsByDevice = new Map<string, CredentialUsage[]>();
  credentialUsage.forEach((item) => credentialsByDevice.set(item.deviceId, [...(credentialsByDevice.get(item.deviceId) || []), item]));
  const deviceCards = devices.map((device) => {
    const credentials = credentialsByDevice.get(device.id) || [];
    const allProfiles = profilesByDevice.get(device.id) || [];
    const currentProfiles = allProfiles.filter((profile) => profile.status === "active" || profile.status === "issued");
    const measured = usageByDevice.get(device.id);
    const uploadBytes = measured?.uploadBytes ?? credentials.reduce((sum, item) => sum + item.uploadBytes, 0);
    const downloadBytes = measured?.downloadBytes ?? credentials.reduce((sum, item) => sum + item.downloadBytes, 0);
    const deviceHeartbeat = device.lastSeenAt && device.createdAt && Math.abs(new Date(device.lastSeenAt).getTime() - new Date(device.createdAt).getTime()) > 1_000 ? device.lastSeenAt : null;
    const lastActivityAt = latestTime([deviceHeartbeat, ...credentials.map((item) => item.lastActivityAt), ...credentials.map((item) => item.lastSeenAt)]);
    return { device, credentials, allProfiles, currentProfiles, uploadBytes, downloadBytes, totalBytes: measured?.totalBytes ?? uploadBytes + downloadBytes, online: device.status === "active" && credentials.some((item) => item.online), lastActivityAt };
  });
  const selectedDevice = deviceCards.find((item) => item.device.id === selectedDeviceId) || deviceCards[0];
  const activeDeviceCount = deviceCards.filter((item) => item.device.status === "active").length;
  const onlineDeviceCount = deviceCards.filter((item) => item.online).length;
  const latestMeasurement = latestTime([usage?.updatedAt, ...credentialUsage.map((item) => item.observedAt)]);

  async function refresh() {
    const [availability, deviceResult, profileResult, usageResult, deviceUsageResult, credentialResult] = await Promise.all([
      api<{ regions: Region[] }>("/api/v1/availability"),
      api<{ devices: Device[] }>("/api/v1/devices"),
      api<{ profiles: Profile[] }>("/api/v1/profiles"),
      api<Usage>("/api/v1/usage/summary"),
      api<{ devices: DeviceUsage[] }>("/api/v1/usage/devices"),
      api<{ credentials: CredentialUsage[] }>("/api/v1/usage/credentials"),
    ]);
    setRegions(availability.regions); setDevices(deviceResult.devices); setProfiles(profileResult.profiles); setUsage(usageResult);
    setDeviceUsage(deviceUsageResult.devices || []); setCredentialUsage(credentialResult.credentials || []);
    setViewUpdatedAt(new Date().toISOString());
    if (!regionId) {
      const preferred = availability.regions.find((item) => item.status === "available") || availability.regions[0];
      if (preferred) setRegionId(preferred.id);
    }
  }

  useEffect(() => { void refresh().catch((err) => setError((err as Error).message)); }, []);
  useEffect(() => { if (selectedRegion && !selectedRegion.protocols.includes(protocol)) setProtocol(selectedRegion.protocols[0] || "wireguard"); }, [selectedRegion, protocol]);
  useEffect(() => { if (selectedDeviceId && deviceCards.some((item) => item.device.id === selectedDeviceId)) return; if (deviceCards[0]) setSelectedDeviceId(deviceCards[0].device.id); }, [devices, profiles, credentialUsage, deviceUsage]);

  async function refreshDashboard() {
    setRefreshing(true); setError("");
    try { await refresh(); } catch (err) { setError((err as Error).message); } finally { setRefreshing(false); }
  }

  async function createProfile(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setNotice(""); setDownload(null);
    try {
      const privateBytes = protocol === "wireguard" ? x25519.utils.randomSecretKey() : null;
      const clientPrivateKey = privateBytes ? base64(privateBytes) : undefined;
      const publicKey = privateBytes ? base64(x25519.getPublicKey(privateBytes)) : "openvpn-managed";
      const deviceResult = await api<{ device: Device }>("/api/v1/devices", { method: "POST", body: JSON.stringify({ displayName: deviceName || "我的设备", platform: "web", appVersion: "portal-0.3.0", publicKey }) });
      const issued = await api<{ profile: Profile; profiles?: Profile[] }>("/api/v1/profiles", { method: "POST", body: JSON.stringify({ deviceId: deviceResult.device.id, regionId: regionId || undefined, protocol, clientPrivateKey }) });
      const issuedProfiles = issued.profiles?.length ? issued.profiles : [issued.profile];
      const activeProfiles = await Promise.all(issuedProfiles.map(async (profile) => ({ active: (await api<{ profile: Profile }>(`/api/v1/profiles/${profile.id}/activate`, { method: "POST" })).profile, issued: profile })));
      const files = await Promise.all(activeProfiles.map(async ({ active, issued: source }) => {
        const response = await fetch(`/api/v1/profiles/${active.id}/download`, { credentials: "include" });
        const text = await response.text(); if (!response.ok) throw new Error(text || "配置下载失败");
        const named = { ...active, displayName: source.displayName || deviceResult.device.displayName, nodeName: source.nodeName, regionalNodeCount: source.regionalNodeCount, regionCode: source.regionCode || selectedRegion?.code, regionName: source.regionName || selectedRegion?.name };
        return { name: profileFilename(named), text, profile: named };
      }));
      if (files.length === 1) setDownload({ profileId: files[0].profile.id, name: files[0].name, text: files[0].text });
      else setDownload({ profileId: files[0].profile.id, name: bundleFilename(files[0].profile, files.length), files: files.map(({ name, text }) => ({ name, text })) });
      setNotice(files.length > 1 ? `已生成 ${files.length} 个节点配置，已归入设备「${deviceResult.device.displayName}」。` : `配置已生成，已归入设备「${deviceResult.device.displayName}」。`);
      setSelectedDeviceId(deviceResult.device.id); await refresh();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  async function downloadProfile(profile: Profile) {
    setDownloadingProfileId(profile.id); setProfileDownloadNotice(null);
    try {
      const siblings = profile.protocol === "wireguard" ? availableProfiles.filter((item) => item.deviceId === profile.deviceId && item.protocol === profile.protocol) : [profile];
      const files = await Promise.all(siblings.map(async (item) => { const response = await fetch(`/api/v1/profiles/${item.id}/download`, { credentials: "include" }); const text = await response.text(); if (!response.ok) throw new Error(text || "配置下载失败"); return { name: profileFilename(item), text }; }));
      if (files.length > 1) saveBlobFile(bundleFilename(profile, files.length), createZipBlob(files)); else saveTextFile(files[0].name, files[0].text);
      setProfileDownloadNotice({ tone: "success", message: files.length > 1 ? `已下载包含 ${files.length} 个节点的配置包。` : "配置下载已开始。" });
    } catch (err) { setProfileDownloadNotice({ tone: "error", message: (err as Error).message }); } finally { setDownloadingProfileId(""); }
  }

  async function revokeDevice(device: Device) {
    if (!confirm(`撤销「${device.displayName}」？\n\n该设备下的所有配置和证书都会失效。`)) return;
    try { await api(`/api/v1/devices/${device.id}/revoke`, { method: "POST" }); setSelectedDeviceId(""); await refresh(); }
    catch (err) { setError((err as Error).message); }
  }

  function saveDownload() { if (download?.text) saveTextFile(download.name, download.text); else if (download?.files) saveBlobFile(download.name, createZipBlob(download.files)); }
  const selectedCurrentProfiles = selectedDevice?.currentProfiles || [];
  const selectedHistoryProfiles = selectedDevice?.allProfiles.filter((profile) => profile.status !== "active" && profile.status !== "issued") || [];
  const maxDay = Math.max(...(usage?.daily || []).map((item) => item.totalBytes), 1);

  return <main className="dashboard"><header><Brand /><div className="account"><span>{user.displayName.slice(0, 1).toUpperCase()}</span><div><b>{user.displayName}</b><small>{user.email}</small></div><button onClick={onLogout}>退出</button></div></header>
    <section className="welcome"><div><p className="kicker">ACCOUNT ACTIVE</p><h1>你好，{user.displayName}。</h1><p>每台设备都有独立配置、独立流量和独立在线状态。</p></div><span className="active-badge">● 已审核</span></section>
    <section className="stats"><article><small>近 30 天总流量</small><strong>{formatBytes(usage?.totals.totalBytes || 0)}</strong><span>上传 {formatBytes(usage?.totals.uploadBytes || 0)} · 下载 {formatBytes(usage?.totals.downloadBytes || 0)}</span></article><article><small>当前在线设备</small><strong>{onlineDeviceCount}</strong><span>最近 2 分钟有握手或流量采样</span></article><article><small>可用连接配置</small><strong>{availableProfiles.length}</strong><span>{activeDeviceCount} 台设备可连接</span></article><article><small>数据更新时间</small><strong className="stats-time">{latestMeasurement ? activityLabel(latestMeasurement) : "暂无"}</strong><span>流量采样约有 1–2 分钟延迟</span></article></section>
    <RegionMap regions={regions} selectedRegionId={regionId} onSelect={setRegionId} />
    <div className="grid"><section className="card"><div className="card-head"><div><p className="kicker">GET CONNECTED</p><h2>创建新设备</h2></div><span className="muted">WireGuard 推荐</span></div><form className="form-grid" onSubmit={createProfile}><label>设备名称<input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} /></label><label>区域<select value={regionId} onChange={(e) => setRegionId(e.target.value)}><option value="">自动选择</option>{regions.map((region) => <option key={region.id} value={region.id}>{region.name} · {region.country} {region.status !== "available" ? "（不可用）" : ""}</option>)}</select></label><label>协议<select value={protocol} onChange={(e) => setProtocol(e.target.value)}>{protocols.map((item) => <option key={item} value={item}>{protocolLabel(item)}</option>)}</select></label><button className="primary" disabled={busy || !regions.some((item) => item.status === "available")}>{busy ? "生成中…" : "创建设备并生成配置"}<span>→</span></button></form>{download && <div className="download-box"><b>配置已归入设备</b><p>{download.files ? `压缩包包含 ${download.files.length} 个节点配置。` : "私钥已包含在配置中，请只保存到自己的设备。"}</p><button className="secondary" onClick={saveDownload}>下载 {download.name}</button></div>}{notice && <p className="success">{notice}</p>}{error && <p className="error">{error}</p>}</section><section className="card"><div className="card-head"><div><p className="kicker">LAST 30 DAYS</p><h2>流量趋势</h2></div><span className="muted">按 UTC 日期汇总</span></div><div className="bars">{(usage?.daily || []).slice(-14).map((day) => <div key={day.day} title={`${day.day} ${formatBytes(day.totalBytes)}`}><i style={{ height: `${Math.max(6, day.totalBytes / maxDay * 100)}%` }} /><small>{day.day.slice(5)}</small></div>)}</div></section></div>
    <section className="device-hub"><div className="device-hub-head"><div><p className="kicker">DEVICES &amp; CREDENTIALS</p><h2>我的设备</h2><p>设备是主对象，配置和证书都归属于设备。点击设备查看在线、流量和连接详情。</p></div><div className="device-hub-head-actions"><b>{onlineDeviceCount} 在线 · {devices.length} 台设备</b><button type="button" className="refresh-button" disabled={refreshing} onClick={() => void refreshDashboard()}><span className={refreshing ? "refresh-icon spinning" : "refresh-icon"}>↻</span>{refreshing ? "刷新中…" : "刷新数据"}</button><small>{viewUpdatedAt ? `更新于 ${dateTimeLabel(viewUpdatedAt)}` : "等待首次同步"}</small></div></div><div className="device-hub-layout"><div className="device-list">{deviceCards.length ? deviceCards.map((item) => <button type="button" className={`device-card ${selectedDevice?.device.id === item.device.id ? "selected" : ""}`} key={item.device.id} onClick={() => setSelectedDeviceId(item.device.id)}><span className="device-icon">{item.device.platform === "web" ? "WEB" : "VPN"}</span><span className="device-card-main"><strong>{item.device.displayName}</strong><small>{item.device.platform} · {item.currentProfiles.length ? `${item.currentProfiles.length} 个当前配置` : "尚未生成配置"}</small><small>{item.online ? "在线" : item.lastActivityAt ? activityLabel(item.lastActivityAt) : "尚未使用"} · 30 天 {formatBytes(item.totalBytes)}</small></span><span className={`presence-dot ${item.online ? "online" : ""}`} /></button>) : <p className="empty">还没有设备，创建一份配置即可添加。</p>}</div>
      {selectedDevice ? <article className="device-detail"><div className="device-detail-head"><div><div className="device-title-line"><span className={`presence-dot ${selectedDevice.online ? "online" : ""}`} /><h3>{selectedDevice.device.displayName}</h3><span className={`status-pill ${selectedDevice.device.status}`}>{selectedDevice.device.status === "active" ? (selectedDevice.online ? "在线" : "可连接") : "已撤销"}</span></div><p>{selectedDevice.device.platform} · 创建于 {dateTimeLabel(selectedDevice.device.createdAt)} · 最后活动 {selectedDevice.lastActivityAt ? dateTimeLabel(selectedDevice.lastActivityAt) : "尚未使用"}</p></div>{selectedDevice.device.status === "active" && <button className="danger-link" onClick={() => void revokeDevice(selectedDevice.device)}>撤销设备</button>}</div><div className="device-metrics"><div><small>近 30 天总流量</small><strong>{formatBytes(selectedDevice.totalBytes)}</strong></div><div><small>上传</small><strong>{formatBytes(selectedDevice.uploadBytes)}</strong></div><div><small>下载</small><strong>{formatBytes(selectedDevice.downloadBytes)}</strong></div><div><small>在线判定</small><strong>{selectedDevice.online ? "是" : "否"}</strong><span>{selectedDevice.online ? "最近 2 分钟活跃" : selectedDevice.lastActivityAt ? activityLabel(selectedDevice.lastActivityAt) : "没有握手记录"}</span></div></div><div className="credential-section"><div className="section-title"><div><p className="kicker">CURRENT CREDENTIALS</p><h4>当前连接配置</h4></div><span>{selectedCurrentProfiles.length} 份</span></div>{selectedCurrentProfiles.length ? selectedCurrentProfiles.map((profile, index) => { const item = usageByProfile.get(profile.id); return <div className="credential-row" key={profile.id}><span className="protocol-icon">{profile.protocol === "wireguard" ? "WG" : "OV"}</span><div className="credential-main"><strong>{protocolLabel(profile.protocol)} · {profile.regionCode || "AUTO"}{profile.nodeName ? ` · ${profile.nodeName}` : ""}</strong><small><span className={`usage-state ${item?.online ? "online" : ""}`} />{item?.online ? "在线使用中" : item?.lastActivityAt ? activityLabel(item.lastActivityAt) : "尚未使用"} · {formatBytes(item?.totalBytes || 0)} · 凭据 …{item?.credentialSuffix || "未知"}</small><small>签发 {dateTimeLabel(profile.issuedAt)} · 到期 {dateTimeLabel(profile.expiresAt)} · {profileStatusLabel(profile.status)}</small></div><div className="credential-actions">{index === 0 ? <button className="text-link" disabled={Boolean(downloadingProfileId)} onClick={() => void downloadProfile(profile)}>{downloadingProfileId === profile.id ? "下载中…" : selectedCurrentProfiles.length > 1 && profile.protocol === "wireguard" ? "下载节点包" : "下载配置"}</button> : <span className="muted">同组配置</span>}</div></div>; }) : <p className="empty">该设备暂无有效配置。</p>}{profileDownloadNotice && <p className={profileDownloadNotice.tone}>{profileDownloadNotice.message}</p>}</div><div className="credential-history"><div className="section-title"><div><p className="kicker">CREDENTIAL HISTORY</p><h4>历史凭证</h4></div><span>{selectedHistoryProfiles.length} 份</span></div>{selectedHistoryProfiles.length ? <div className="history-list">{selectedHistoryProfiles.slice(0, 5).map((profile) => <div key={profile.id}><span>{protocolLabel(profile.protocol)} · {profile.regionCode || "AUTO"}</span><small>{profileStatusLabel(profile.status)} · 签发于 {dateTimeLabel(profile.issuedAt)}</small></div>)}</div> : <p className="empty">暂时没有已撤销或过期的凭证。</p>}</div></article> : <div className="device-detail empty-detail"><span className="status-icon">＋</span><h3>创建第一台设备</h3><p>创建后，这里会显示证书状态、在线情况、流量和下载入口。</p></div>}</div></section>
    <footer>Northstar · 在线状态依据最近握手/流量采样判断 · 流量统计为近 30 天数据 · 数据以 UTC 日期汇总</footer></main>;
}

export default function App() { const [user, setUser] = useState<User | null>(null); const [mode, setMode] = useState<"login" | "register">("login"); const [loading, setLoading] = useState(true); useEffect(() => { api<{ user: User }>("/api/v1/auth/me").then((result) => setUser(result.user)).catch(() => undefined).finally(() => setLoading(false)); }, []); async function logout() { await fetch("/api/v1/auth/web-logout", { method: "POST", credentials: "include" }); setUser(null); setMode("login"); } if (loading) return <main className="center-page"><Brand /><p>正在连接 Northstar…</p></main>; if (!user) return <Auth mode={mode} onMode={setMode} onUser={setUser} />; if (user.status !== "active") return <Pending user={user} onLogout={() => void logout()} />; return <Dashboard user={user} onLogout={() => void logout()} />; }

createRoot(document.getElementById("root")!).render(<App />);
