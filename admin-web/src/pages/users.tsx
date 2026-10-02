import { useState } from "react";
import { api } from "../api";
import { useConfirm } from "../confirm-dialog";
import type { AccountAccessOverview, AccountCertificateAccess, AdminUser } from "../types";
import { Empty, formatBytes, formatTime, InlineNotice, Modal, type Notice, PageHeader, Pill } from "./shared";

export function UsersPage({ users, onRefresh }: { users: AdminUser[]; onRefresh: () => Promise<void> }) {
  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [credentialOwner, setCredentialOwner] = useState<AdminUser | null>(null);
  const [accessOverview, setAccessOverview] = useState<AccountAccessOverview | null>(null);
  const [rangeDays, setRangeDays] = useState(30);
  const [credentialsBusy, setCredentialsBusy] = useState(false);
  const visible = filter === "all" ? users : users.filter((user) => user.status === filter);
  const pending = users.filter((user) => user.status === "pending");
  const confirm = useConfirm();

  async function update(user: AdminUser, status: "active" | "rejected" | "suspended") {
    let reason = "";
    if (status === "rejected") {
      const input = await confirm({
        title: "拒绝账号申请",
        message: `拒绝 ${user.email} 的原因（可留空）`,
        confirmLabel: "拒绝申请",
        danger: true,
        input: { label: "拒绝原因", placeholder: "可留空" },
      });
      if (input === null) return;
      reason = input;
    }
    if (status === "suspended" && !await confirm({
      title: "停用账号",
      message: `确定停用 ${user.email} 吗？登录会话将退出，全部凭据暂停连接；恢复账号不会解除单独停用或撤销的凭据。`,
      confirmLabel: "停用账号",
      danger: true,
    })) return;
    setBusy(user.id); setNotice(null);
    try {
      await api(`/api/v1/admin/users/${user.id}/status`, { method: "POST", body: JSON.stringify({ status, reason }) });
      setNotice({ tone: "success", message: status === "active" ? "账号已启用。" : status === "rejected" ? "申请已拒绝。" : "账号已停用。" });
      await onRefresh();
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
    finally { setBusy(""); }
  }

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

  async function openCredentials(user: AdminUser) {
    setCredentialOwner(user); setAccessOverview(null); setRangeDays(30);
    await loadAccess(user, 30);
  }

  async function manageAccess(action: "enable-credential" | "disable-credential" | "delete-credential" | "disable-all-credentials" | "revoke-credential" | "revoke-all-credentials", credentialId?: string) {
    if (!credentialOwner) return;
    const credential = accessOverview?.credentials.find((item) => item.id === credentialId);
    const label = action.startsWith("enable") ? "启用" : action.startsWith("disable") ? "停用" : action.startsWith("delete") ? "删除" : "撤销";
    const target = action.includes("-all-") ? "全部凭据" : "凭据";
    const confirmed = await confirm({
      title: `${label}${target}`,
      confirmLabel: `${label}${target}`,
      danger: label !== "启用",
      message: `确定${label}${action.includes("-all-") ? `${credentialOwner.email} 的全部凭据` : `凭据「${credential?.name || credentialId}」`}？${label === "删除" || label === "撤销" ? "所有配置将永久失效，历史流量和审计保留。" : "节点同步后生效；账号和用户自己的停用限制仍保留。"} OpenVPN 同步会使同节点连接短暂重连。`,
    });
    if (!confirmed) return;
    setBusy(action === "revoke-all-credentials" ? credentialOwner.id : credentialId || action); setNotice(null);
    try {
      await api(`/api/v1/admin/users/${credentialOwner.id}/credentials`, { method: "POST", body: JSON.stringify({ action, credentialId }) });
      setNotice({ tone: "success", message: "操作已保存，请查看各凭据的节点同步状态。" });
      await Promise.all([loadAccess(credentialOwner), onRefresh()]);
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
    finally { setBusy(""); }
  }

  async function copyCertificate(certificate: AccountCertificateAccess) {
    try {
      await navigator.clipboard.writeText(certificate.certificatePem);
      setNotice({ tone: "success", message: `证书 ${certificate.serial} 已复制。` });
    } catch { setNotice({ tone: "error", message: "浏览器无法访问剪贴板，请展开证书后手动复制。" }); }
  }

  function downloadCertificate(certificate: AccountCertificateAccess) {
    const url = URL.createObjectURL(new Blob([certificate.certificatePem], { type: "application/x-x509-ca-cert" }));
    const link = document.createElement("a");
    link.href = url; link.download = `openvpn-${certificate.serial}.crt`; link.click(); URL.revokeObjectURL(url);
  }

  return <>
    <PageHeader eyebrow="ACCESS CONTROL" title="账号管理" description="新凭据默认有效 365 天，旧证书保留原期限。停用或撤销可提前终止使用；换发后需用户重新导入配置。" actions={<button className="button ghost" onClick={() => void onRefresh()}>刷新</button>} />
    <InlineNotice notice={notice} />
    <section className="panel review-panel">
      <div className="panel-head"><div><p className="eyebrow">PENDING REVIEW</p><h2>待审核账号 <span>{pending.length}</span></h2></div></div>
      {pending.length ? <div className="review-list">{pending.map((user) => <div key={user.id}>
        <span className="avatar">{user.displayName.slice(0, 1).toUpperCase()}</span>
        <span className="grow"><b>{user.displayName}</b><small>{user.email}</small><small>申请于 {formatTime(user.createdAt)}</small></span>
        <span className="row-actions"><button className="button primary small" disabled={busy === user.id} onClick={() => void update(user, "active")}>通过</button><button className="button danger small" disabled={busy === user.id} onClick={() => void update(user, "rejected")}>拒绝</button></span>
      </div>)}</div> : <Empty>目前没有待审核账号。</Empty>}
    </section>
    <section className="panel">
      <div className="panel-head"><div><p className="eyebrow">USER DIRECTORY</p><h2>全部账号</h2></div><select value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">全部状态</option><option value="active">已启用</option><option value="pending">待审核</option><option value="suspended">已停用</option><option value="rejected">已拒绝</option></select></div>
      <div className="table-wrap"><table className="action-table"><thead><tr><th>用户</th><th>访问资产</th><th>近 30 天流量</th><th>状态</th><th>注册时间</th><th className="align-right">操作</th></tr></thead><tbody>{visible.map((user) => <tr key={user.id}>
        <td><b>{user.displayName}</b><small>{user.email} · {user.role}</small></td><td><b>{user.accessSummary?.activeCredentialCount || 0} / {user.accessSummary?.credentialCount || 0} 份凭据</b><small>{user.accessSummary?.activeProfileCount || 0} 份有效配置 · {user.accessSummary?.activeCertificateCount || 0} 张有效证书</small></td><td><b>{formatBytes(user.accessSummary?.totalBytes)}</b><small>最后活动 {formatTime(user.accessSummary?.lastActivityAt)}</small></td><td><Pill value={user.status} />{user.rejectionReason && <small>{user.rejectionReason}</small>}</td><td>{formatTime(user.createdAt)}</td><td className="align-right"><button className="text-button" onClick={() => void openCredentials(user)}>访问详情</button>{user.role !== "owner" && user.status === "active" && <button className="text-button danger-text" disabled={busy === user.id} onClick={() => void update(user, "suspended")}>停用</button>}{user.status === "suspended" && <button className="text-button" disabled={busy === user.id} onClick={() => void update(user, "active")}>恢复</button>}</td>
      </tr>)}</tbody></table></div>
    </section>
    {credentialOwner && <Modal title={`${credentialOwner.displayName} 的访问资产`} description={`${credentialOwner.email} · 公开证书可查看和下载，私钥不会返回管理端。`} onClose={() => { setCredentialOwner(null); setAccessOverview(null); }} wide>
      <div className="account-access-toolbar">
        <div className="access-toolbar-main">
          <label>流量统计周期<select value={rangeDays} onChange={(event) => { const days = Number(event.target.value); setRangeDays(days); void loadAccess(credentialOwner, days); }}><option value={7}>最近 7 天</option><option value={30}>最近 30 天</option><option value={90}>最近 90 天</option></select></label>
          <button className="button ghost" disabled={credentialsBusy} onClick={() => void loadAccess(credentialOwner)}>{credentialsBusy ? "刷新中…" : "刷新数据"}</button>
        </div>
        <div className="access-toolbar-bulk" role="group" aria-label="账号批量操作">
          <span>全部凭据</span>
          <button className="button ghost" disabled={Boolean(busy)} onClick={() => void manageAccess("disable-all-credentials")}>全部停用</button>
          {Boolean(accessOverview?.credentials.some((item) => item.status !== "revoked")) && <button className="button danger" disabled={Boolean(busy)} onClick={() => void manageAccess("revoke-all-credentials")}>撤销全部凭据</button>}
        </div>
      </div>
      {credentialsBusy && !accessOverview ? <Empty>正在读取账号访问资产…</Empty> : accessOverview ? <>
        <div className="access-summary-grid"><article><small>连接凭据</small><b>{accessOverview.summary.activeCredentialCount}<em> / {accessOverview.summary.credentialCount}</em></b><span>有效 / 全部</span></article><article><small>连接配置</small><b>{accessOverview.summary.activeProfileCount}<em> / {accessOverview.summary.profileCount}</em></b><span>有效 / 历史</span></article><article><small>OpenVPN 证书</small><b>{accessOverview.summary.activeCertificateCount}<em> / {accessOverview.summary.certificateCount}</em></b><span>有效 / 全部</span></article><article><small>{rangeDays} 天总流量</small><b>{formatBytes(accessOverview.totals.totalBytes)}</b><span>↑ {formatBytes(accessOverview.totals.uploadBytes)} · ↓ {formatBytes(accessOverview.totals.downloadBytes)}</span></article></div>
        {credentialsBusy && <div className="access-refreshing">正在刷新统计…</div>}
        {accessOverview.credentials.length ? <div className="account-device-list">{accessOverview.credentials.map((credential) => {
          const profiles = accessOverview.profiles.filter((item) => item.credentialId === credential.id);
          const certificates = accessOverview.certificates.filter((item) => item.credentialId === credential.id);
          return <article className="account-device-card" key={credential.id}>
            <header className="access-card-head">
              <div className="access-card-title"><span className="credential-protocol">{credential.protocol === "wireguard" ? "WG" : credential.protocol === "vless" ? "VL" : "OV"}</span><div><h3>{credential.name}</h3><p>{credential.protocol === "wireguard" ? "WireGuard" : credential.protocol === "vless" ? "VLESS + REALITY" : "OpenVPN"} · 创建于 {formatTime(credential.createdAt)}</p></div></div>
              <div className="access-card-status"><Pill value={credential.state} /><span className={`sync-label ${credential.syncStatus}`}>同步{({ pending: "中", applied: "完成", failed: "失败" } as Record<string, string>)[credential.syncStatus] || "待确认"}</span></div>
            </header>
            <div className="access-card-facts">
              <div><small>{rangeDays} 天流量</small><strong>{formatBytes(credential.totalBytes)}</strong><span>↑ {formatBytes(credential.uploadBytes)} · ↓ {formatBytes(credential.downloadBytes)}</span></div>
              <div><small>当前连接</small><strong>{credential.connectionCount}<em> 条</em></strong><span>最近活动 {formatTime(credential.lastActivityAt)}</span></div>
              <div><small>连接有效期至</small><b>{formatTime(credential.expiresAt)}</b><span>{credential.expiringSoon ? `剩余 ${credential.daysRemaining} 天，请通知用户换发` : "停用或撤销可提前终止访问"}</span></div>
              <div><small>连接身份</small><code>…{credential.identitySuffix}</code><span>用于区分凭据，不代表设备</span></div>
            </div>
            <div className="access-card-actions">
              <p>停用可恢复；撤销将永久作废所有配置副本。</p>
              <div role="group" aria-label={`${credential.name}的操作`}>
                {credential.status === "active" && <button className={`button ${credential.adminDisabled ? "primary" : "ghost"}`} disabled={Boolean(busy)} onClick={() => void manageAccess(credential.adminDisabled ? "enable-credential" : "disable-credential", credential.id)}>{credential.adminDisabled ? "启用凭据" : "停用凭据"}</button>}
                {credential.status === "active" && <button className="button danger" disabled={Boolean(busy)} onClick={() => void manageAccess("revoke-credential", credential.id)}>撤销凭据</button>}
                <button className="button ghost" disabled={Boolean(busy)} onClick={() => void manageAccess("delete-credential", credential.id)}>删除凭据</button>
              </div>
            </div>
            {credential.protocol === "openvpn" && <section className="access-subsection"><div className="access-subhead"><b>OpenVPN 公开证书</b><span>{certificates.length} 张</span></div>{certificates.length ? certificates.map((certificate) => <details className="certificate-row" key={certificate.certificateId}><summary><span><b>{certificate.subject}</b><small>序列号 {certificate.serial} · 有效期至 {formatTime(certificate.notAfter)}</small></span><Pill value={certificate.status} /><span><b>{formatBytes(certificate.totalBytes)}</b><small>凭据窗口流量</small></span><i>⌄</i></summary><div className="certificate-detail"><dl><div><dt>SHA-256 指纹</dt><dd><code>{certificate.fingerprint || "—"}</code></dd></div><div><dt>签发机构</dt><dd>{certificate.authorityRealm} · {certificate.authorityStatus}</dd></div><div><dt>生效时间</dt><dd>{formatTime(certificate.notBefore)}</dd></div><div><dt>吊销时间</dt><dd>{formatTime(certificate.revokedAt)}</dd></div><div><dt>最后活动</dt><dd>{formatTime(certificate.lastActivityAt)}</dd></div><div><dt>上传 / 下载</dt><dd>{formatBytes(certificate.uploadBytes)} / {formatBytes(certificate.downloadBytes)}</dd></div></dl><div className="certificate-actions"><button className="button ghost small" onClick={() => void copyCertificate(certificate)}>复制证书</button><button className="button ghost small" onClick={() => downloadCertificate(certificate)}>下载 .crt</button></div><pre>{certificate.certificatePem}</pre><small>平台按连接凭据聚合全部配置副本的会话和流量，不区分实际安装设备。</small></div></details>) : <p className="access-empty-inline">尚未签发证书。生成 OpenVPN 配置后，公开证书会显示在这里。</p>}</section>}
            <section className="access-subsection"><div className="access-subhead"><b>连接配置</b><span>{profiles.length} 份</span></div>{profiles.length ? <div className="profile-history">{profiles.map((profile) => <div key={profile.profileId}><span className="credential-protocol">{profile.protocol === "wireguard" ? "WG" : profile.protocol === "vless" ? "VL" : "OV"}</span><span><b>{profile.nodeName} · {profile.regionCode || "—"} {profile.regionName}</b><small>rev {profile.revision} · {profile.transport} · 配置可用至 {formatTime(profile.expiresAt)} · 身份 …{profile.credentialIdentity.replaceAll(":", "").slice(-10) || "—"}</small></span><Pill value={profile.status} /><span className="credential-traffic"><b>{formatBytes(profile.totalBytes)}</b><small>配置有效期窗口</small></span></div>)}</div> : <Empty>该凭据还没有生成连接配置。</Empty>}</section>
          </article>;
        })}</div> : <Empty>该账号还没有创建连接凭据。</Empty>}
      </> : <Empty>无法读取该账号的访问资产。</Empty>}
    </Modal>}
  </>;
}
