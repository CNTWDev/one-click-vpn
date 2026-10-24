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
import { DataStream, HeroRing, UsageBlocks } from "./pixel";
import { Icon, InlineError, Skeleton, Time, useToasts } from "./ui";
import "./home.css";

type User = { email: string; displayName: string };
type Device = { id: string; name: string; platform: string; lastSeenAt: string; connected: boolean; region: string | null };
type Account = { expiresAt: string | null; deviceLimit: number; devices: Device[] };
type Usage = { totals: { totalBytes: number; uploadBytes?: number; downloadBytes?: number }; daily?: { day: string; totalBytes: number }[] };
type Releases = { releases: ClientRelease[]; history: ClientRelease[] };

const platformNames: Record<ClientPlatform, string> = { android: "Android", ios: "iPhone / iPad", macos: "macOS", windows: "Windows" };
/** Three-letter tiles in the pixel face, in place of device icons. */
const platformCodes: Record<ClientPlatform, string> = { android: "AND", ios: "IOS", macos: "MAC", windows: "WIN" };
const devicePlatform: Partial<Record<string, ClientPlatform>> = { android: "android", ios: "ios", mac: "macos", windows: "windows" };

/** A byte count split into number and unit, so the number can take the pixel face. */
const figure = (bytes: number) => { const [value, unit = ""] = formatBytes(bytes).split(" "); return [value, unit] as const; };
/** Dates as figures read the same in every language: 2027-03-01. */
const isoDate = (value: string) => { const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? value : `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`; };

/** Daily totals for the last 30 days, oldest first, with empty days as zero. */
function lastDays(usage: Usage) {
  const perDay = new Map((usage.daily || []).map((row) => [String(row.day).slice(0, 10), row.totalBytes]));
  return Array.from({ length: 30 }, (_, index) => {
    const day = new Date(Date.now() - (29 - index) * 86_400_000);
    const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    return perDay.get(key) || 0;
  });
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

/** The current device's app first and alone; every other platform as one equal row; manual setup last. */
export function Home({ user, onLogout, onManual }: { user: User; onLogout: () => void; onManual: () => void }) {
  const { t, locale } = useI18n();
  const site = useSite();
  const { ask, dialog } = useActionDialog();
  const { notify, toasts } = useToasts();
  const arch = usePreferredArch();
  const [releases, setReleases] = useState<Releases | null>(null), [releaseError, setReleaseError] = useState(false);
  const [account, setAccount] = useState<Account | null>(null), [usage, setUsage] = useState<Usage | null>(null), [accountError, setAccountError] = useState("");
  const [busy, setBusy] = useState("");

  const loadReleases = useCallback(() => {
    setReleaseError(false);
    void api<{ releases: ClientRelease[]; history?: ClientRelease[] }>("/api/v1/client-releases?history=1")
      .then((result) => setReleases({ releases: result.releases || [], history: result.history || [] }))
      .catch(() => setReleaseError(true));
  }, []);
  const loadAccount = useCallback(async () => {
    try {
      const [nextAccount, nextUsage] = await Promise.all([api<Account>("/api/v1/account"), api<Usage>("/api/v1/usage/summary")]);
      setAccount(nextAccount); setUsage(nextUsage); setAccountError("");
    } catch (caught) {
      if (isUnauthorized(caught)) onLogout(); else setAccountError((caught as Error).message);
    }
  }, [onLogout]);
  useEffect(() => {
    const initial = window.setTimeout(() => { loadReleases(); void loadAccount(); }, 0);
    const timer = window.setInterval(() => { if (!document.hidden) void loadAccount(); }, 30_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [loadReleases, loadAccount]);

  const mine = devicePlatform[detectPlatform()];
  const latest = (platform: ClientPlatform) => (releases?.releases || []).filter((item) => item.platform === platform);
  /** One build per platform: this device's architecture, else a universal build, else the first. */
  // This device's architecture applies to its own platform only; other platforms lead with their common build.
  const pick = (platform: ClientPlatform) => { const items = latest(platform), want = platform === mine ? arch : "x64"; return items.find((item) => item.arch === want) || items.find((item) => item.arch === "universal") || items[0]; };
  const href = (item: ClientRelease, current = true) => item.distribution === "direct" && current ? `/download/${item.platform}/${item.arch}` : item.url;
  const action = (item: ClientRelease, name: string) => item.distribution === "app-store" ? t("在 App Store 获取") : item.distribution === "testflight" ? t("通过 TestFlight 安装") : t("下载 {0} 版", [name]);
  const meta = (item: ClientRelease) => [item.version, item.arch === "universal" ? "" : item.arch, item.sizeBytes ? formatBytes(item.sizeBytes) : ""].filter(Boolean).join(" · ");
  const date = (value?: string) => { const parsed = new Date(value || ""); return Number.isNaN(parsed.getTime()) ? "" : new Intl.DateTimeFormat(intlLocales[locale], { dateStyle: "medium" }).format(parsed); };
  const siteName = site?.name || PRODUCT_NAME;
  const featured = mine && releases ? pick(mine) : undefined;
  const others = clientPlatforms.filter((platform) => platform !== (featured ? mine : undefined));

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

  const preview = <div className="home-preview" aria-hidden="true">
    <HeroRing />
    <span className="home-stream"><DataStream /><DataStream count={12} salt={1} className="dim" /></span>
  </div>;
  const hero = !releases
    ? <section className="home-hero" aria-busy={!releaseError}>{releaseError
      ? <InlineError message={t("暂时无法获取客户端版本，请稍后重试。")} onRetry={loadReleases} />
      : <div className="home-hero-text"><Skeleton width={120} /><Skeleton height={34} width="70%" /><Skeleton width="50%" /><Skeleton height={48} width={220} /></div>}{preview}</section>
    : featured && mine
      ? <section className="home-hero" aria-labelledby="home-title">
        <div className="home-hero-text">
          <p className="home-meta">{[platformNames[mine], meta(featured)].join(" · ")}</p>
          <h1 id="home-title">{t("在 {0} 上使用 {1}", [platformNames[mine], siteName])}</h1>
          <p className="home-lead">{t("下载安装后，用这个账号登录即可。")}</p>
          <div className="home-download">
            <a className="primary large" href={href(featured)} target="_blank" rel="noopener noreferrer">{Icon.download()}{action(featured, platformNames[mine])}</a>
            {latest(mine).filter((item) => item !== featured).map((item) => <a key={item.arch} href={href(item)} target="_blank" rel="noopener noreferrer">{t("下载 {0} 版", [item.arch])}</a>)}
          </div>
        </div>
        {preview}
      </section>
      : <section className="home-hero" aria-labelledby="home-title">
        <div className="home-hero-text">
          <p className="muted">{t("{0}，你好", [user.displayName])}</p>
          <h1 id="home-title">{mine ? t("{0} 版即将推出", [platformNames[mine]]) : t("下载 {0} 客户端", [siteName])}</h1>
          <p className="home-lead">{t("可以先在下面的设备上使用，用同一个账号登录。")}</p>
          <div className="home-download"><button type="button" className="secondary wrap" onClick={onManual}>{t("在这台设备上用其他客户端")}</button></div>
        </div>
        {preview}
      </section>;

  const devices = account?.devices || [];
  return <main className="dashboard home">
    {dialog}{toasts}
    <Topbar user={user} onLogout={onLogout} />
    {hero}

    <section className="card home-stats" aria-label={t("账号概况")}>
      <div><small>{t("有效期至")}</small>{account ? account.expiresAt ? <strong className="pixel-figure">{isoDate(account.expiresAt)}</strong> : <strong>{t("长期有效")}</strong> : <Skeleton height={30} width="60%" />}
        {account?.expiresAt && <span className="home-stat-note">{date(account.expiresAt)}</span>}</div>
      <div><small>{t("近 30 天流量")}</small>
        {usage ? <span className="home-traffic"><strong className="pixel-figure">{figure(usage.totals.totalBytes)[0]}<span className="unit">{figure(usage.totals.totalBytes)[1]}</span></strong><UsageBlocks values={lastDays(usage)} /></span> : <Skeleton height={30} width="40%" />}
        {usage && <span className="home-stat-note mono">↓ {formatBytes(usage.totals.downloadBytes || 0)} · ↑ {formatBytes(usage.totals.uploadBytes || 0)}</span>}</div>
      <div><small>{t("已登录设备")}</small>{account ? <strong className="pixel-figure">{devices.length}<span className="unit">/ {account.deviceLimit}</span></strong> : <Skeleton height={30} width="40%" />}
        {account && <a className="home-stat-note" href="#devices-title">{t("我的设备")}</a>}</div>
    </section>
    {accountError && <InlineError message={accountError} onRetry={() => void loadAccount()} />}

    <div className="home-columns">
      <section className="card home-list" aria-labelledby="platforms-title">
        <h2 id="platforms-title">{featured ? t("其他平台") : t("全部平台")}</h2>
        <ul>{others.map((platform) => {
          const item = releases ? pick(platform) : undefined;
          return <li key={platform}>
            <span className={`home-code${item ? "" : " off"}`} aria-hidden="true">{platformCodes[platform]}</span>
            <span className="home-row-main"><b>{platformNames[platform]}</b><small>{!releases ? <Skeleton height={12} width={90} /> : item ? meta(item) : t("即将推出")}</small></span>
            {item && <a className="secondary small" href={href(item)} target="_blank" rel="noopener noreferrer">{item.distribution === "direct" ? t("下载") : t("获取")}</a>}
          </li>;
        })}</ul>
        {releases && releases.releases.length > 0 && <details className="disclosure compact">
          <summary>{t("版本详情与历史版本")}</summary>
          <ul className="home-versions">{[...releases.releases.map((item) => ({ item, current: true })), ...releases.history.map((item) => ({ item, current: false }))].map(({ item, current }) => <li key={`${item.platform}:${item.arch}:${item.build}`}>
            <span className="home-row-main"><b>{platformNames[item.platform]} {meta(item)}</b><small>{[item.minOs, date(item.publishedAt)].filter(Boolean).join(" · ")}</small>
              {item.notes && <small className="release-notes">{item.notes}</small>}
              {item.sha256 && <code>SHA-256 {item.sha256}</code>}</span>
            <a className="ghost small" href={href(item, current)} target="_blank" rel="noopener noreferrer">{item.distribution === "direct" ? t("下载") : t("获取")}</a>
          </li>)}</ul>
        </details>}
      </section>

      <section className="card home-list" aria-labelledby="devices-title">
        <h2 id="devices-title">{t("我的设备")}</h2>
        {!account ? <ul><li><Skeleton height={36} /></li><li><Skeleton height={36} /></li></ul>
          : devices.length ? <ul>{devices.map((device) => <li key={device.id}>
            <span className={`presence ${device.connected ? "online" : ""}`} role="img" aria-label={device.connected ? t("正在使用") : t("未连接")} />
            <span className="home-row-main"><b>{platformNames[device.platform as ClientPlatform] || device.platform} · {device.name}</b>
              <small>{device.connected ? device.region ? t("正在使用 · {0}", [device.region]) : t("正在使用") : <Time value={device.lastSeenAt} />}</small></span>
            <button type="button" className="ghost small" disabled={busy === device.id} onClick={() => void signOut(device)}>{t("退出登录")}</button>
          </li>)}</ul>
            : <p className="hint home-empty">{t("还没有设备登录。安装客户端并登录后会显示在这里。")}</p>}
        {devices.length > 0 && <p className="hint">{t("设备丢了？在这里让它退出登录。")}</p>}
      </section>
    </div>

    <button type="button" className="home-manual" onClick={onManual}>
      <span><b>{t("使用其他客户端")}</b><small>{t("Clash、Shadowrocket、WireGuard、OpenVPN 等，手动导入订阅或配置")}</small></span>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
    </button>
    <footer className="home-footer"><span className="home-footer-mark" aria-hidden="true">{siteName.toUpperCase()}</span><span>{t("{0} · 账号仅供本人使用，请勿分享。", [siteName])}</span></footer>
  </main>;
}

export function Topbar({ user, onLogout }: { user: User; onLogout: () => void }) {
  const { t } = useI18n();
  return <header className="topbar"><Brand /><div className="topbar-tools"><PortalLanguagePicker /><div className="account" title={user.email}><span className="avatar">{user.displayName.slice(0, 1).toUpperCase()}</span><div><b>{user.displayName}</b></div><button type="button" className="ghost small" onClick={onLogout}>{t("退出")}</button></div></div></header>;
}
