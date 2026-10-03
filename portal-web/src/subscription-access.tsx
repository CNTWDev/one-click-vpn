import { useImperativeHandle, useState, type FormEvent, type Ref } from "react";
import { api } from "./api";
import { importUrls, subscriptionLink, type RoutingMode, type SubscriptionFormat } from "./format";
import { AppIcon, Icon, InlineError, Modal, QrCode, type Notify } from "./ui";

type Action = "clash" | "hiddify" | "shadowrocket" | "copy" | "qr" | "reset";
export type SubscriptionAccessHandle = { resetLink: () => void };

/** Secret retrieval is owner-only, password verified on first use and never persisted in browser storage. */
export function SubscriptionAccess({ id, protocol, disabled, initialToken = "", notify, onChanged, ref }: {
  id: string; protocol: string; disabled: boolean; initialToken?: string; notify: Notify; onChanged: () => void; ref?: Ref<SubscriptionAccessHandle>;
}) {
  const [token, setToken] = useState(initialToken), [mode, setMode] = useState<RoutingMode>("smart");
  const [pending, setPending] = useState<Action | null>(null), [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [qr, setQr] = useState<SubscriptionFormat | null>(null);
  const vless = protocol === "vless";
  const link = (format: SubscriptionFormat = "clash", value = token) => value ? subscriptionLink(value, { format, mode }) : "";
  useImperativeHandle(ref, () => ({ resetLink: () => { setError(""); setPassword(""); setPending("reset"); } }), []);

  function copy(text: string) {
    void navigator.clipboard.writeText(text)
      .then(() => notify("订阅链接已复制。在客户端选择「添加订阅」或「从剪贴板导入」即可。"))
      .catch(() => notify("浏览器不允许自动复制，请选中下方链接手动复制。", "error"));
  }
  function run(action: Action, value: string) {
    const clash = link("clash", value);
    if (action === "clash" || action === "hiddify") {
      window.location.assign(importUrls[action](clash));
      notify(`正在打开 ${action === "clash" ? "Clash Verge" : "Hiddify"}。没有反应？请先安装客户端，或复制链接手动添加。`);
    }
    if (action === "shadowrocket") setQr("v2ray");
    if (action === "qr") setQr("clash");
    if (action === "copy") copy(clash);
  }
  function start(action: Action) {
    if (token) run(action, token);
    else { setError(""); setPending(action); }
  }
  async function verify(event: FormEvent) {
    event.preventDefault();
    if (!pending) return;
    setBusy(true); setError("");
    try {
      const result = await api<{ token: string }>("/api/v1/subscriptions", { method: "PATCH", body: JSON.stringify({ id, action: pending === "reset" ? "reset-link" : "reveal-link", password }) });
      const action = pending;
      setToken(result.token); setPassword(""); setPending(null);
      if (action === "reset") notify("链接已重置，旧链接立即失效，请在各客户端重新导入。");
      else run(action, result.token);
      onChanged();
    } catch (caught) { setError((caught as Error).message); } finally { setBusy(false); }
  }

  const buttons: Array<{ action: Action; icon: React.ReactNode; title: string; note: string }> = [
    { action: "clash", icon: <AppIcon id="clash" />, title: "Clash Verge", note: "电脑一键导入" },
    { action: "hiddify", icon: <AppIcon id="hiddify" />, title: "Hiddify", note: "手机 · 电脑" },
    ...(vless ? [{ action: "shadowrocket" as const, icon: <AppIcon id="shadowrocket" />, title: "Shadowrocket · v2rayNG", note: "扫码或打开" }] : []),
    { action: "copy", icon: <span className="app-icon neutral">{Icon.copy()}</span>, title: "复制链接", note: "粘贴到任意客户端" },
    { action: "qr", icon: <span className="app-icon neutral">{Icon.qr()}</span>, title: "二维码", note: "手机扫码导入" },
  ];
  const qrLink = link(qr || "clash");
  return <section className="access" aria-label="导入订阅">
    <div className="access-head">
      <h4>导入到客户端</h4>
      <div className="segmented" role="group" aria-label="分流模式">
        <button type="button" aria-pressed={mode === "smart"} onClick={() => setMode("smart")}>智能分流</button>
        <button type="button" aria-pressed={mode === "global"} onClick={() => setMode("global")}>全局代理</button>
      </div>
    </div>
    <div className="client-buttons">{buttons.map((item) => <button key={item.action} type="button" className="client-button" disabled={disabled || busy} onClick={() => start(item.action)}>{item.icon}<span><b>{item.title}</b><small>{item.note}</small></span></button>)}</div>
    <p className="hint">{mode === "smart" ? "智能分流：国内网站直连，其余经代理。" : "全局代理：全部流量经代理。"}切换后需重新导入。{token ? "" : "首次使用需验证登录密码。"}</p>
    {disabled && <p className="hint warning">连接当前不可用，恢复后才能导入。</p>}
    {token && !disabled && <div className="link-row"><input readOnly aria-label="订阅链接" value={link()} onFocus={(event) => event.target.select()} /><button type="button" className="ghost small" onClick={() => setToken("")}>隐藏</button></div>}

    <Modal open={!!pending} title={pending === "reset" ? "重置订阅链接" : "验证登录密码"} onClose={() => { if (!busy) { setPending(null); setPassword(""); } }}>
      <form className="stack" onSubmit={verify}>
        <p>{pending === "reset" ? "旧链接会立即失效，所有客户端需要重新导入；已下载的配置不受影响。链接泄露时请删除整个连接。" : "订阅链接包含访问权限，验证后即可导入。链接不会保存在浏览器中。"}</p>
        <label>登录密码<input type="password" autoComplete="current-password" required maxLength={1024} autoFocus value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        {error && <InlineError message={error} />}
        <div className="dialog-actions"><button type="button" className="secondary" disabled={busy} onClick={() => { setPending(null); setPassword(""); }}>取消</button><button className={pending === "reset" ? "danger" : "primary"} disabled={busy}>{busy ? "验证中…" : pending === "reset" ? "验证并重置" : "验证并继续"}</button></div>
      </form>
    </Modal>
    <Modal open={!!qr && !!token} title="扫码导入订阅" onClose={() => setQr(null)}>
      <div className="stack center">
        {vless && <div className="segmented" role="group" aria-label="订阅格式"><button type="button" aria-pressed={qr === "clash"} onClick={() => setQr("clash")}>Clash · Hiddify</button><button type="button" aria-pressed={qr === "v2ray"} onClick={() => setQr("v2ray")}>Shadowrocket · v2rayNG</button></div>}
        {qrLink && <QrCode text={qrLink} label="订阅链接二维码" />}
        <p className="hint">{qr === "v2ray" ? "Shadowrocket：首页右上角扫码；v2rayNG：右上角 ＋ → 扫描二维码。" : "Hiddify：点 ＋ → 扫描二维码。Clash 类客户端可复制链接后在「订阅 / 配置」中添加。"}{mode === "global" ? " 当前为全局代理。" : " 当前为智能分流。"}</p>
        <input readOnly aria-label="二维码中的链接" value={qrLink} onFocus={(event) => event.target.select()} />
        <div className="dialog-actions">{qr === "v2ray" && <a className="secondary" href={importUrls.shadowrocket(qrLink)}>在 Shadowrocket 中打开</a>}<button type="button" className="primary" onClick={() => copy(qrLink)}>{Icon.copy(16)}复制链接</button></div>
      </div>
    </Modal>
  </section>;
}
