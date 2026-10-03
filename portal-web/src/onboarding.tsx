import { useState } from "react";
import { api, isUnauthorized } from "./api";
import { apps, recommendedApps, type AppId } from "./client-options";
import { detectPlatform, platformName } from "./format";
import { AppIcon, Icon, InlineError, type Notify } from "./ui";

/** First-run card shown instead of the connection list while the user has no connections. */
export function Onboarding({ protocols, notify, onCreated, onSingle, onUnauthorized }: {
  protocols: string[]; notify: Notify; onCreated: (credentialId: string, token: string) => void; onSingle: () => void; onUnauthorized: () => void;
}) {
  const platform = detectPlatform();
  const recommended = recommendedApps(platform);
  const choices = ["vless", "wireguard"].filter((item) => protocols.includes(item));
  const [choice, setChoice] = useState("vless");
  const protocol = choices.includes(choice) ? choice : choices[0] || "";
  const [busy, setBusy] = useState(false), [error, setError] = useState("");

  async function create() {
    setBusy(true); setError("");
    try {
      const result = await api<{ token: string; credentialId: string }>("/api/v1/subscriptions", { method: "POST", body: JSON.stringify({ name: "我的订阅", protocol }) });
      notify("订阅已创建。节点同步通常需要几十秒，之后即可导入。");
      onCreated(result.credentialId, result.token);
    } catch (caught) { if (isUnauthorized(caught)) onUnauthorized(); else setError((caught as Error).message); } finally { setBusy(false); }
  }
  const appLink = (id: AppId) => <a key={id} className="app-link" href={apps[id].url} target="_blank" rel="noreferrer"><AppIcon id={id} /><span><b>{apps[id].name}</b><small>{apps[id].platforms}</small></span>{Icon.external(16)}</a>;

  return <section className="card onboarding" aria-labelledby="onboarding-title">
    <div className="onboarding-head"><h2 id="onboarding-title">三步上手</h2><p>一份订阅包含全部可用节点，在客户端里随时切换。</p></div>
    <ol className="steps">
      <li><span className="step-no">1</span><h3>安装客户端</h3><p>为你的 {platformName[platform]} 推荐：</p>
        <div className="app-links">{recommended.map(appLink)}</div>
        <details className="disclosure compact"><summary>其他系统的客户端</summary><div className="app-links">{(["clash", "hiddify", "shadowrocket", "v2rayng"] as AppId[]).filter((id) => !recommended.includes(id)).map(appLink)}</div></details>
      </li>
      <li><span className="step-no">2</span><h3>一键创建订阅</h3><p>自动包含全部可用节点，有效期 1 年。</p>
        <button type="button" className="primary large wide" disabled={busy || !protocol} onClick={() => void create()}>{Icon.plus()}{busy ? "正在创建…" : protocol ? "创建订阅" : "暂无可用节点"}</button>
        {choices.length > 1 && <div className="inline-field"><span>连接方式</span><div className="segmented" role="group" aria-label="连接方式"><button type="button" aria-pressed={protocol === "vless"} onClick={() => setChoice("vless")}>VLESS · 推荐</button><button type="button" aria-pressed={protocol === "wireguard"} onClick={() => setChoice("wireguard")}>WireGuard</button></div></div>}
        <small className="hint">{protocol === "wireguard" ? "WireGuard 订阅仅支持 Clash / Hiddify；多台设备同时使用请各建一份。" : "VLESS 订阅支持 Clash、Hiddify、Shadowrocket、v2rayNG，可多设备同时使用。"}</small>
        {error && <InlineError message={error} onRetry={() => void create()} busy={busy} />}
      </li>
      <li><span className="step-no">3</span><h3>导入或扫码</h3><p>创建后点客户端按钮一键导入；手机打开二维码扫一扫即可。</p>
        <div className="preview-buttons" aria-hidden="true"><span><AppIcon id="clash" />Clash Verge</span><span><AppIcon id="hiddify" />Hiddify</span><span><span className="app-icon neutral">{Icon.qr()}</span>二维码</span></div>
      </li>
    </ol>
    <p className="onboarding-foot">需要 WireGuard / OpenVPN 官方客户端的固定配置？<button type="button" className="ghost small" onClick={onSingle}>改用指定节点 →</button></p>
  </section>;
}
