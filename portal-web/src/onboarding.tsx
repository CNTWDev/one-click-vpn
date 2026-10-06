import { useI18n } from "../../shared/i18n";
import { useState } from "react";
import { api, isUnauthorized } from "./api";
import { apps, recommendedApps, type AppId } from "./client-options";
import { detectPlatform, platformName } from "./format";
import { AppIcon, Icon, InlineError, type Notify } from "./ui";

/** First-run card shown instead of the connection list while the user has no connections. */
export function Onboarding({ protocols, notify, onCreated, onSingle, onUnauthorized }: {
  protocols: string[]; notify: Notify; onCreated: (credentialId: string, token: string) => void; onSingle: () => void; onUnauthorized: () => void;
}) {
  const { t } = useI18n();
  const platform = detectPlatform();
  const recommended = recommendedApps(platform);
  const choices = ["vless", "wireguard"].filter((item) => protocols.includes(item));
  const [choice, setChoice] = useState("vless");
  const protocol = choices.includes(choice) ? choice : choices[0] || "";
  const [busy, setBusy] = useState(false), [error, setError] = useState("");

  async function create() {
    setBusy(true); setError("");
    try {
      const result = await api<{ token: string; credentialId: string }>("/api/v1/subscriptions", { method: "POST", body: JSON.stringify({ name: t("我的订阅"), protocol }) });
      notify(t("订阅已创建。节点同步通常需要几十秒，之后即可导入。"));
      onCreated(result.credentialId, result.token);
    } catch (caught) { if (isUnauthorized(caught)) onUnauthorized(); else setError((caught as Error).message); } finally { setBusy(false); }
  }
  const appLink = (id: AppId) => <a key={id} className="app-link" href={apps[id].url} target="_blank" rel="noreferrer"><AppIcon id={id} /><span><b>{apps[id].name}</b><small>{t(apps[id].platforms)}</small></span>{Icon.external(16)}</a>;

  return <section className="card onboarding" aria-labelledby="onboarding-title">
    <div className="onboarding-head"><h2 id="onboarding-title">{t("三步上手")}</h2><p>{t("一份订阅包含全部可用节点，在客户端里随时切换。")}</p></div>
    <ol className="steps">
      <li><span className="step-no">1</span><h3>{t("安装客户端")}</h3><p>{t("为你的")}{platformName[platform]}{t("推荐：")}</p>
        <div className="app-links">{recommended.map(appLink)}</div>
        <details className="disclosure compact"><summary>{t("其他系统的客户端")}</summary><div className="app-links">{(["clash", "hiddify", "shadowrocket", "v2rayng"] as AppId[]).filter((id) => !recommended.includes(id)).map(appLink)}</div></details>
      </li>
      <li><span className="step-no">2</span><h3>{t("一键创建订阅")}</h3><p>{t("自动包含全部可用节点，有效期 1 年。")}</p>
        <button type="button" className="primary large wide" disabled={busy || !protocol} onClick={() => void create()}>{Icon.plus()}{busy ? t("正在创建…") : protocol ? t("创建订阅") : t("暂无可用节点")}</button>
        {choices.length > 1 && <div className="inline-field"><span>{t("连接方式")}</span><div className="segmented" role="group" aria-label={t("连接方式")}><button type="button" aria-pressed={protocol === "vless"} onClick={() => setChoice("vless")}>{t("VLESS · 推荐")}</button><button type="button" aria-pressed={protocol === "wireguard"} onClick={() => setChoice("wireguard")}>WireGuard</button></div></div>}
        <small className="hint">{protocol === "wireguard" ? t("WireGuard 订阅仅支持 Clash / Hiddify；多台设备同时使用请各建一份。") : t("VLESS 订阅支持 Clash、Hiddify、Shadowrocket、v2rayNG，可多设备同时使用。")}</small>
        {error && <InlineError message={error} onRetry={() => void create()} busy={busy} />}
      </li>
      <li><span className="step-no">3</span><h3>{t("导入或扫码")}</h3><p>{t("创建后点客户端按钮一键导入；手机打开二维码扫一扫即可。")}</p>
        <div className="preview-buttons" aria-hidden="true"><span><AppIcon id="clash" />Clash Verge</span><span><AppIcon id="hiddify" />Hiddify</span><span><span className="app-icon neutral">{Icon.qr()}</span>{t("二维码")}</span></div>
      </li>
    </ol>
    <p className="onboarding-foot">{t("需要 WireGuard / OpenVPN 官方客户端的固定配置？")}<button type="button" className="ghost small" onClick={onSingle}>{t("改用指定节点 →")}</button></p>
  </section>;
}
