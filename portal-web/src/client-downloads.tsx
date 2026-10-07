import { useEffect, useState } from "react";
import { clientPlatforms, type ClientPlatform, type ClientRelease } from "../../shared/client-releases";
import { useI18n } from "../../shared/i18n";
import { intlLocales } from "../../shared/i18n-core";
import { api } from "./api";
import { detectPlatform, formatBytes } from "./format";
import { InlineError, Skeleton } from "./ui";
import "./client-downloads.css";

const platformNames: Record<ClientPlatform, string> = { android: "Android", ios: "iPhone / iPad", macos: "macOS", windows: "Windows" };
const devicePlatform: Partial<Record<string, ClientPlatform>> = { android: "android", ios: "ios", mac: "macos", windows: "windows" };

/** Always-open download section: the current build per platform first, older published builds underneath. */
export function ClientDownloads() {
  const { t, locale } = useI18n();
  const [data, setData] = useState<{ releases: ClientRelease[]; history: ClientRelease[] }>({ releases: [], history: [] });
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ releases: ClientRelease[]; history?: ClientRelease[] }>("/api/v1/client-releases?history=1", { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) { setData({ releases: result.releases || [], history: result.history || [] }); setStatus("ready"); } })
      .catch(() => { if (!controller.signal.aborted) setStatus("error"); });
    return () => controller.abort();
  }, [retry]);

  // The visitor's own platform comes first.
  const mine = devicePlatform[detectPlatform()];
  const platforms = mine ? [mine, ...clientPlatforms.filter((item) => item !== mine)] : [...clientPlatforms];
  const date = (value?: string) => { const parsed = new Date(value || ""); return Number.isNaN(parsed.getTime()) ? "" : new Intl.DateTimeFormat(intlLocales[locale], { dateStyle: "medium" }).format(parsed); };
  const href = (item: ClientRelease, latest: boolean) => item.distribution === "direct" && latest ? `/download/${item.platform}/${item.arch}` : item.url;
  const action = (item: ClientRelease) => item.distribution === "direct" ? t("下载安装包") : item.distribution === "testflight" ? "TestFlight" : "App Store";

  return <section className="card client-downloads" aria-labelledby="downloads-title">
    <div className="section-head"><h2 id="downloads-title">{t("下载 Veilbird 客户端")}</h2><p className="hint">{t("登录即可使用，无需导入配置。")}</p></div>
    {status === "loading" ? <div className="client-download-grid" aria-busy="true">{platforms.map((key) => <article key={key}><Skeleton width="50%" /><Skeleton height={40} /></article>)}</div>
      : status === "error" ? <InlineError message={t("暂时无法获取客户端版本，请稍后重试。")} onRetry={() => { setStatus("loading"); setRetry((value) => value + 1); }} />
        : <div className="client-download-grid">{platforms.map((platform) => {
          const current = data.releases.filter((item) => item.platform === platform);
          const older = data.history.filter((item) => item.platform === platform);
          return <article key={platform} className={platform === mine ? "current-device" : ""}>
            <header><h3>{platformNames[platform]}</h3>{platform === mine && <span className="pill success">{t("当前设备")}</span>}</header>
            {current.length ? current.map((item) => <div className="client-download-item" key={item.arch}>
              <p><b>{item.version}</b> · {item.arch === "universal" ? t("通用") : item.arch}{item.sizeBytes ? ` · ${formatBytes(item.sizeBytes)}` : ""}</p>
              <small>{[item.minOs, date(item.publishedAt)].filter(Boolean).join(" · ")}</small>
              {item.notes && <p className="release-notes">{item.notes}</p>}
              <a className={platform === mine ? "primary" : "secondary"} href={href(item, true)} target="_blank" rel="noopener noreferrer">{action(item)}</a>
              {item.sha256 && <details className="checksum"><summary>SHA-256</summary><code>{item.sha256}</code></details>}
            </div>) : <p className="hint">{t("尚未发布，敬请期待")}</p>}
            {older.length > 0 && <details className="disclosure compact release-history"><summary>{t("历史版本")}<span>{older.length}</span></summary>
              <ul>{older.map((item) => <li key={`${item.arch}:${item.build}`}>
                <span><b>{item.version}</b><small>{item.arch === "universal" ? t("通用") : item.arch} · {date(item.publishedAt)}{item.sizeBytes ? ` · ${formatBytes(item.sizeBytes)}` : ""}</small>{item.notes && <small className="release-notes">{item.notes}</small>}</span>
                <a className="ghost small" href={href(item, false)} target="_blank" rel="noopener noreferrer">{action(item)}</a>
              </li>)}</ul>
            </details>}
          </article>;
        })}</div>}
  </section>;
}
