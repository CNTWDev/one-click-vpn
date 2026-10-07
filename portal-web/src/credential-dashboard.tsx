import { useI18n } from "../../shared/i18n";
import { Brand } from "./brand";
import { PortalLanguagePicker } from "./language";
import { ClientDownloads } from "./client-downloads";
import { intlLocales } from "../../shared/i18n-core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useActionDialog } from "./action-dialog";
import { api, fetchText, isUnauthorized } from "./api";
import { usableCredential, type ClientChoice } from "./client-options";
import { filenamePart, profileFilename, saveFiles, type Profile } from "./files";
import { dayLabel as formatDay, formatBytes, protocolLabel } from "./format";
import { NodeCreator, type AvailableNode, type NodePreset, type Region } from "./node-creator";
import { Onboarding } from "./onboarding";
import { RegionMap } from "./region-map";
import { SubscriptionAccess, type SubscriptionAccessHandle } from "./subscription-access";
import { AppIcon, Icon, InlineError, Menu, Modal, ProtocolBadge, QrCode, Skeleton, Time, useToasts } from "./ui";
import { SubscriptionPanel } from "../../shared/subscription-panel";

type User = { email: string; displayName: string };
type Credential = {
  subscriptionId?: string | null;
  expiringSoon: boolean; daysRemaining: number | null;
  userDisabled: boolean; adminDisabled: boolean; accountStatus: string; syncStatus: string;
  id: string; name: string; protocol: string; status: string; state: string; identitySuffix: string;
  online: boolean; connectionCount: number; lastActivityAt?: string | null; lastObservedAt?: string | null;
  profileCount: number; activeProfileCount: number; uploadBytes: number; downloadBytes: number; totalBytes: number;
  expiresAt?: string | null; revokedAt?: string | null; createdAt: string; updatedAt: string;
  certificate?: { id: string; serial?: string | null; subject?: string | null; pem?: string | null; fingerprint?: string; notBefore?: string | null; notAfter?: string | null } | null;
};
type Usage = { totals: { uploadBytes: number; downloadBytes: number; totalBytes: number }; daily: Array<{ day: string; totalBytes: number }>; updatedAt?: string };
type Issue = { message: string; retry?: () => void };

export function CredentialDashboard({ user, onLogout }: { user: User; onLogout: () => void }) {
  const { t, locale } = useI18n();
  const dayLabel = (value?: string | null) => t(formatDay(value, "长期有效", intlLocales[locale]));
const stateLabel = (value: string) => ({ disabled: t("已停用"), "admin-disabled": t("管理员已停用"), "account-disabled": t("账号已停用"), online: t("在线"), offline: t("离线"), "never-connected": t("尚未连接"), "telemetry-delayed": t("状态未知"), revoked: t("已撤销"), expired: t("已过期") } as Record<string, string>)[value] || value;
const statusLabel = (value: string) => ({ active: t("有效"), issued: t("待启用"), revoked: t("已撤销"), expired: t("已过期") } as Record<string, string>)[value] || value;
const presence = (item: Credential) => item.protocol === "vless" && item.online ? t("最近活跃") : stateLabel(item.state);
const tone = (state: string) => state === "online" ? "success" : ["offline", "never-connected", "telemetry-delayed"].includes(state) ? "neutral" : "danger";

  const { ask, dialog } = useActionDialog();
  const { notify, toasts } = useToasts();
  const [regions, setRegions] = useState<Region[]>([]);
  const [nodes, setNodes] = useState<AvailableNode[]>([]);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [stale, setStale] = useState(false), [loadError, setLoadError] = useState(""), [refreshing, setRefreshing] = useState(false);
  const [selectedId, setSelectedId] = useState(""), [filter, setFilter] = useState("all"), [regionId, setRegionId] = useState("");
  const [creating, setCreating] = useState<"" | "subscription" | "single">("");
  const [preset, setPreset] = useState<NodePreset & { key: number }>();
  const [freshTokens, setFreshTokens] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false), [issue, setIssue] = useState<Issue | null>(null);
  const [qr, setQr] = useState<{ title: string; text: string; hint: string } | null>(null);
  const accessRef = useRef<SubscriptionAccessHandle>(null), detailRef = useRef<HTMLElement>(null), creatorRef = useRef<HTMLElement>(null);

  const loaded = updatedAt !== null;
  const visible = credentials.filter((item) => filter === "all" || (filter === "subscription" ? !!item.subscriptionId : !item.subscriptionId));
  const selected = visible.find((item) => item.id === selectedId) || visible[0];
  const selectedProfiles = profiles.filter((item) => item.credentialId === selected?.id);
  const currentProfiles = selectedProfiles.filter((item) => item.status === "active" || item.status === "issued");
  const historyProfiles = selectedProfiles.filter((item) => item.status !== "active" && item.status !== "issued");
  const onlineCount = credentials.filter((item) => item.online).length;
  const canDownload = !!selected && usableCredential(selected) && currentProfiles.length > 0;
  const recentDays = (usage?.daily || []).slice(-14);
  const recentTotal = recentDays.reduce((sum, day) => sum + day.totalBytes, 0);
  const maxDay = Math.max(...recentDays.map((item) => item.totalBytes), 1);
  const protocols = [...new Set(nodes.flatMap((item) => item.protocols))];

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const [availability, credentialResult, profileResult, usageResult] = await Promise.all([
        api<{ regions: Region[]; nodes: AvailableNode[] }>("/api/v1/availability"),
        api<{ credentials: Credential[] }>("/api/v1/credentials"),
        api<{ profiles: Profile[] }>("/api/v1/profiles"),
        api<Usage>("/api/v1/usage/summary"),
      ]);
      const nextRegions = availability.regions || [], nextCredentials = credentialResult.credentials || [];
      setNodes(availability.nodes || []); setRegions(nextRegions); setCredentials(nextCredentials); setProfiles(profileResult.profiles || []); setUsage(usageResult);
      setUpdatedAt(new Date().toISOString()); setStale(false); setLoadError("");
      setSelectedId((current) => nextCredentials.some((item) => item.id === current) ? current : nextCredentials[0]?.id || "");
      setRegionId((current) => current && !nextRegions.some((item) => item.id === current) ? "" : current);
    } catch (caught) {
      if (isUnauthorized(caught)) { onLogout(); return; }
      setStale(true); if (!silent) setLoadError((caught as Error).message);
    } finally { if (!silent) setRefreshing(false); }
  }, [onLogout]);

  useEffect(() => {
    const initial = window.setTimeout(() => { void refresh(); }, 0);
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(true); }, 20_000);
    const onVisible = () => { if (!document.hidden) void refresh(true); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [refresh]);

  /** Runs a detail action; failures stay inline in the detail card with a retry. */
  async function perform(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setIssue(null);
    try { await task(); }
    catch (caught) { if (isUnauthorized(caught)) onLogout(); else setIssue({ message: (caught as Error).message, retry: () => void perform(task) }); }
    finally { setBusy(false); }
  }
  function select(id: string) {
    setSelectedId(id); setIssue(null);
    if (window.matchMedia("(max-width: 900px)").matches) window.requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }
  function openCreator(mode: "subscription" | "single", next?: NodePreset) {
    setCreating(mode); if (next) setPreset((current) => ({ ...next, key: (current?.key || 0) + 1 }));
    window.requestAnimationFrame(() => creatorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }
  function created(id: string, token?: string) {
    if (token) setFreshTokens((current) => ({ ...current, [id]: token }));
    if (id) { setSelectedId(id); setFilter("all"); }
    void refresh(true);
  }

  function downloadProfiles(target: Credential, format: "native" | "mihomo") {
    return perform(async () => {
      const targets = target.protocol === "wireguard" ? currentProfiles : [currentProfiles[0]];
      const files = await Promise.all(targets.map(async (profile) => {
        const filename = profileFilename({ ...profile, displayName: target.name });
        return { name: format === "mihomo" ? filename.replace(/\.conf$/, `-${profile.id}-Mihomo.yaml`) : filename, text: await fetchText(`/api/v1/profiles/${profile.id}/download${format === "mihomo" ? "?format=mihomo" : ""}`) };
      }));
      saveFiles(files, `${filenamePart(target.name, "credential")}-${format === "mihomo" ? "Mihomo" : target.protocol === "wireguard" ? "WG" : "OV"}.zip`);
      notify(format === "mihomo" ? t("配置开始下载。多节点压缩包请先解压，再选择一份 YAML 导入。") : t("配置开始下载，在客户端选择「从文件导入」。"));
    });
  }
  function profileLink(target: Credential, action: "copy" | "qr") {
    return perform(async () => {
      const vless = target.protocol === "vless";
      const text = (await fetchText(`/api/v1/profiles/${currentProfiles[0].id}/download${vless ? "?format=uri" : ""}`)).trim();
      if (action === "qr") setQr(vless
        ? { title: t("扫码导入节点"), text, hint: t("Shadowrocket / v2rayNG / Hiddify 扫码即可添加这个节点。链接仅供本人使用。") }
        : { title: t("扫码导入 WireGuard"), text, hint: t("WireGuard 手机客户端：＋ → 扫描二维码。二维码包含私钥，请勿截图分享。") });
      else { await navigator.clipboard.writeText(text); notify(t("vless:// 链接已复制，在客户端选择「从剪贴板导入」。")); }
    });
  }
  async function rename(target: Credential) {
    const next = await ask({ title: t("修改连接名称"), description: t("名称只用于区分连接，不影响现有配置。"), confirmLabel: t("保存名称"), initialValue: target.name });
    if (!next || next === target.name) return;
    await perform(async () => { await api(`/api/v1/credentials/${target.id}`, { method: "PATCH", body: JSON.stringify({ name: next }) }); await refresh(true); notify(t("名称已更新。")); });
  }
  async function changeAccess(target: Credential, action: "enable" | "disable" | "delete") {
    const copy = {
      enable: { title: t("启用「{0}」？", [target.name]), description: t("节点同步后恢复使用。管理员或账号限制仍需由管理员解除。"), confirmLabel: t("启用") },
      disable: { title: t("停用「{0}」？", [target.name]), description: t("节点同步后，所有配置副本暂停使用。之后可以重新启用，无需重新导入。"), confirmLabel: t("停用") },
      delete: { title: t("删除「{0}」？", [target.name]), description: t("删除后立即永久失效：所有客户端里的订阅和配置都无法再连接，连接从列表移除。历史流量保留。此操作不可恢复。"), confirmLabel: t("永久删除"), danger: true },
    }[action];
    if (!await ask(copy)) return;
    await perform(async () => {
      const result = await api<{ sync: { status: string } }>(`/api/v1/credentials/${target.id}`, { method: "PATCH", body: JSON.stringify({ action }) });
      await refresh(true);
      if (result.sync.status === "failed") throw new Error(t("已保存，但节点同步失败，请稍后重试或联系管理员。"));
      notify(action === "delete" ? t("连接已删除，所有配置立即失效。") : action === "disable" ? t("已停用，节点同步后生效。") : t("已启用，节点同步后生效。"));
    });
  }
  async function bulkAccess(action: "disable" | "revoke") {
    if (!await ask(action === "disable"
      ? { title: t("停用全部连接？"), description: t("节点同步后，你的全部有效连接暂停使用，可以逐个重新启用。"), confirmLabel: t("全部停用") }
      : { title: t("删除全部连接？"), description: t("你的全部连接和所有配置副本将立即永久失效，无法恢复。"), confirmLabel: t("全部永久删除"), danger: true })) return;
    await perform(async () => { await api("/api/v1/credentials", { method: "PATCH", body: JSON.stringify({ action }) }); await refresh(true); notify(t("批量操作已保存，节点同步后生效。")); });
  }
  function prepareReplacement(target: Credential) {
    if (target.subscriptionId) { openCreator("subscription"); notify(t("创建新订阅并导入后，可删除旧连接。")); return; }
    const previous = selectedProfiles[0];
    const region = regions.find((item) => item.code === previous?.regionCode && item.name === previous?.regionName);
    if (region) setRegionId(region.id);
    const client: ClientChoice = target.protocol === "openvpn" ? "openvpn" : target.protocol === "wireguard" ? "wireguard" : "hiddify";
    openCreator("single", { name: t("{0}（换发）", [target.name]), client, nodeId: previous?.nodeId || "" });
    notify(t("已填好换发信息。新配置导入并验证后，再删除旧连接。"));
  }

  const hero = <section className="hero">
    <div>
      <h1>{!loaded ? loadError ? t("{0}，你好", [user.displayName]) : <Skeleton height={34} width={240} /> : credentials.length ? t("{0}，你好", [user.displayName]) : t("{0}，欢迎使用 Veilbird", [user.displayName])}</h1>
      {loaded && credentials.length > 0 && <p className="hero-stats">{t("{0} 个连接 · {1} 个在线 · 近 30 天 {2}", [credentials.length, onlineCount, formatBytes(usage?.totals.totalBytes)])}</p>}
    </div>
    {loaded && credentials.length > 0 && <button type="button" className={creating ? "secondary" : "primary"} onClick={() => creating ? setCreating("") : openCreator("subscription")}>{creating ? t("收起") : <>{Icon.plus()}{t("新建连接")}</>}</button>}
  </section>;

  const creator = creating && <section className="card creator" ref={creatorRef} aria-labelledby="creator-title">
    <div className="card-head"><h2 id="creator-title">{t("新建连接")}</h2><button type="button" className="icon-button" aria-label={t("关闭")} onClick={() => setCreating("")}>{Icon.close()}</button></div>
    <div className="mode-switch" role="group" aria-label={t("连接模式")}>
      <button type="button" aria-pressed={creating === "subscription"} onClick={() => setCreating("subscription")}><b>{t("订阅")}<em>{t("推荐")}</em></b><small>{t("一次导入全部节点，自动更新")}</small></button>
      <button type="button" aria-pressed={creating === "single"} onClick={() => setCreating("single")}><b>{t("指定节点")}</b><small>{t("固定一个节点，下载独立配置")}</small></button>
    </div>
    {creating === "subscription"
      ? <SubscriptionPanel api={api} createOnly availableProtocols={protocols} onCreated={(id, token) => { setCreating(""); notify(t("订阅已创建，节点同步约需几十秒，之后在下方导入。")); created(id, token); }} />
      : <NodeCreator key={preset?.key || 0} nodes={nodes} regions={regions} regionId={regionId} onRegion={setRegionId} preset={preset} notify={notify} onCreated={created} onUnauthorized={onLogout} />}
  </section>;

  const detail = selected && <article className="detail" ref={detailRef} key={selected.id} aria-labelledby="detail-title">
    <div className="detail-head">
      <div className="detail-title"><h3 id="detail-title">{selected.name}<span className={`status ${tone(selected.state)}`}>{presence(selected)}</span></h3><p>{t("{0} · 有效期至 {1}", [selected.subscriptionId ? t("{0} 订阅", [protocolLabel(selected.protocol)]) : `${protocolLabel(selected.protocol)} · ${currentProfiles[0]?.nodeName ? `${currentProfiles[0].regionName || ""} ${currentProfiles[0].nodeName}`.trim() : t("尚未生成配置")}`, dayLabel(selected.expiresAt)])}</p></div>
      <Menu label={t("管理连接")} items={[
        { label: t("改名"), onSelect: () => void rename(selected), disabled: busy },
        selected.status === "active" && { label: selected.userDisabled ? t("启用") : t("停用"), onSelect: () => void changeAccess(selected, selected.userDisabled ? "enable" : "disable"), disabled: busy || selected.adminDisabled },
        selected.status === "active" && !selected.adminDisabled && !selected.userDisabled && { label: t("换发连接"), onSelect: () => prepareReplacement(selected) },
        !!selected.subscriptionId && usableCredential(selected) && { label: t("重置订阅链接"), onSelect: () => accessRef.current?.resetLink() },
        "-",
        { label: t("删除（立即永久失效）"), danger: true, onSelect: () => void changeAccess(selected, "delete"), disabled: busy },
      ]} />
    </div>
    {selected.syncStatus !== "applied" && <p className="callout warning">{selected.syncStatus === "failed" ? t("更改尚未同步到节点，请稍后刷新或联系管理员。") : t("更改正在同步到节点，请稍候。")}</p>}
    {(selected.expiringSoon || selected.status === "expired") && <div className="callout warning"><p>{selected.status === "expired" ? t("连接已到期，请换发后重新导入。") : t("还有 {0} 天到期，请提前换发。", [selected.daysRemaining])}</p>{!selected.adminDisabled && !selected.userDisabled && <button type="button" className="secondary small" disabled={busy} onClick={() => prepareReplacement(selected)}>{t("换发连接")}</button>}</div>}
    {selected.subscriptionId
      ? <SubscriptionAccess key={selected.subscriptionId} ref={accessRef} id={selected.subscriptionId} protocol={selected.protocol} initialToken={freshTokens[selected.id]} disabled={!usableCredential(selected)} notify={notify} onChanged={() => void refresh(true)} />
      : <section className="access" aria-label={t("下载配置")}>
        <div className="access-head"><h4>{currentProfiles.length > 1 && selected.protocol !== "openvpn" ? t("下载配置包 · {0} 个节点", [currentProfiles.length]) : t("导入到客户端")}</h4></div>
        <div className="client-buttons">
          {selected.protocol === "openvpn" && <button type="button" className="client-button" disabled={busy || !canDownload} onClick={() => void downloadProfiles(selected, "native")}><AppIcon id="openvpn" /><span><b>OpenVPN Connect</b><small>{t("下载 .ovpn 文件")}</small></span></button>}
          {selected.protocol === "wireguard" && <button type="button" className="client-button" disabled={busy || !canDownload} onClick={() => void downloadProfiles(selected, "native")}><AppIcon id="wireguard" /><span><b>WireGuard</b><small>{t("下载 .conf 文件")}</small></span></button>}
          {selected.protocol !== "openvpn" && <>
            <button type="button" className="client-button" disabled={busy || !canDownload} onClick={() => void downloadProfiles(selected, "mihomo")}><AppIcon id="hiddify" /><span><b>Hiddify</b><small>{t("下载 YAML 配置")}</small></span></button>
            <button type="button" className="client-button" disabled={busy || !canDownload} onClick={() => void downloadProfiles(selected, "mihomo")}><AppIcon id="clash" /><span><b>Clash Verge</b><small>{t("Mihomo 内核")}</small></span></button>
          </>}
          {selected.protocol === "vless" && <button type="button" className="client-button" disabled={busy || !canDownload} onClick={() => void profileLink(selected, "copy")}><span className="app-icon neutral">{Icon.copy()}</span><span><b>{t("复制链接")}</b><small>{t("vless:// 单节点")}</small></span></button>}
          {(selected.protocol === "vless" || (selected.protocol === "wireguard" && currentProfiles.length === 1)) && <button type="button" className="client-button" disabled={busy || !canDownload} onClick={() => void profileLink(selected, "qr")}><span className="app-icon neutral">{Icon.qr()}</span><span><b>{t("二维码")}</b><small>{t("手机扫码导入")}</small></span></button>}
        </div>
        <p className={`hint ${usableCredential(selected) ? "" : "warning"}`}>{!usableCredential(selected) ? t("当前连接不可用，恢复后才能下载；管理员限制请联系管理员解除。") : selected.protocol === "wireguard" ? t("同一份 WireGuard 连接请勿在多个设备同时开启。") : t("下载后在客户端选择「从文件导入」。")}</p>
      </section>}
    {issue && <InlineError message={issue.message} onRetry={issue.retry} busy={busy} />}
    <div className="tiles">
      <div><small>{t("近 30 天流量")}</small><strong>{formatBytes(selected.totalBytes)}</strong><span>↑ {formatBytes(selected.uploadBytes)} · ↓ {formatBytes(selected.downloadBytes)}</span></div>
      <div><small>{selected.protocol === "vless" ? t("使用状态") : t("当前连接")}</small><strong>{selected.protocol === "vless" ? selected.online ? t("最近活跃") : t("暂无活动") : selected.connectionCount}</strong><span>{t("最近活动")} <Time value={selected.lastActivityAt} fallback={t("尚未使用")} /></span></div>
    </div>
    <details className="disclosure">
      <summary>{t("配置与证书详情")}</summary>
      <dl className="facts"><div><dt>{t("底层协议")}</dt><dd>{protocolLabel(selected.protocol)}</dd></div><div><dt>{t("创建时间")}</dt><dd><Time value={selected.createdAt} /></dd></div><div><dt>{t("到期时间")}</dt><dd><Time value={selected.expiresAt} relative={false} fallback={t("长期有效")} /></dd></div><div><dt>{t("连接身份")}</dt><dd>…{selected.identitySuffix}</dd></div>
        {selected.certificate && <><div><dt>{t("证书到期")}</dt><dd><Time value={selected.certificate.notAfter} relative={false} /></dd></div><div><dt>{t("序列号")}</dt><dd><code>{selected.certificate.serial || "—"}</code></dd></div><div><dt>{t("SHA-256 指纹")}</dt><dd><code>{selected.certificate.fingerprint || "—"}</code></dd></div></>}
      </dl>
      {selected.certificate?.pem && <details className="disclosure compact"><summary>{t("查看公开证书")}</summary><pre>{selected.certificate.pem}</pre></details>}
      <h5>{t("当前配置 ·")}{currentProfiles.length}{t("份")}</h5>
      <ul className="plain-list">{currentProfiles.map((profile) => <li key={profile.id}><span>{profile.regionName || t("自动区域")} · {profile.nodeName || "—"}</span><small>{statusLabel(profile.status)} {t("· 到期")} {dayLabel(profile.expiresAt)}</small></li>)}</ul>
      {historyProfiles.length > 0 && <><h5>{t("历史配置 ·")}{historyProfiles.length}{t("份")}</h5><ul className="plain-list">{historyProfiles.slice(0, 8).map((profile) => <li key={profile.id}><span>{profile.regionName || profile.regionCode}</span><small>{statusLabel(profile.status)} · <Time value={profile.issuedAt} /></small></li>)}</ul></>}
    </details>
  </article>;

  const regionOf = (id: string) => profiles.find((item) => item.credentialId === id && (item.status === "active" || item.status === "issued"))?.regionName;
  const counts = { all: credentials.length, subscription: credentials.filter((item) => item.subscriptionId).length, single: credentials.filter((item) => !item.subscriptionId).length };
  const connections = !loaded
    ? loadError
      ? <section className="card"><InlineError message={t("无法读取连接：{0}", [loadError])} onRetry={() => void refresh()} busy={refreshing} /></section>
      : <section className="card connections" aria-busy="true" aria-label={t("正在读取")}><div className="split"><div className="list">{[0, 1, 2].map((key) => <div className="list-item" key={key}><Skeleton height={36} width={36} /><span className="list-main"><Skeleton width="60%" /><Skeleton height={12} width="85%" /></span></div>)}</div><div className="detail"><Skeleton height={28} width="45%" /><Skeleton height={14} width="70%" /><div className="client-buttons">{[0, 1, 2, 3].map((key) => <Skeleton key={key} height={64} />)}</div><Skeleton height={80} /></div></div></section>
    : !credentials.length
      ? <Onboarding protocols={protocols} notify={notify} onCreated={created} onSingle={() => openCreator("single")} onUnauthorized={onLogout} />
      : <section className="card connections" aria-labelledby="connections-title">
        <div className="section-head">
          <h2 id="connections-title">{t("我的连接")}</h2>
          <div className="segmented" role="group" aria-label={t("筛选连接")}>{([["all", t("全部")], ["subscription", t("订阅")], ["single", t("节点配置")]] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}<span>{counts[value]}</span></button>)}</div>
          <span className="updated">{stale && <span className="warning-text">{t("暂时无法更新，显示上次结果")}</span>}<button type="button" className="icon-button" aria-label={t("刷新")} title={t("刷新")} disabled={refreshing} onClick={() => void refresh()}><span className={refreshing ? "spin" : ""}>{Icon.refresh(17)}</span></button></span>
          <Menu label={t("全部连接管理")} plain items={[{ label: t("停用全部连接"), onSelect: () => void bulkAccess("disable"), disabled: busy }, "-", { label: t("删除全部（立即永久失效）"), danger: true, onSelect: () => void bulkAccess("revoke"), disabled: busy }]} />
        </div>
        {stale && loadError && <InlineError message={loadError} onRetry={() => void refresh()} busy={refreshing} />}
        <div className="split">
          <div className="list" role="list">{visible.length ? visible.map((item) => <button type="button" role="listitem" aria-current={selected?.id === item.id} className={`list-item ${selected?.id === item.id ? "selected" : ""}`} key={item.id} onClick={() => select(item.id)}>
            <ProtocolBadge protocol={item.protocol} subscription={!!item.subscriptionId} />
            <span className="list-main"><strong>{item.name}</strong><small>{item.subscriptionId ? t("订阅 · {0}", [formatBytes(item.totalBytes)]) : `${regionOf(item.id) || protocolLabel(item.protocol)} · ${formatBytes(item.totalBytes)}`}</small></span>
            <span className={`presence ${item.online ? "online" : ""}`} role="img" aria-label={presence(item)} title={presence(item)} />
          </button>) : <p className="hint">{t("暂无此类连接。")}</p>}</div>
          {detail || <div className="detail empty-detail"><p>{t("选择左侧的连接查看详情。")}</p></div>}
        </div>
      </section>;

  return <main className="dashboard">
    {dialog}{toasts}
    <header className="topbar"><Brand /><div className="topbar-tools"><PortalLanguagePicker /><div className="account" title={user.email}><span className="avatar">{user.displayName.slice(0, 1).toUpperCase()}</span><div><b>{user.displayName}</b></div><button type="button" className="ghost small" onClick={onLogout}>{t("退出")}</button></div></div></header>
    {hero}
    {creator}
    {connections}
    {loaded && credentials.length > 0 && <section className="card usage-panel" aria-labelledby="usage-title">
      <div className="section-head"><h2 id="usage-title">{t("流量趋势 · 近 14 天")}</h2><span className="updated">{t("累计")} {formatBytes(recentTotal)} · ↑ {formatBytes(usage?.totals.uploadBytes)} ↓ {formatBytes(usage?.totals.downloadBytes)}</span></div>
      {recentTotal > 0 ? <div className="bars" role="img" title={t("按连接汇总，日期为 UTC，不区分安装在哪台设备。")} aria-label={t("近 14 天流量，累计 {0}", [formatBytes(recentTotal)])}>{recentDays.map((day) => <div key={day.day} title={`${day.day} · ${formatBytes(day.totalBytes)}`}><i style={{ height: `${day.totalBytes > 0 ? Math.max(2, day.totalBytes / maxDay * 100) : 0}%` }} /><small>{day.day.slice(5)}</small></div>)}</div> : <p className="hint">{t("开始连接后，这里会显示流量趋势。")}</p>}
    </section>}
    <ClientDownloads />
    {loaded && <details className="disclosure panel"><summary>{t("可用区域地图")}<span>{regions.length}{t("个区域")}</span></summary><RegionMap regions={regions} selectedRegionId={regionId} onSelect={(id) => { setRegionId(id); openCreator("single"); }} /></details>}
    <Modal open={!!qr} title={qr?.title || t("二维码")} onClose={() => setQr(null)}>{qr && <div className="stack center"><QrCode text={qr.text} label={qr.title} /><p className="hint">{qr.hint}</p><div className="dialog-actions"><button type="button" className="primary" onClick={() => { void navigator.clipboard.writeText(qr.text).then(() => notify(t("已复制。"))).catch(() => notify(t("浏览器不允许自动复制。"), "error")); }}>{Icon.copy(16)}{t("复制内容")}</button></div></div>}</Modal>
    <footer>{t("Veilbird · 配置仅供本人使用，请勿分享或上传第三方转换网站。")}</footer>
  </main>;
}
