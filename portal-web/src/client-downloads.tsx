import { useEffect, useState } from "react";
import { clientPlatforms, type ClientRelease } from "../../shared/client-releases";
import { useI18n } from "../../shared/i18n";
import { api } from "./api";
import "./client-downloads.css";

const platformNames = { android: "Android", ios: "iPhone / iPad", macos: "macOS", windows: "Windows" };
export function ClientDownloads() {
  const { t } = useI18n();
  const [releases, setReleases] = useState<ClientRelease[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ releases: ClientRelease[] }>("/api/v1/client-releases", { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) { setReleases(result.releases || []); setStatus("ready"); } })
      .catch(() => { if (!controller.signal.aborted) setStatus("error"); });
    return () => controller.abort();
  }, [retry]);
  return <details className="network-disclosure client-downloads">
    <summary>{t("下载 NORTHSTAR 客户端")}</summary>
    <p>{t("正式版本发布后，可在这里下载安装。iPhone 和 iPad 通过 App Store 分发。")}</p>
    {status === "loading" ? <p role="status">{t("正在读取…")}</p> : status === "error" ? <div role="alert"><p>{t("暂时无法获取客户端版本，请稍后重试。")}</p><button className="secondary" onClick={() => { setStatus("loading"); setRetry((value) => value + 1); }}>{t("重试")}</button></div> :
      <div className="client-download-grid">{clientPlatforms.map((platform) => {
        const available = releases.filter((item) => item.platform === platform);
        return <article key={platform}><h3>{platformNames[platform]}</h3>{available.length ? available.map((item) => <div className="client-download-item" key={item.arch}>
          <p>{item.version} · {item.arch} · {item.minOs}</p>
          <a className="secondary" href={item.url} target="_blank" rel="noopener noreferrer">{item.distribution === "direct" ? t("下载安装包") : t("前往 App Store")}</a>
          {item.sha256 && <details><summary>{t("校验信息")}</summary><small>SHA-256</small><code>{item.sha256}</code></details>}
        </div>) : <p>{t("尚未发布，敬请期待")}</p>}</article>;
      })}</div>}
  </details>;
}
