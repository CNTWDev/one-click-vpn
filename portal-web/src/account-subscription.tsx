import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useI18n } from "../../shared/i18n";
import { PasswordInput } from "../../shared/password-input";
import { PRODUCT_NAME } from "../../shared/brand-name";
import { useSite } from "../../shared/site";
import { api, isUnauthorized } from "./api";
import { appOrder as order, apps, type AppId } from "./client-options";
import { importUrls, subscriptionLink } from "./format";
import { Icon, InlineError, Modal, QrCode, Skeleton, type Notify } from "./ui";

/** The account's one subscription; null until first used. token is null for an early link that was never stored. */
export type Subscription = { id: string; token: string | null; usable: boolean; lastFetchedAt: string | null; lastFetchClient: string };

/** Loads the account's subscription and makes it on first use, so accounts that only use the apps never get one. */
export function useAccountSubscription(onLogout: () => void) {
  const [subscription, setSubscription] = useState<Subscription | null | undefined>(undefined);
  const [error, setError] = useState("");
  const load = useCallback(() => api<{ subscription: Subscription | null }>("/api/v1/subscriptions")
    .then((result) => { setSubscription(result.subscription); setError(""); })
    .catch((caught) => { if (isUnauthorized(caught)) onLogout(); else setError((caught as Error).message); }), [onLogout]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);
  const ensure = useCallback(async () => {
    if (subscription) return subscription;
    const result = await api<{ subscription: Subscription }>("/api/v1/subscriptions", { method: "POST" });
    setSubscription(result.subscription);
    return result.subscription;
  }, [subscription]);
  return { subscription, setSubscription, error, reload: load, ensure };
}

const useNarrow = () => {
  const query = "(max-width: 900px)";
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => { const media = window.matchMedia(query), follow = () => setNarrow(media.matches); media.addEventListener("change", follow); return () => media.removeEventListener("change", follow); }, []);
  return narrow;
};

/**
 * The home's first section: tap an app to import every node, or scan / copy the link on another device.
 * The link is the account's own, so a signed-in owner sees it without a password; resetting it asks for one.
 */
export function AccountSubscription({ state, nodes, notify, onLogout }: {
  state: ReturnType<typeof useAccountSubscription>; nodes: number | null; notify: Notify; onLogout: () => void;
}) {
  const { t } = useI18n();
  const site = useSite();
  const narrow = useNarrow();
  const name = site?.name || PRODUCT_NAME;
  const { subscription, error, ensure, setSubscription } = state;
  const [revealed, setRevealed] = useState(false), [busy, setBusy] = useState(false);
  const [resetting, setResetting] = useState(false), [password, setPassword] = useState(""), [resetError, setResetError] = useState("");
  const link = subscription?.token ? subscriptionLink(subscription.token, site?.apiOrigin) : "";
  const blocked = subscription ? !subscription.usable : false;

  async function withLink(work: (link: string) => void) {
    if (busy) return;
    setBusy(true);
    try {
      const current = await ensure();
      if (!current.token) { notify(t("这个订阅创建得较早，链接无法再次显示。请先重置链接。"), "error"); return; }
      if (!current.usable) { notify(t("账号暂时无法连接，恢复后才能导入。"), "error"); return; }
      work(subscriptionLink(current.token, site?.apiOrigin));
    } catch (caught) { if (isUnauthorized(caught)) onLogout(); else notify((caught as Error).message, "error"); }
    finally { setBusy(false); }
  }
  function copy(text: string, message = t("链接已复制。在客户端选择「添加订阅」或「从剪贴板导入」即可。")) {
    void navigator.clipboard.writeText(text).then(() => notify(message)).catch(() => notify(t("浏览器不允许自动复制，请在二维码下方手动复制链接。"), "error"));
  }
  function open(id: AppId) {
    void withLink((value) => {
      const kind = apps[id].import;
      if (kind === "copy") { copy(value, copied[id]); return; }
      window.location.assign(importUrls[kind](value, name));
      notify(t("正在打开 {0}。没有反应？请先安装 {0}。", [apps[id].name]));
    });
  }
  async function reset(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setResetError("");
    try {
      const result = await api<{ subscription: Subscription }>("/api/v1/subscriptions", { method: "PATCH", body: JSON.stringify({ action: "reset-link", password }) });
      setSubscription(result.subscription); setResetting(false); setPassword(""); setRevealed(true);
      notify(t("链接已重置，旧链接已失效。请在各个客户端重新导入。"));
    } catch (caught) { if (isUnauthorized(caught)) onLogout(); else setResetError((caught as Error).message); }
    finally { setBusy(false); }
  }

  const copied: Partial<Record<AppId, string>> = {
    v2rayng: t("链接已复制。在 v2rayNG 里点右上角 ＋，选「从剪贴板导入」。"),
    v2rayn: t("链接已复制。在 v2rayN 的「订阅分组设置」里添加，然后点「更新订阅」。"),
  };
  const downloads = (ids: readonly AppId[]) => ids.map((id, index) => <span key={id}>{index ? " · " : ""}<a href={apps[id].url} target="_blank" rel="noopener noreferrer">{apps[id].name}</a></span>);
  const tiles = <div className="import-apps">{order.map((id) => <button key={id} type="button" className="import-app" disabled={busy || blocked} onClick={() => open(id)}>
    <span className="home-code" aria-hidden="true">{apps[id].code}</span>
    <span className="home-row-main"><b>{apps[id].name}</b><small>{apps[id].platforms}</small></span>
    {apps[id].import === "copy" ? <span className="import-icon" aria-hidden="true">{Icon.copy(18)}</span>
      : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M7 17 17 7M8 7h9v9" /></svg>}
  </button>)}
    <button type="button" className="import-app" disabled={busy || blocked} onClick={() => void withLink((value) => copy(value))}>
      <span className="home-code" aria-hidden="true">{Icon.copy(16)}</span>
      <span className="home-row-main"><b>{t("复制链接")}</b><small>{t("粘贴到任意客户端")}</small></span>
    </button>
  </div>;

  const shareBody = !subscription || !revealed
    ? <div className="import-share">
      <span className="import-qr-cover" aria-hidden="true">{Icon.qr(40)}</span>
      <button type="button" className="secondary wrap" disabled={busy || blocked || subscription === undefined} onClick={() => void withLink(() => setRevealed(true))}>{t("显示二维码和链接")}</button>
    </div>
    : !link
      ? <p className="hint">{t("这个订阅创建得较早，链接无法再次显示。重置后会得到新链接，旧链接立即失效。")}</p>
      : <div className="import-share">
        <QrCode text={link} label={t("订阅链接二维码")} />
        <div className="link-row"><input readOnly aria-label={t("订阅链接")} value={link} onFocus={(event) => event.target.select()} /><button type="button" className="ghost small" onClick={() => setRevealed(false)}>{t("隐藏")}</button></div>
        <button type="button" className="primary wide" onClick={() => copy(link)}>{Icon.copy(16)}{t("复制链接")}</button>
      </div>;
  const share = <>
    <p className="hint">{t("Shadowrocket、Stash、v2rayNG、Clash 扫码或粘贴都能用，格式会自动匹配。")}</p>
    {shareBody}
    {subscription && <button type="button" className="ghost small import-reset" onClick={() => { setResetError(""); setPassword(""); setResetting(true); }}>{t("链接泄露？重置链接")}</button>}
  </>;

  return <section className="home-import" aria-labelledby="home-title">
    <div className="home-import-main">
      <p className="home-meta">{nodes === null ? t("订阅 · 自动同步") : t("订阅 · {0} 个节点 · 自动同步", [nodes])}</p>
      <h1 id="home-title">{t("选择客户端，一键导入")}</h1>
      <p className="home-lead">{t("账号已包含全部节点。节点有增减时，客户端会自动更新，不需要再创建订阅。")}</p>
      {subscription === undefined && !error ? <div className="import-apps">{[...order, "copy"].map((key) => <Skeleton key={key} height={72} />)}</div> : tiles}
      {error && <InlineError message={error} onRetry={() => void state.reload()} />}
      {blocked && <p className="hint warning-text">{t("账号暂时无法连接，恢复后才能导入。")}</p>}
      <p className="hint">{t("还没安装？")} {downloads(order)}</p>
    </div>
    {narrow
      ? <details className="card import-other"><summary><span><b>{t("在另一台设备上导入")}</b><small>{t("二维码和订阅链接")}</small></span></summary><div className="import-other-body">{share}</div></details>
      : <aside className="card import-aside" aria-labelledby="import-qr-title"><h2 id="import-qr-title">{t("用手机扫码导入")}</h2>{share}</aside>}

    <Modal open={resetting} title={t("重置订阅链接")} onClose={() => { if (!busy) setResetting(false); }}>
      <form className="stack" onSubmit={(event) => void reset(event)}>
        <p>{t("旧链接会立即失效，所有客户端需要重新导入。")}</p>
        <label>{t("登录密码")}<PasswordInput showLabel={t("显示密码")} hideLabel={t("隐藏密码")} autoComplete="current-password" required maxLength={1024} autoFocus value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        {resetError && <InlineError message={resetError} />}
        <div className="dialog-actions"><button type="button" className="secondary" disabled={busy} onClick={() => setResetting(false)}>{t("取消")}</button><button className="danger" disabled={busy}>{busy ? t("验证中…") : t("验证并重置")}</button></div>
      </form>
    </Modal>
  </section>;
}
