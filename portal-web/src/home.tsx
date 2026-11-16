import { useCallback, useEffect, useState } from "react";
import { clientPlatforms, type ClientPlatform, type ClientRelease } from "../../shared/client-releases";
import { useI18n } from "../../shared/i18n";
import { intlLocales } from "../../shared/i18n-core";
import { PRODUCT_NAME } from "../../shared/brand-name";
import { useSite } from "../../shared/site";
import { useActionDialog } from "./action-dialog";
import { api, isUnauthorized } from "./api";
import { Brand } from "./brand";
import { detectPlatform, formatBytes } from "./format";
import { PortalLanguagePicker } from "./language";
import { HeroRing } from "./pixel";
import { QuotaBlocks, UsageCard, type Usage } from "./usage-card";
import { AccountSubscription, useAccountSubscription } from "./account-subscription";
import { InlineError, Skeleton, Time, useToasts } from "./ui";
import "./home.css";

type User = { email: string; displayName: string };
type Device = { id: string; name: string; platform: string; lastSeenAt: string; connected: boolean; region: string | null };
type Access = { state: "active" | "expired" | "exhausted" | "none"; until: string | null; quotaBytes: number | null; usedBytes: number; remainingBytes: number | null };
/** deviceLimit null = unlimited; deviceCount = app sign-ins plus single-node configs; online = places in use right now. */
type Account = { expiresAt: string | null; access: Access; deviceLimit: number | null; deviceCount: number; online: { apps: number; subscription: number; total: number }; devices: Device[] };

const SOON_DAYS = 7;
/** Whole days left until an end date, or null when the access has no end. */
const daysLeft = (until: string | null) => until ? Math.max(0, Math.ceil((Date.parse(until) - Date.now()) / 86_400_000)) : null;
type Releases = { releases: ClientRelease[]; history: ClientRelease[] };

const platformNames: Record<ClientPlatform, string> = { android: "Android", ios: "iPhone / iPad", macos: "macOS", windows: "Windows" };
/** Three-letter tiles in the pixel face, in place of device icons. */
const platformCodes: Record<ClientPlatform, string> = { android: "AND", ios: "IOS", macos: "MAC", windows: "WIN" };
const devicePlatform: Partial<Record<string, ClientPlatform>> = { android: "android", ios: "ios", mac: "macos", windows: "windows" };

/** A byte count split into number and unit, so the number can take the pixel face. */
const figure = (bytes: number) => { const [value, unit = ""] = formatBytes(bytes).split(" "); return [value, unit] as const; };
/** Dates as figures read the same in every language: 2027-03-01. */
const isoDate = (value: string) => { const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? value : `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`; };

/** Days until the remaining traffic runs out at the last seven days' average, or null when nothing was used. */
function daysToEmpty(usage: Usage | null, remaining: number) {
  const week = (usage?.daily || []).filter((row) => Date.parse(String(row.day).slice(0, 10)) >= Date.now() - 7 * 86_400_000);
  const perDay = week.reduce((sum, row) => sum + (Number(row.totalBytes) || 0), 0) / 7;
  return perDay > 0 ? Math.max(1, Math.floor(remaining / perDay)) : null;
}

/** Desktop builds come per architecture; ARM Windows reports itself only through client hints. */
function usePreferredArch() {
  const [arch, setArch] = useState<"x64" | "arm64">("x64");
  useEffect(() => {
    const hints = (navigator as Navigator & { userAgentData?: { getHighEntropyValues?: (keys: string[]) => Promise<{ architecture?: string }> } }).userAgentData;
    void hints?.getHighEntropyValues?.(["architecture"]).then((value) => { if (value.architecture === "arm") setArch("arm64"); }).catch(() => undefined);
  }, []);
  return arch;
}

/**
 * Home: import the account's subscription into a third-party app first (every account has every node), then the
 * account's figures and devices, a way to a single-node config, and our own apps last (only on the main site).
 */
export function Home({ user, onLogout, onManual }: { user: User; onLogout: () => void; onManual: () => void }) {
  const { t, locale } = useI18n();
  const site = useSite();
  const { ask, dialog } = useActionDialog();
  const { notify, toasts } = useToasts();
  const arch = usePreferredArch();
  const subscription = useAccountSubscription(onLogout);
  const ownApps = site?.isDefault !== false;
  const [releases, setReleases] = useState<Releases | null>(null), [releaseError, setReleaseError] = useState(false);
  const [account, setAccount] = useState<Account | null>(null), [usage, setUsage] = useState<Usage | null>(null), [accountError, setAccountError] = useState("");
  const [nodes, setNodes] = useState<number | null>(null);
  const [busy, setBusy] = useState("");

  const loadReleases = useCallback(() => {
    setReleaseError(false);
    void api<{ releases: ClientRelease[]; history?: ClientRelease[] }>("/api/v1/client-releases?history=1")
      .then((result) => setReleases({ releases: result.releases || [], history: result.history || [] }))
      .catch(() => setReleaseError(true));
  }, []);
  const loadAccount = useCallback(async () => {
    try {
      const [nextAccount, nextUsage] = await Promise.all([api<Account>("/api/v1/account"), api<Usage>(`/api/v1/usage/summary?from=${new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)}`)]);
      setAccount(nextAccount); setUsage(nextUsage); setAccountError("");
    } catch (caught) {
      if (isUnauthorized(caught)) onLogout(); else setAccountError((caught as Error).message);
    }
  }, [onLogout]);
  useEffect(() => {
    const initial = window.setTimeout(() => {
      if (ownApps) loadReleases();
      void loadAccount();
      void api<{ nodes: Array<{ protocols: string[] }> }>("/api/v1/availability").then((result) => setNodes((result.nodes || []).filter((node) => node.protocols.includes("vless")).length)).catch(() => undefined);
    }, 0);
    const timer = window.setInterval(() => { if (!document.hidden) void loadAccount(); }, 30_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [ownApps, loadReleases, loadAccount]);

  const mine = devicePlatform[detectPlatform()];
  const latest = (platform: ClientPlatform) => (releases?.releases || []).filter((item) => item.platform === platform);
  // This device's architecture applies to its own platform only; other platforms lead with their common build.
  const pick = (platform: ClientPlatform) => { const items = latest(platform), want = platform === mine ? arch : "x64"; return items.find((item) => item.arch === want) || items.find((item) => item.arch === "universal") || items[0]; };
  const href = (item: ClientRelease, current = true) => item.distribution === "direct" && current ? `/download/${item.platform}/${item.arch}` : item.url;
  const meta = (item: ClientRelease) => [item.version, item.arch === "universal" ? "" : item.arch, item.sizeBytes ? formatBytes(item.sizeBytes) : ""].filter(Boolean).join(" · ");
  const date = (value?: string) => { const parsed = new Date(value || ""); return Number.isNaN(parsed.getTime()) ? "" : new Intl.DateTimeFormat(intlLocales[locale], { dateStyle: "medium" }).format(parsed); };
  const siteName = site?.name || PRODUCT_NAME;
  // This device's platform first, then the rest in the usual order.
  const platforms = [...clientPlatforms].sort((a, b) => Number(b === mine) - Number(a === mine));

  async function signOut(device: Device) {
    const name = `${platformNames[device.platform as ClientPlatform] || device.platform} · ${device.name}`;
    if (!await ask({ title: t("让「{0}」退出登录？", [name]), description: t("这台设备会立即断开，需要重新输入密码才能再用。"), confirmLabel: t("退出登录"), danger: true })) return;
    setBusy(device.id);
    try {
      setAccount(await api<Account>(`/api/v1/account/devices/${device.id}`, { method: "DELETE" }));
      notify(t("已退出登录。"));
    } catch (caught) {
      if (isUnauthorized(caught)) onLogout(); else notify((caught as Error).message, "error");
    } finally { setBusy(""); }
  }

  const devices = account?.devices || [];
  const sub = subscription.subscription;
  const access = account?.access, quota = access?.quotaBytes ?? null, left = daysLeft(account?.expiresAt ?? null);
  const paused = access && access.state !== "active";
  const ending = access?.state === "active" && left !== null && left <= SOON_DAYS;
  const over = !!account && account.deviceLimit !== null && account.deviceCount > account.deviceLimit;
  const crowded = !!account && account.deviceLimit !== null && account.online.total > account.deviceLimit;
  const low = access?.state === "active" && quota !== null && (access.remainingBytes || 0) <= quota * 0.1;
  // Warn ahead of time: a quarter left, or the recent pace runs it out within a week (and before the account ends).
  const share = quota ? Math.round(((access?.remainingBytes || 0) / quota) * 100) : 100;
  const runsOut = quota !== null && access ? daysToEmpty(usage, access.remainingBytes || 0) : null;
  const tight = access?.state === "active" && quota !== null && (share <= 25 || (runsOut !== null && runsOut <= 7 && (left === null || runsOut < left)));
  return <main className="dashboard home">
    {dialog}{toasts}
    <Topbar user={user} onLogout={onLogout} />
    <AccountSubscription state={subscription} nodes={nodes} notify={notify} onLogout={onLogout} />

    {paused && <p className="callout warning home-access-notice" role="status">{access.state === "exhausted" ? t("流量已用完，暂时无法连接。请联系管理员增加流量。") : access.state === "expired" ? t("账号已到期，暂时无法连接。请联系管理员续期。") : t("账号暂未开通使用权限，请联系管理员。")}</p>}
    {!paused && tight ? <p className="callout warning home-access-notice" role="status">{runsOut !== null ? t("流量还剩 {0}%，按最近 7 天的用量大约 {1} 天后用完。", [share, runsOut]) : t("流量还剩 {0}%。", [share])}</p>
      : !paused && ending && <p className="callout warning home-access-notice" role="status">{t("账号还剩 {0} 天到期，到期后无法连接。请联系管理员续期。", [left ?? 0])}</p>}
    <section className="card home-stats" aria-label={t("账号概况")}>
      <div><small>{access?.state === "expired" ? t("已到期") : t("有效期至")}</small>{account ? account.expiresAt ? <strong className={`pixel-figure${ending ? " warning-text" : ""}`}>{isoDate(account.expiresAt)}</strong> : <strong>{t("长期有效")}</strong> : <Skeleton height={30} width="60%" />}
        {account?.expiresAt && <span className={`home-stat-note${ending ? " warning-text" : ""}`}>{ending ? t("还剩 {0} 天", [left ?? 0]) : date(account.expiresAt)}</span>}</div>
      <div><small>{t("剩余流量")}</small>{!account ? <Skeleton height={30} width="40%" /> : quota !== null && access ? <>
        <span className="home-traffic"><strong className={`pixel-figure${low ? " warning-text" : ""}`}>{figure(access.remainingBytes || 0)[0]}<span className="unit">{figure(access.remainingBytes || 0)[1]}</span></strong>
          <QuotaBlocks used={access.usedBytes} quota={quota} low={low || tight} /></span>
        <span className="home-stat-note">{t("已用 {0} / {1} · 全部节点合计", [formatBytes(access.usedBytes), formatBytes(quota)])}</span></> : <strong>{t("不限")}</strong>}</div>
      <div><small>{t("设备")}</small>{account ? <strong className={`pixel-figure${over ? " warning-text" : ""}`}>{account.deviceCount}<span className="unit">/ {account.deviceLimit ?? t("不限")}</span></strong> : <Skeleton height={30} width="40%" />}
        {over && account.deviceLimit !== null ? <span className="home-stat-note warning-text">{t("超出上限，只有最早的 {0} 个可用", [account.deviceLimit])}</span>
          : account && <span className={`home-stat-note${crowded ? " warning-text" : ""}`}>{t("现在在线 {0} 处", [account.online.total])}</span>}</div>
    </section>
    {accountError && <InlineError message={accountError} onRetry={() => void loadAccount()} />}
    <UsageCard usage={usage} onLogout={onLogout} />

    <section className="card home-list" aria-labelledby="devices-title">
      <h2 id="devices-title">{t("我的设备")}</h2>
      {!account ? <ul><li><Skeleton height={36} /></li><li><Skeleton height={36} /></li></ul>
        : devices.length || sub ? <ul>{devices.map((device) => <li key={device.id}>
          <span className={`presence ${device.connected ? "online" : ""}`} role="img" aria-label={device.connected ? t("正在使用") : t("未连接")} />
          <span className="home-row-main"><b>{platformNames[device.platform as ClientPlatform] || device.platform} · {device.name}</b>
            <small>{device.connected ? device.region ? t("正在使用 · {0}", [device.region]) : t("正在使用") : <Time value={device.lastSeenAt} />}</small></span>
          <button type="button" className="ghost small" disabled={busy === device.id} onClick={() => void signOut(device)}>{t("退出登录")}</button>
        </li>)}
          {sub && <li>
            <span className={`presence ${account.online.subscription ? "online" : ""}`} role="img" aria-label={account.online.subscription ? t("正在使用") : t("未连接")} />
            <span className="home-row-main"><b>{t("订阅链接")}</b>
              <small>{account.online.subscription ? t("{0} 处正在使用", [account.online.subscription]) : sub.lastFetchedAt ? <>{[t("最近更新"), sub.lastFetchClient].filter(Boolean).join(" · ")} · <Time value={sub.lastFetchedAt} /></> : t("还没有应用导入")}</small></span>
          </li>}</ul>
          : <p className="hint home-empty">{t("还没有设备。导入订阅或登录客户端后会显示在这里。")}</p>}
      {sub && <p className="hint">{t("订阅可以导入到任意多个应用，不占设备数。")}</p>}
      {account && account.deviceCount > devices.length && <p className="hint">{t("另有 {0} 个单节点配置也算在设备数里，不用的可以在「单个节点配置」里删除。", [account.deviceCount - devices.length])}</p>}
    </section>

    <button type="button" className="home-manual" onClick={onManual}>
      <span><b>{t("为单个节点创建配置")}</b><small>{t("选节点和协议，生成 WireGuard、OpenVPN 或 VLESS 单独配置")}</small></span>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
    </button>

    {ownApps && <section className="home-own" aria-labelledby="own-title">
      <div className="home-own-text">
        <HeroRing />
        <p className="home-meta">{siteName} App</p>
        <h2 id="own-title">{t("或者用我们的客户端")}</h2>
        <p className="home-lead">{t("自动选择最快的线路，断线时自动切换。下载后用这个账号登录即可。")}</p>
      </div>
      <div className="card home-list">
        {releaseError ? <InlineError message={t("暂时无法获取客户端版本，请稍后重试。")} onRetry={loadReleases} />
          : <ul>{platforms.map((platform) => {
            const item = releases ? pick(platform) : undefined;
            return <li key={platform}>
              <span className={`home-code${item ? "" : " off"}`} aria-hidden="true">{platformCodes[platform]}</span>
              <span className="home-row-main"><b>{platformNames[platform]}{platform === mine && <span className="import-tag">{t("本机")}</span>}</b><small>{!releases ? <Skeleton height={12} width={90} /> : item ? meta(item) : t("即将推出")}</small></span>
              {item && <a className={`${platform === mine ? "primary" : "secondary"} small`} href={href(item)} target="_blank" rel="noopener noreferrer">{item.distribution === "direct" ? t("下载") : t("获取")}</a>}
            </li>;
          })}</ul>}
        {releases && releases.releases.length > 0 && <details className="disclosure compact">
          <summary>{t("版本详情与历史版本")}</summary>
          <ul className="home-versions">{[...releases.releases.map((item) => ({ item, current: true })), ...releases.history.map((item) => ({ item, current: false }))].map(({ item, current }) => <li key={`${item.platform}:${item.arch}:${item.build}`}>
            <span className="home-row-main"><b>{platformNames[item.platform]} {meta(item)}</b><small>{[item.minOs, date(item.publishedAt)].filter(Boolean).join(" · ")}</small>
              {item.notes && <small className="release-notes">{item.notes}</small>}
              {item.sha256 && <code>SHA-256 {item.sha256}</code>}</span>
            <a className="ghost small" href={href(item, current)} target="_blank" rel="noopener noreferrer">{item.distribution === "direct" ? t("下载") : t("获取")}</a>
          </li>)}</ul>
        </details>}
      </div>
    </section>}
    <footer className="home-footer"><span className="home-footer-mark" aria-hidden="true">{siteName.toUpperCase()}</span><span>{t("{0} · 账号仅供本人使用，请勿分享。", [siteName])}</span></footer>
  </main>;
}

export function Topbar({ user, onLogout }: { user: User; onLogout: () => void }) {
  const { t } = useI18n();
  return <header className="topbar"><Brand /><div className="topbar-tools"><PortalLanguagePicker /><div className="account" title={user.email}><span className="avatar">{user.displayName.slice(0, 1).toUpperCase()}</span><div><b>{user.displayName}</b></div><button type="button" className="ghost small" onClick={onLogout}>{t("退出")}</button></div></div></header>;
}
