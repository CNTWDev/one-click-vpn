import { t } from "../i18n";
/* eslint-disable react-hooks/set-state-in-effect */
import { useEffect, useState } from "react";
import { AccessPanel } from "./account-access";
import { NativeAccessPanel } from "./native-access";
import { api } from "../api";
import { useConfirm } from "../confirm-dialog";
import { useToast } from "../toast";
import type { AccountAccessOverview, AccountCertificateAccess, AdminUser } from "../types";
import { Empty, formatBytes, formatTime, InlineNotice, Modal, type Notice, Pill, Time } from "./shared";

/**
 * One account's access: its plan and grants, authorized app devices, and every connection credential with
 * traffic, profiles and OpenVPN certificates. Owns its own data and actions; the user list only opens it.
 */
export function UserAccessDialog({ user: credentialOwner, onClose, onChanged }: { user: AdminUser; onClose: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [accessOverview, setAccessOverview] = useState<AccountAccessOverview | null>(null);
  const [rangeDays, setRangeDays] = useState(30);
  const [credentialsBusy, setCredentialsBusy] = useState(false);
  const [connectionFilter, setConnectionFilter] = useState("all");
  const visibleConnections = (accessOverview?.credentials || []).filter((item) => connectionFilter === "all" || (connectionFilter === "subscription" ? !!item.subscriptionId : !item.subscriptionId));
  const confirm = useConfirm();
  const toast = useToast();

  function accessRange(days: number) {
    const to = new Date();
    const from = new Date(to.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
    return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
  }

  async function loadAccess(user: AdminUser, days = rangeDays) {
    const query = new URLSearchParams(accessRange(days));
    setCredentialsBusy(true);
    try {
      setAccessOverview(await api<AccountAccessOverview>(`/api/v1/admin/users/${user.id}/credentials?${query}`));
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
    finally { setCredentialsBusy(false); }
  }

  async function manageAccess(action: "enable-credential" | "disable-credential" | "delete-credential" | "disable-all-credentials" | "revoke-credential" | "revoke-all-credentials", credentialId?: string) {
    const credential = accessOverview?.credentials.find((item) => item.id === credentialId);
    const label = action.startsWith("enable") ? t("启用") : action.startsWith("disable") ? t("停用") : action.startsWith("delete") ? t("删除") : t("撤销");
    const target = action.includes("-all-") ? t("全部凭据") : t("凭据");
    const confirmed = await confirm({
      title: `${label}${target}`,
      confirmLabel: `${label}${target}`,
      danger: label !== t("启用"),
      message: t("确定{0}{1}？{2} OpenVPN 同步会使同节点连接短暂重连。", [label, action.includes("-all-") ? `${credentialOwner.email} 的全部凭据` : `凭据「${credential?.name || credentialId}」`, label === t("删除") || label === t("撤销") ? t("所有配置将永久失效，历史流量和审计保留。") : t("节点同步后生效；账号和用户自己的停用限制仍保留。")]),
      ...(action === "revoke-all-credentials" ? { confirmText: credentialOwner.email } : {}),
    });
    if (!confirmed) return;
    setBusy(action === "revoke-all-credentials" ? credentialOwner.id : credentialId || action); setNotice(null);
    try {
      await api(`/api/v1/admin/users/${credentialOwner.id}/credentials`, { method: "POST", body: JSON.stringify({ action, credentialId }) });
      toast(t("操作已保存，请查看各凭据的节点同步状态。"));
      onChanged();
      await loadAccess(credentialOwner);
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
    finally { setBusy(""); }
  }

  async function copyCertificate(certificate: AccountCertificateAccess) {
    try {
      await navigator.clipboard.writeText(certificate.certificatePem);
      toast(t("证书 {0} 已复制。", [certificate.serial]));
    } catch { setNotice({ tone: "error", message: t("浏览器无法访问剪贴板，请展开证书后手动复制。") }); }
  }

  function downloadCertificate(certificate: AccountCertificateAccess) {
    const url = URL.createObjectURL(new Blob([certificate.certificatePem], { type: "application/x-x509-ca-cert" }));
    const link = document.createElement("a");
    link.href = url; link.download = `openvpn-${certificate.serial}.crt`; link.click(); URL.revokeObjectURL(url);
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void loadAccess(credentialOwner, 30); }, [credentialOwner.id]);

  return <Modal title={t("{0} 的访问详情", [credentialOwner.displayName])} description={t("{0} · 公开证书可查看和下载，私钥不会返回管理端。", [credentialOwner.email])} onClose={onClose} wide>
    <AccessPanel userId={credentialOwner.id} onChanged={onChanged} />
    <details className="native-access-details"><summary>{t("客户端授权设备")}</summary><NativeAccessPanel userId={credentialOwner.id}/></details>
    <InlineNotice notice={notice} />
    <div className="account-access-toolbar">
      <div className="access-toolbar-main">
        <label>{t("流量统计周期")}<select value={rangeDays} onChange={(event) => { const days = Number(event.target.value); setRangeDays(days); void loadAccess(credentialOwner, days); }}><option value={7}>{t("最近 7 天")}</option><option value={30}>{t("最近 30 天")}</option><option value={90}>{t("最近 90 天")}</option></select></label>
        <button className="button ghost" disabled={credentialsBusy} onClick={() => void loadAccess(credentialOwner)}>{credentialsBusy ? t("刷新中…") : t("刷新数据")}</button>
      </div>
      {(() => {
        const canDisable = Boolean(accessOverview?.credentials.some((item) => item.status === "active" && !item.adminDisabled));
        const canRevoke = Boolean(accessOverview?.credentials.some((item) => item.status !== "revoked"));
        return (canDisable || canRevoke) && <div className="access-toolbar-bulk" role="group" aria-label={t("账号批量操作")}>
          <span>{t("全部凭据")}</span>
          {canDisable && <button className="button ghost" disabled={Boolean(busy)} onClick={() => void manageAccess("disable-all-credentials")}>{t("全部停用")}</button>}
          {canRevoke && <button className="button danger" disabled={Boolean(busy)} onClick={() => void manageAccess("revoke-all-credentials")}>{t("撤销全部凭据")}</button>}
        </div>;
      })()}
    </div>
    {credentialsBusy && !accessOverview ? <div className="skeleton-block" role="status" aria-label={t("正在读取账号访问资产")}><i /><i /><i /></div> : accessOverview ? <>
      <div className="access-summary-grid"><article><small>{t("连接凭据")}</small><b>{accessOverview.summary.activeCredentialCount}<em> / {accessOverview.summary.credentialCount}</em></b><span>{t("有效 / 全部")}</span></article><article><small>{t("连接配置")}</small><b>{accessOverview.summary.activeProfileCount}<em> / {accessOverview.summary.profileCount}</em></b><span>{t("有效 / 历史")}</span></article><article><small>{t("OpenVPN 证书")}</small><b>{accessOverview.summary.activeCertificateCount}<em> / {accessOverview.summary.certificateCount}</em></b><span>{t("有效 / 全部")}</span></article><article><small>{t("最近 {0} 天总流量", [rangeDays])}</small><b>{formatBytes(accessOverview.totals.totalBytes)}</b><span>↑ {formatBytes(accessOverview.totals.uploadBytes)} · ↓ {formatBytes(accessOverview.totals.downloadBytes)}</span></article></div>
      {credentialsBusy && <div className="access-refreshing">{t("正在刷新统计…")}</div>}
      <div className="chips connection-chips" role="group" aria-label={t("连接类型")}>{[["all", t("全部连接")], ["subscription", t("订阅")], ["single", t("节点配置")]].map(([value, label]) => <button className={connectionFilter === value ? "active" : ""} aria-pressed={connectionFilter === value} key={value} onClick={() => setConnectionFilter(value)}>{label}</button>)}</div>
      {visibleConnections.length ? <div className="account-device-list">{visibleConnections.map((credential) => {
        const profiles = accessOverview.profiles.filter((item) => item.credentialId === credential.id);
        const certificates = accessOverview.certificates.filter((item) => item.credentialId === credential.id);
        return <article className="account-device-card" key={credential.id}>
          <header className="access-card-head">
            <div className="access-card-title"><span className="credential-protocol">{credential.protocol === "wireguard" ? "WG" : credential.protocol === "vless" ? "VL" : "OV"}</span><div><h3>{credential.name}</h3><p>{credential.subscriptionId ? t("订阅") : t("节点配置")} · {credential.protocol === "wireguard" ? "WireGuard" : credential.protocol === "vless" ? "VLESS + REALITY" : "OpenVPN"} · {t("创建于")} <Time value={credential.createdAt} /></p></div></div>
            <div className="access-card-status">{credential.protocol === "vless" && credential.online ? <Pill value="online" label={t("最近活跃")} /> : <Pill value={credential.state} />}<span className={`sync-label ${credential.syncStatus}`}>{({ pending: t("同步中"), applied: t("同步完成"), failed: t("同步失败") } as Record<string, string>)[credential.syncStatus] || t("同步待确认")}</span></div>
          </header>
          <div className="access-card-facts">
            <div><small>{t("{0} 天流量", [rangeDays])}</small><strong>{formatBytes(credential.totalBytes)}</strong><span>↑ {formatBytes(credential.uploadBytes)} · ↓ {formatBytes(credential.downloadBytes)}</span></div>
            <div><small>{credential.protocol === "vless" ? t("使用状态") : t("当前连接")}</small><strong>{credential.protocol === "vless" ? credential.online ? t("最近活跃") : t("暂无活动") : credential.connectionCount}{credential.protocol !== "vless" && <em>{t("条")}</em>}</strong><span>{t("最近活动")} <Time value={credential.lastActivityAt} /></span></div>
            <div><small>{t("连接有效期至")}</small><b>{formatTime(credential.expiresAt)}</b><span>{credential.expiringSoon ? t("剩余 {0} 天，请通知用户换发", [credential.daysRemaining]) : t("停用或撤销可提前终止访问")}</span></div>
            <div><small>{t("连接身份")}</small><code>…{credential.identitySuffix}</code><span>{t("用于区分凭据，不代表设备")}</span></div>
          </div>
          <div className="access-card-actions">
            <p>{t("停用可恢复；撤销将永久作废所有配置副本。")}</p>
            <div role="group" aria-label={t("{0}的操作", [credential.name])}>
              {credential.status === "active" && <button className={`button ${credential.adminDisabled ? "primary" : "ghost"}`} disabled={Boolean(busy)} onClick={() => void manageAccess(credential.adminDisabled ? "enable-credential" : "disable-credential", credential.id)}>{credential.adminDisabled ? t("启用凭据") : t("停用凭据")}</button>}
              <button className="button danger" disabled={Boolean(busy)} onClick={() => void manageAccess("delete-credential", credential.id)}>{t("删除凭据")}</button>
              {credential.status === "active" && <button className="button danger solid" disabled={Boolean(busy)} onClick={() => void manageAccess("revoke-credential", credential.id)}>{t("撤销凭据")}</button>}
            </div>
          </div>
          {credential.protocol === "openvpn" && <section className="access-subsection"><div className="access-subhead"><b>{t("OpenVPN 公开证书")}</b><span>{t("{0} 张", [certificates.length])}</span></div>{certificates.length ? certificates.map((certificate) => <details className="certificate-row" key={certificate.certificateId}><summary><span><b>{certificate.subject}</b><small>{t("序列号 {0}", [certificate.serial])} · {t("有效期至 {0}", [formatTime(certificate.notAfter)])}</small></span><Pill value={certificate.status} /><span><b>{formatBytes(certificate.totalBytes)}</b><small>{t("凭据窗口流量")}</small></span><i className="chev" /></summary><div className="certificate-detail"><dl><div><dt>{t("SHA-256 指纹")}</dt><dd><code>{certificate.fingerprint || "—"}</code></dd></div><div><dt>{t("签发机构")}</dt><dd>{certificate.authorityRealm} · {certificate.authorityStatus}</dd></div><div><dt>{t("生效时间")}</dt><dd>{formatTime(certificate.notBefore)}</dd></div><div><dt>{t("吊销时间")}</dt><dd>{formatTime(certificate.revokedAt)}</dd></div><div><dt>{t("最后活动")}</dt><dd>{formatTime(certificate.lastActivityAt)}</dd></div><div><dt>{t("上传 / 下载")}</dt><dd>{formatBytes(certificate.uploadBytes)} / {formatBytes(certificate.downloadBytes)}</dd></div></dl><div className="certificate-actions"><button className="button ghost small" onClick={() => void copyCertificate(certificate)}>{t("复制证书")}</button><button className="button ghost small" onClick={() => downloadCertificate(certificate)}>{t("下载 .crt")}</button></div><pre>{certificate.certificatePem}</pre><small>{t("平台按连接凭据聚合全部配置副本的会话和流量，不区分实际安装设备。")}</small></div></details>) : <p className="access-empty-inline">{t("尚未签发证书。生成 OpenVPN 配置后，公开证书会显示在这里。")}</p>}</section>}
          <section className="access-subsection"><div className="access-subhead"><b>{t("连接配置")}</b><span>{t("{0} 份", [profiles.length])}</span></div>{profiles.length ? <div className="profile-history">{profiles.map((profile) => <div key={profile.profileId}><span className="credential-protocol">{profile.protocol === "wireguard" ? "WG" : profile.protocol === "vless" ? "VL" : "OV"}</span><span><b>{profile.nodeName} · {profile.regionCode || "—"} {profile.regionName}</b><small>rev {profile.revision} · {profile.transport} · {t("配置可用至 {0}", [formatTime(profile.expiresAt)])} · {t("身份")} …{profile.credentialIdentity.replaceAll(":", "").slice(-10) || "—"}</small></span><Pill value={profile.status} /><span className="credential-traffic"><b>{formatBytes(profile.totalBytes)}</b><small>{t("配置有效期窗口")}</small></span></div>)}</div> : <Empty>{t("该凭据还没有生成连接配置。")}</Empty>}</section>
        </article>;
      })}</div> : <Empty>{connectionFilter === "all" ? t("该账号还没有创建连接凭据。") : t("该账号暂无此类连接，可切换到全部连接查看。")}</Empty>}
    </> : <Empty>{t("无法读取该账号的访问资产。")}</Empty>}
  </Modal>;
}
