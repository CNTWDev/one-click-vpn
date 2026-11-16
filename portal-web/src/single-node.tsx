import { useI18n } from "../../shared/i18n";
import { intlLocales } from "../../shared/i18n-core";
import { useCallback, useEffect, useState } from "react";
import { Topbar } from "./home";
import { useActionDialog } from "./action-dialog";
import { api, fetchText, isUnauthorized } from "./api";
import { usableCredential } from "./client-options";
import { filenamePart, profileFilename, saveFiles, type Profile } from "./files";
import { dayLabel, protocolLabel } from "./format";
import { NodeCreator, type AvailableNode, type Region } from "./node-creator";
import { Icon, InlineError, Menu, Modal, QrCode, Skeleton, useToasts } from "./ui";
import { useSite } from "../../shared/site";
import { PRODUCT_NAME } from "../../shared/brand-name";

type User = { email: string; displayName: string };
type Credential = {
  id: string; name: string; protocol: string; status: string; subscriptionId?: string | null;
  userDisabled: boolean; adminDisabled: boolean; accountStatus: string; expiresAt?: string | null;
};
type Account = { deviceLimit: number | null; deviceCount: number };

/**
 * Single-node configs: one node, one protocol, one file or link. Subscriptions are not made here: every account
 * has one on the home page. Subscriptions from before that are listed so they can be deleted.
 */
export function SingleNode({ user, onLogout, onBack }: { user: User; onLogout: () => void; onBack: () => void }) {
  const { t, locale } = useI18n();
  const site = useSite();
  const { ask, dialog } = useActionDialog();
  const { notify, toasts } = useToasts();
  const [nodes, setNodes] = useState<AvailableNode[]>([]), [regions, setRegions] = useState<Region[]>([]);
  const [credentials, setCredentials] = useState<Credential[] | null>(null), [profiles, setProfiles] = useState<Profile[]>([]);
  const [accountSubscription, setAccountSubscription] = useState<string | null>(null), [account, setAccount] = useState<Account | null>(null);
  const [loadError, setLoadError] = useState(""), [busy, setBusy] = useState(""), [fresh, setFresh] = useState("");
  const [qr, setQr] = useState<{ title: string; text: string; hint: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [availability, credentialResult, profileResult, subscription, nextAccount] = await Promise.all([
        api<{ regions: Region[]; nodes: AvailableNode[] }>("/api/v1/availability"),
        api<{ credentials: Credential[] }>("/api/v1/credentials"),
        api<{ profiles: Profile[] }>("/api/v1/profiles"),
        api<{ subscription: { id: string } | null }>("/api/v1/subscriptions"),
        api<Account>("/api/v1/account"),
      ]);
      setNodes(availability.nodes || []); setRegions(availability.regions || []);
      setCredentials((credentialResult.credentials || []).filter((item) => item.status !== "revoked"));
      setProfiles(profileResult.profiles || []); setAccountSubscription(subscription.subscription?.id || null); setAccount(nextAccount); setLoadError("");
    } catch (caught) { if (isUnauthorized(caught)) onLogout(); else setLoadError((caught as Error).message); }
  }, [onLogout]);
  useEffect(() => { const timer = window.setTimeout(() => void refresh(), 0); return () => window.clearTimeout(timer); }, [refresh]);

  const current = (id: string) => profiles.filter((item) => item.credentialId === id && (item.status === "active" || item.status === "issued"));
  const configs = (credentials || []).filter((item) => !item.subscriptionId);
  const earlier = (credentials || []).filter((item) => item.subscriptionId && item.subscriptionId !== accountSubscription);

  async function perform(id: string, task: () => Promise<void>) {
    if (busy) return;
    setBusy(id);
    try { await task(); } catch (caught) { if (isUnauthorized(caught)) onLogout(); else notify((caught as Error).message, "error"); } finally { setBusy(""); }
  }
  const download = (item: Credential, format: "native" | "mihomo") => perform(item.id, async () => {
    const files = await Promise.all(current(item.id).map(async (profile) => {
      const filename = profileFilename({ ...profile, displayName: item.name });
      return { name: format === "mihomo" ? filename.replace(/\.(conf|yaml)$/, "-Clash.yaml") : filename, text: await fetchText(`/api/v1/profiles/${profile.id}/download${format === "mihomo" ? "?format=mihomo" : ""}`) };
    }));
    saveFiles(files, `${filenamePart(item.name, "config")}.zip`);
    notify(t("配置开始下载，在客户端选择「从文件导入」。"));
  });
  const share = (item: Credential, action: "copy" | "qr") => perform(item.id, async () => {
    const vless = item.protocol === "vless", profile = current(item.id)[0];
    const text = (await fetchText(`/api/v1/profiles/${profile.id}/download${vless ? "?format=uri" : ""}`)).trim();
    if (action === "copy") { await navigator.clipboard.writeText(text); notify(t("链接已复制，在客户端选择「从剪贴板导入」。")); return; }
    setQr(vless ? { title: item.name, text, hint: t("Shadowrocket、v2rayNG、Hiddify 扫码即可添加这个节点。") }
      : { title: item.name, text, hint: t("WireGuard 手机客户端：＋ → 扫描二维码。二维码包含私钥，请勿截图分享。") });
  });
  async function remove(item: Credential) {
    if (!await ask({ title: t("删除「{0}」？", [item.name]), description: t("删除后立即失效，用到它的客户端都无法再连接。此操作不可恢复。"), confirmLabel: t("永久删除"), danger: true })) return;
    await perform(item.id, async () => {
      await api(`/api/v1/credentials/${item.id}`, { method: "PATCH", body: JSON.stringify({ action: "delete" }) });
      notify(t("已删除。")); await refresh();
    });
  }

  const actions = (item: Credential) => {
    const ready = usableCredential(item) && current(item.id).length > 0, wait = !!busy || !ready;
    const primary = item.protocol === "vless" ? { label: t("复制链接"), run: () => void share(item, "copy") } : { label: t("下载"), run: () => void download(item, "native") };
    return <span className="config-actions">
      <button type="button" className={`${fresh === item.id ? "primary" : "secondary"} small`} disabled={wait} onClick={primary.run}>{item.protocol === "vless" ? Icon.copy(16) : Icon.download(16)}{primary.label}</button>
      <Menu label={t("更多操作")} items={[
        item.protocol !== "openvpn" && { label: t("二维码"), onSelect: () => void share(item, "qr"), disabled: wait || (item.protocol === "wireguard" && current(item.id).length !== 1) },
        item.protocol !== "openvpn" && { label: t("下载 Clash 配置"), onSelect: () => void download(item, "mihomo"), disabled: wait },
        "-",
        { label: t("删除"), danger: true, onSelect: () => void remove(item), disabled: !!busy },
      ]} />
    </span>;
  };
  const describe = (item: Credential) => {
    const profile = current(item.id)[0];
    const where = profile ? `${profile.regionName || ""} ${profile.nodeName || ""}`.trim() : t("尚未生成配置");
    return [protocolLabel(item.protocol), where, t("到期 {0}", [dayLabel(item.expiresAt, t("长期有效"), intlLocales[locale])])].join(" · ");
  };
  const deviceNote = account ? account.deviceLimit === null ? t("每份配置占用 1 台设备。") : t("每份配置占用 1 台设备（现在 {0} / {1}）。", [account.deviceCount, account.deviceLimit]) : "";

  return <main className="dashboard">
    {dialog}{toasts}
    <Topbar user={user} onLogout={onLogout} />
    <section className="hero"><div className="manual-head">
      <button type="button" className="ghost small back-link" onClick={onBack}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m15 6-6 6 6 6" /></svg>{t("返回首页")}</button>
      <h1>{t("单个节点配置")}</h1>
      <p className="hero-stats">{t("只想连某一个节点时使用。全部节点的订阅已在首页，这里只生成单份配置。")}</p>
    </div></section>

    {loadError && <InlineError message={loadError} onRetry={() => void refresh()} />}
    <section className="card" aria-label={t("新建配置")}>
      {credentials === null && !loadError ? <div className="stack"><Skeleton height={64} /><Skeleton height={64} /><Skeleton height={48} /></div>
        : <NodeCreator nodes={nodes} regions={regions} deviceNote={deviceNote} onUnauthorized={onLogout} onCreated={(id) => { setFresh(id); notify(t("配置已生成，在下方「已有配置」里下载或复制。")); void refresh(); }} />}
    </section>

    {configs.length > 0 && <section className="card home-list" aria-labelledby="configs-title">
      <h2 id="configs-title">{t("已有配置")}</h2>
      <ul>{configs.map((item) => <li key={item.id}>
        <span className="home-row-main"><b>{item.name}</b><small>{describe(item)}</small>
          {!usableCredential(item) && <small className="warning-text">{t("当前不可用，恢复后才能下载。")}</small>}</span>
        {actions(item)}
      </li>)}</ul>
      <p className="hint">{t("每份配置占用 1 台设备，不用的请删除。同一份 WireGuard 配置请勿在多台设备同时开启。")}</p>
    </section>}

    {earlier.length > 0 && <section className="card home-list" aria-labelledby="earlier-title">
      <h2 id="earlier-title">{t("之前创建的订阅")}</h2>
      <ul>{earlier.map((item) => <li key={item.id}>
        <span className="home-row-main"><b>{item.name}</b><small>{t("仍可使用，不能再新建。首页的订阅已包含全部节点。")}</small></span>
        <button type="button" className="ghost small" disabled={!!busy} onClick={() => void remove(item)}>{t("删除")}</button>
      </li>)}</ul>
    </section>}

    <Modal open={!!qr} title={qr?.title || t("二维码")} onClose={() => setQr(null)}>{qr && <div className="stack center"><QrCode text={qr.text} label={qr.title} /><p className="hint">{qr.hint}</p></div>}</Modal>
    <footer>{t("{0} · 配置仅供本人使用，请勿分享或上传第三方转换网站。", [site?.name || PRODUCT_NAME])}</footer>
  </main>;
}
