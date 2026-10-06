import { consoleLanguage, t, useConsoleLanguage } from "../i18n";
import { useState } from "react";
import { NativeAccessPanel } from "./native-access";
import { api } from "../api";
import { useConfirm } from "../confirm-dialog";
import { Icon } from "../icons";
import { useQueryParam } from "../router";
import { useToast } from "../toast";
import type { AccountAccessOverview, AccountCertificateAccess, AdminUser } from "../types";
import { BatchBar, Empty, formatBytes, formatTime, includesText, InlineNotice, Menu, type MenuItem, Modal, type Notice, PageHeader, Pill, TableToolbar, Time } from "./shared";

export function UsersPage({ users, onRefresh }: { users: AdminUser[]; onRefresh: () => Promise<void> }) {
  useConsoleLanguage();
  const [filter, setFilter] = useQueryParam("filter", "all");
  const [search, setSearch] = useQueryParam("q");
  const [sort, setSort] = useQueryParam("sort", "created");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [credentialOwner, setCredentialOwner] = useState<AdminUser | null>(null);
  const [accessOverview, setAccessOverview] = useState<AccountAccessOverview | null>(null);
  const [rangeDays, setRangeDays] = useState(30);
  const [credentialsBusy, setCredentialsBusy] = useState(false);
  const [connectionFilter, setConnectionFilter] = useState("all");
  const visibleConnections = (accessOverview?.credentials || []).filter((item) => connectionFilter === "all" || (connectionFilter === "subscription" ? !!item.subscriptionId : !item.subscriptionId));
  const time = (value?: string | null) => value ? new Date(value).getTime() || 0 : 0;
  const visible = users.filter((user) => (filter === "all" || user.status === filter) && includesText(search, user.displayName, user.email))
    .sort((left, right) => sort === "name" ? left.displayName.localeCompare(right.displayName, consoleLanguage.locale())
      : sort === "traffic" ? (right.accessSummary?.totalBytes || 0) - (left.accessSummary?.totalBytes || 0)
        : sort === "activity" ? time(right.accessSummary?.lastActivityAt) - time(left.accessSummary?.lastActivityAt)
          : time(right.createdAt) - time(left.createdAt));
  const pending = users.filter((user) => user.status === "pending");
  const selectablePending = visible.filter((user) => user.status === "pending");
  const selectedPending = selectablePending.filter((user) => selected.has(user.id));
  const confirm = useConfirm();
  const toast = useToast();

  async function update(user: AdminUser, status: "active" | "rejected" | "suspended") {
    let reason = "";
    if (status === "rejected") {
      const input = await confirm({
        title: t("拒绝账号申请"),
        message: t("拒绝 {0} 的原因（可留空）", [user.email]),
        confirmLabel: t("拒绝申请"),
        danger: true,
        input: { label: t("拒绝原因"), placeholder: t("可留空") },
      });
      if (input === null) return;
      reason = input;
    }
    if (status === "suspended" && !await confirm({
      title: t("停用账号"),
      message: t("确定停用 {0} 吗？登录会话将退出，全部凭据暂停连接；恢复账号不会解除单独停用或撤销的凭据。", [user.email]),
      confirmLabel: t("停用账号"),
      danger: true,
    })) return;
    setBusy(user.id); setNotice(null);
    try {
      await api(`/api/v1/admin/users/${user.id}/status`, { method: "POST", body: JSON.stringify({ status, reason }) });
      toast(status === "active" ? t("{0} 已启用。", [user.email]) : status === "rejected" ? t("已拒绝 {0} 的申请。", [user.email]) : t("{0} 已停用。", [user.email]));
      setSelected((current) => { const next = new Set(current); next.delete(user.id); return next; });
      await onRefresh();
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
    finally { setBusy(""); }
  }

  // Batch approve / reject loops over the existing per-account status endpoint.
  async function batchReview(status: "active" | "rejected") {
    const targets = selectedPending;
    if (!targets.length) return;
    let reason = "";
    if (status === "rejected") {
      const input = await confirm({ title: t("拒绝 {0} 个账号申请", [targets.length]), message: t("将拒绝：{0}。原因会对所有选中账号生效（可留空）。", [targets.map((user) => user.email).join("、")]), confirmLabel: t("批量拒绝"), danger: true, input: { label: t("拒绝原因"), placeholder: t("可留空") } });
      if (input === null) return;
      reason = input;
    } else if (!await confirm({ title: t("通过 {0} 个账号申请", [targets.length]), message: t("将启用：{0}。", [targets.map((user) => user.email).join("、")]), confirmLabel: t("批量通过") })) return;
    setBusy("batch"); setNotice(null);
    const failures: string[] = [];
    for (const user of targets) {
      try { await api(`/api/v1/admin/users/${user.id}/status`, { method: "POST", body: JSON.stringify({ status, reason }) }); }
      catch (error) { failures.push(`${user.email}：${(error as Error).message}`); }
    }
    if (failures.length) setNotice({ tone: "error", message: t("{0} 个账号处理失败：{1}", [failures.length, failures.join("；")]) });
    if (targets.length > failures.length) toast(t("已{0} {1} 个账号申请。", [status === "active" ? t("通过") : t("拒绝"), targets.length - failures.length]));
    setSelected(new Set()); setBusy(""); await onRefresh();
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
    setCredentialOwner(user); setAccessOverview(null); setRangeDays(30); setConnectionFilter("all");
    await loadAccess(user, 30);
  }

  async function manageAccess(action: "enable-credential" | "disable-credential" | "delete-credential" | "disable-all-credentials" | "revoke-credential" | "revoke-all-credentials", credentialId?: string) {
    if (!credentialOwner) return;
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
      await Promise.all([loadAccess(credentialOwner), onRefresh()]);
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

  const statusLabels: Record<string, string> = { active: t("已启用"), pending: t("待审核"), suspended: t("已停用"), rejected: t("已拒绝") };
  const chips = [["all", t("全部")], ["pending", t("待审核")], ["active", t("已启用")], ["suspended", t("已停用")], ["rejected", t("已拒绝")]].map(([value, label]) => ({ value, label, count: value === "all" ? users.length : users.filter((user) => user.status === value).length }));
  const allPendingSelected = selectablePending.length > 0 && selectablePending.every((user) => selected.has(user.id));
  function rowActions(user: AdminUser) {
    const items: MenuItem[] = [];
    let primary = <button className="button ghost small" onClick={() => void openCredentials(user)}>{t("访问详情")}</button>;
    if (user.status === "pending") {
      primary = <button className="button primary small" disabled={busy === user.id} onClick={() => void update(user, "active")}>{t("通过")}</button>;
      items.push({ label: t("访问详情"), onSelect: () => void openCredentials(user) }, "divider", { label: t("拒绝申请"), danger: true, disabled: busy === user.id, onSelect: () => void update(user, "rejected") });
    } else if (user.status === "suspended") {
      primary = <button className="button ghost small" disabled={busy === user.id} onClick={() => void update(user, "active")}>{t("恢复")}</button>;
      items.push({ label: t("访问详情"), onSelect: () => void openCredentials(user) });
    } else if (user.role !== "owner" && user.status === "active") {
      items.push({ label: t("停用账号"), danger: true, disabled: busy === user.id, onSelect: () => void update(user, "suspended") });
    }
    return <div className="row-actions">{primary}{items.length > 0 ? <Menu label={t("{0} 的更多操作", [user.email])} items={items} /> : <span className="menu-spacer" />}</div>;
  }

  return <>
    <PageHeader title={t("账号管理")} description={t("新凭据默认有效 365 天，旧证书保留原期限。停用或撤销可提前终止使用；换发后需用户重新导入配置。")} actions={<button className="button ghost" onClick={() => void onRefresh()}><Icon name="refresh" size={16} />{t("刷新")}</button>} />
    <InlineNotice notice={notice} />
    {pending.length > 0 && filter !== "pending" && <div className="inline-notice warning"><span><b>{pending.length}{t("个账号等待审核。")}</b>{t("可勾选后批量通过或拒绝。")}</span><button className="button ghost small" onClick={() => setFilter("pending")}>{t("查看待审核")}</button></div>}
    <section className="panel flush table-panel">
      <TableToolbar search={search} onSearch={setSearch} placeholder={t("搜索名称或邮箱")} chips={chips} chip={filter} onChip={setFilter} sort={sort} onSort={setSort} sortOptions={[["created", t("注册时间（最新）")], ["name", t("名称")], ["traffic", t("近 30 天流量")], ["activity", t("最近活动")]]} />
      <BatchBar count={selectedPending.length} unit={t("个待审核账号")} onClear={() => setSelected(new Set())}>
        <button className="button primary small" disabled={Boolean(busy)} onClick={() => void batchReview("active")}>{t("批量通过")}</button>
        <button className="button danger small" disabled={Boolean(busy)} onClick={() => void batchReview("rejected")}>{t("批量拒绝")}</button>
      </BatchBar>
      <div className="table-wrap"><table className="data-table user-table"><thead><tr><th className="check"><input type="checkbox" aria-label={t("选择全部待审核账号")} title={t("仅待审核账号可批量处理")} disabled={!selectablePending.length} checked={allPendingSelected} onChange={(event) => setSelected(event.target.checked ? new Set(selectablePending.map((user) => user.id)) : new Set())} /></th><th>{t("用户")}</th><th>{t("访问资产")}</th><th>{t("近 30 天流量")}</th><th>{t("状态")}</th><th>{t("注册时间")}</th><th className="align-right">{t("操作")}</th></tr></thead><tbody>{visible.map((user) => <tr key={user.id} className={selected.has(user.id) ? "selected" : ""}>
        <td className="check">{user.status === "pending" ? <input type="checkbox" aria-label={t("选择 {0}", [user.email])} checked={selected.has(user.id)} onChange={(event) => setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(user.id); else next.delete(user.id); return next; })} /> : null}</td>
        <td className="cell-main"><div className="user-cell"><span className="avatar">{user.displayName.slice(0, 1).toUpperCase()}</span><span><b>{user.displayName}{user.role === "owner" && <em className="role-tag">{t("所有者")}</em>}</b><small>{user.email}</small></span></div></td>
        <td className="m-hide"><b>{user.accessSummary?.activeCredentialCount || 0} / {user.accessSummary?.credentialCount || 0}{t("份凭据")}</b><small>{user.accessSummary?.activeProfileCount || 0}{t("份有效配置 ·")}{user.accessSummary?.activeCertificateCount || 0}{t("张有效证书")}</small></td>
        <td className="m-hide"><b>{formatBytes(user.accessSummary?.totalBytes)}</b><small>{t("最后活动")}<Time value={user.accessSummary?.lastActivityAt} /></small></td>
        <td className="cell-status"><Pill value={user.status} label={statusLabels[user.status]} tone={user.status === "pending" ? "warning" : undefined} />{user.rejectionReason && <small>{user.rejectionReason}</small>}</td>
        <td className="m-hide"><Time value={user.createdAt} /></td>
        <td className="align-right cell-actions">{rowActions(user)}</td>
      </tr>)}</tbody></table></div>
      {!visible.length && <Empty action={search || filter !== "all" ? <button className="button ghost" onClick={() => { setSearch(""); setFilter("all"); }}>{t("清除筛选")}</button> : undefined}>{users.length ? t("没有符合条件的账号。") : t("还没有账号。")}</Empty>}
    </section>
    {credentialOwner && <Modal title={t("{0} 的访问资产", [credentialOwner.displayName])} description={t("{0} · 公开证书可查看和下载，私钥不会返回管理端。", [credentialOwner.email])} onClose={() => { setCredentialOwner(null); setAccessOverview(null); }} wide>
      <details><summary>{t("客户端授权设备与会员额度")}</summary><NativeAccessPanel userId={credentialOwner.id}/></details>
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
              <div className="access-card-title"><span className="credential-protocol">{credential.protocol === "wireguard" ? "WG" : credential.protocol === "vless" ? "VL" : "OV"}</span><div><h3>{credential.name}</h3><p>{credential.subscriptionId ? t("订阅") : t("节点配置")} · {credential.protocol === "wireguard" ? "WireGuard" : credential.protocol === "vless" ? "VLESS + REALITY" : "OpenVPN"}{t("· 创建于")}<Time value={credential.createdAt} /></p></div></div>
              <div className="access-card-status">{credential.protocol === "vless" && credential.online ? <Pill value="online" label={t("最近活跃")} /> : <Pill value={credential.state} />}<span className={`sync-label ${credential.syncStatus}`}>{t("同步")}{({ pending: t("中"), applied: t("完成"), failed: t("失败") } as Record<string, string>)[credential.syncStatus] || t("待确认")}</span></div>
            </header>
            <div className="access-card-facts">
              <div><small>{rangeDays}{t("天流量")}</small><strong>{formatBytes(credential.totalBytes)}</strong><span>↑ {formatBytes(credential.uploadBytes)} · ↓ {formatBytes(credential.downloadBytes)}</span></div>
              <div><small>{credential.protocol === "vless" ? t("使用状态") : t("当前连接")}</small><strong>{credential.protocol === "vless" ? credential.online ? t("最近活跃") : t("暂无活动") : credential.connectionCount}{credential.protocol !== "vless" && <em>{t("条")}</em>}</strong><span>{t("最近活动")}<Time value={credential.lastActivityAt} /></span></div>
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
            {credential.protocol === "openvpn" && <section className="access-subsection"><div className="access-subhead"><b>{t("OpenVPN 公开证书")}</b><span>{certificates.length}{t("张")}</span></div>{certificates.length ? certificates.map((certificate) => <details className="certificate-row" key={certificate.certificateId}><summary><span><b>{certificate.subject}</b><small>{t("序列号")}{certificate.serial}{t("· 有效期至")}{formatTime(certificate.notAfter)}</small></span><Pill value={certificate.status} /><span><b>{formatBytes(certificate.totalBytes)}</b><small>{t("凭据窗口流量")}</small></span><i className="chev" /></summary><div className="certificate-detail"><dl><div><dt>{t("SHA-256 指纹")}</dt><dd><code>{certificate.fingerprint || "—"}</code></dd></div><div><dt>{t("签发机构")}</dt><dd>{certificate.authorityRealm} · {certificate.authorityStatus}</dd></div><div><dt>{t("生效时间")}</dt><dd>{formatTime(certificate.notBefore)}</dd></div><div><dt>{t("吊销时间")}</dt><dd>{formatTime(certificate.revokedAt)}</dd></div><div><dt>{t("最后活动")}</dt><dd>{formatTime(certificate.lastActivityAt)}</dd></div><div><dt>{t("上传 / 下载")}</dt><dd>{formatBytes(certificate.uploadBytes)} / {formatBytes(certificate.downloadBytes)}</dd></div></dl><div className="certificate-actions"><button className="button ghost small" onClick={() => void copyCertificate(certificate)}>{t("复制证书")}</button><button className="button ghost small" onClick={() => downloadCertificate(certificate)}>{t("下载 .crt")}</button></div><pre>{certificate.certificatePem}</pre><small>{t("平台按连接凭据聚合全部配置副本的会话和流量，不区分实际安装设备。")}</small></div></details>) : <p className="access-empty-inline">{t("尚未签发证书。生成 OpenVPN 配置后，公开证书会显示在这里。")}</p>}</section>}
            <section className="access-subsection"><div className="access-subhead"><b>{t("连接配置")}</b><span>{profiles.length}{t("份")}</span></div>{profiles.length ? <div className="profile-history">{profiles.map((profile) => <div key={profile.profileId}><span className="credential-protocol">{profile.protocol === "wireguard" ? "WG" : profile.protocol === "vless" ? "VL" : "OV"}</span><span><b>{profile.nodeName} · {profile.regionCode || "—"} {profile.regionName}</b><small>rev {profile.revision} · {profile.transport}{t("· 配置可用至")}{formatTime(profile.expiresAt)}{t("· 身份 …")}{profile.credentialIdentity.replaceAll(":", "").slice(-10) || "—"}</small></span><Pill value={profile.status} /><span className="credential-traffic"><b>{formatBytes(profile.totalBytes)}</b><small>{t("配置有效期窗口")}</small></span></div>)}</div> : <Empty>{t("该凭据还没有生成连接配置。")}</Empty>}</section>
          </article>;
        })}</div> : <Empty>{connectionFilter === "all" ? t("该账号还没有创建连接凭据。") : t("该账号暂无此类连接，可切换到全部连接查看。")}</Empty>}
      </> : <Empty>{t("无法读取该账号的访问资产。")}</Empty>}
    </Modal>}
  </>;
}
