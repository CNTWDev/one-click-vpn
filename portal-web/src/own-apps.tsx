import { useCallback, useEffect, useState } from "react";
import { clientPlatforms, type ClientPlatform, type ClientRelease } from "../../shared/client-releases";
import { useI18n } from "../../shared/i18n";
import { intlLocales } from "../../shared/i18n-core";
import { PRODUCT_NAME } from "../../shared/brand-name";
import { useSite } from "../../shared/site";
import { api } from "./api";
import { detectPlatform, formatBytes } from "./format";
import { HeroRing } from "./pixel";
import { InlineError, Skeleton } from "./ui";

type Releases = { releases: ClientRelease[]; history: ClientRelease[] };

export const platformNames: Record<ClientPlatform, string> = { android: "Android", ios: "iPhone / iPad", macos: "macOS", windows: "Windows" };
/** Three-letter tiles in the pixel face, in place of device icons. */
const platformCodes: Record<ClientPlatform, string> = { android: "AND", ios: "IOS", macos: "MAC", windows: "WIN" };
const devicePlatform: Partial<Record<string, ClientPlatform>> = { android: "android", ios: "ios", mac: "macos", windows: "windows" };

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
 * Our own app, the first thing on the home: the ring, one big download for this device when its build is out, the
 * other platforms as rows, and every version behind one disclosure. Shown on the main site only.
 */
export function OwnApps() {
  const { t, locale } = useI18n();
  const site = useSite();
  const arch = usePreferredArch();
  const [releases, setReleases] = useState<Releases | null>(null), [error, setError] = useState(false);
  const load = useCallback(() => {
    setError(false);
    void api<{ releases: ClientRelease[]; history?: ClientRelease[] }>("/api/v1/client-releases?history=1")
      .then((result) => setReleases({ releases: result.releases || [], history: result.history || [] }))
      .catch(() => setError(true));
  }, []);
  useEffect(() => { const timer = window.setTimeout(load, 0); return () => window.clearTimeout(timer); }, [load]);

  const mine = devicePlatform[detectPlatform()];
  const latest = (platform: ClientPlatform) => (releases?.releases || []).filter((item) => item.platform === platform);
  // This device's architecture applies to its own platform only; other platforms lead with their common build.
  const pick = (platform: ClientPlatform) => { const items = latest(platform), want = platform === mine ? arch : "x64"; return items.find((item) => item.arch === want) || items.find((item) => item.arch === "universal") || items[0]; };
  const href = (item: ClientRelease, current = true) => item.distribution === "direct" && current ? `/download/${item.platform}/${item.arch}` : item.url;
  const meta = (item: ClientRelease) => [item.version, item.arch === "universal" ? "" : item.arch, item.sizeBytes ? formatBytes(item.sizeBytes) : ""].filter(Boolean).join(" · ");
  const date = (value?: string) => { const parsed = new Date(value || ""); return Number.isNaN(parsed.getTime()) ? "" : new Intl.DateTimeFormat(intlLocales[locale], { dateStyle: "medium" }).format(parsed); };
  const label = (item: ClientRelease) => item.distribution === "direct" ? t("下载") : t("获取");
  // This device's build, when it is out, becomes the big button; every other platform is a row.
  const hero = mine && releases ? pick(mine) : undefined;
  const rows = clientPlatforms.filter((platform) => !(hero && platform === mine)).sort((a, b) => Number(b === mine) - Number(a === mine));

  return <article className="home-app" aria-labelledby="home-title">
    <div className="home-app-head">
      <div className="home-app-text">
        <p className="home-tagline"><span className="home-badge">{t("推荐")}</span><span className="home-meta">{site?.name || PRODUCT_NAME} App</span></p>
        <h1 id="home-title">{t("下载客户端，登录即用")}</h1>
        <p className="home-lead">{t("自动选择最快的线路，断线时自动切换。")}</p>
        {!releases && !error ? <Skeleton height={52} width={220} />
          : hero && <div className="home-app-download">
            <a className="primary big" href={href(hero)} target="_blank" rel="noopener noreferrer">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" aria-hidden="true"><path d="M9 2v10M4.5 8L9 12.5 13.5 8M3 16h12" /></svg>
              {hero.distribution === "direct" ? t("下载 {0} 版", [platformNames[hero.platform]]) : t("获取 {0} 版", [platformNames[hero.platform]])}
            </a>
            <span className="home-app-meta">{meta(hero)}</span>
          </div>}
      </div>
      <HeroRing />
    </div>
    {error ? <InlineError message={t("暂时无法获取客户端版本，请稍后重试。")} onRetry={load} />
      : <div className="home-app-others">
        {hero && <p className="home-app-label">{t("其他平台")}</p>}
        <ul className="home-app-rows">{rows.map((platform) => {
          const item = releases ? pick(platform) : undefined;
          return <li key={platform}>
            <span className={`home-code${item ? "" : " off"}`} aria-hidden="true">{platformCodes[platform]}</span>
            <span className="home-row-main"><b>{platformNames[platform]}{platform === mine && <span className="import-tag">{t("本机")}</span>}</b><small>{!releases ? <Skeleton height={12} width={90} /> : item ? meta(item) : t("即将推出")}</small></span>
            {item && <a className={`${platform === mine ? "primary" : "secondary"} small`} href={href(item)} target="_blank" rel="noopener noreferrer">{label(item)}</a>}
          </li>;
        })}</ul>
      </div>}
    {releases && releases.releases.length > 0 && <details className="disclosure compact home-versions-wrap">
      <summary>{t("版本详情与历史版本")}</summary>
      <ul className="home-versions">{[...releases.releases.map((item) => ({ item, current: true })), ...releases.history.map((item) => ({ item, current: false }))].map(({ item, current }) => <li key={`${item.platform}:${item.arch}:${item.build}`}>
        <span className="home-row-main"><b>{platformNames[item.platform]} {meta(item)}</b><small>{[item.minOs, date(item.publishedAt)].filter(Boolean).join(" · ")}</small>
          {item.notes && <small className="release-notes">{item.notes}</small>}
          {item.sha256 && <code>SHA-256 {item.sha256}</code>}</span>
        <a className="ghost small" href={href(item, current)} target="_blank" rel="noopener noreferrer">{label(item)}</a>
      </li>)}</ul>
    </details>}
  </article>;
}
