import { useState } from "react";
import { api } from "../api";
import { useConfirm } from "../confirm-dialog";
import { Icon } from "../icons";
import { useQueryParam } from "../router";
import { useToast } from "../toast";
import type { AccountAccessOverview, AccountCertificateAccess, AdminUser } from "../types";
import { BatchBar, Empty, formatBytes, formatTime, includesText, InlineNotice, Menu, type MenuItem, Modal, type Notice, PageHeader, Pill, TableToolbar, Time } from "./shared";

export function UsersPage({ users, onRefresh }: { users: AdminUser[]; onRefresh: () => Promise<void> }) {
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
    .sort((left, right) => sort === "name" ? left.displayName.localeCompare(right.displayName, "zh-CN")
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
      toast(status === "active" ? `${user.email} 已启用。` : status === "rejected" ? `已拒绝 ${user.email} 的申请。` : `${user.email} 已停用。`);
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
      const input = await confirm({ title: `拒绝 ${targets.length} 个账号申请`, message: `将拒绝：${targets.map((user) => user.email).join("、")}。原因会对所有选中账号生效（可留空）。`, confirmLabel: "批量拒绝", danger: true, input: { label: "拒绝原因", placeholder: "可留空" } });
      if (input === null) return;
      reason = input;
    } else if (!await confirm({ title: `通过 ${targets.length} 个账号申请`, message: `将启用：${targets.map((user) => user.email).join("、")}。`, confirmLabel: "批量通过" })) return;
    setBusy("batch"); setNotice(null);
    const failures: string[] = [];
    for (const user of targets) {
      try { await api(`/api/v1/admin/users/${user.id}/status`, { method: "POST", body: JSON.stringify({ status, reason }) }); }
      catch (error) { failures.push(`${user.email}：${(error as Error).message}`); }
    }
    if (failures.length) setNotice({ tone: "error", message: `${failures.length} 个账号处理失败：${failures.join("；")}` });
    if (targets.length > failures.length) toast(`已${status === "active" ? "通过" : "拒绝"} ${targets.length - failures.length} 个账号申请。`);
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
    const label = action.startsWith("enable") ? "启用" : action.startsWith("disable") ? "停用" : action.startsWith("delete") ? "删除" : "撤销";
    const target = action.includes("-all-") ? "全部凭据" : "凭据";
    const confirmed = await confirm({
      title: `${label}${target}`,
      confirmLabel: `${label}${target}`,
      danger: label !== "启用",
      message: `确定${label}${action.includes("-all-") ? `${credentialOwner.email} 的全部凭据` : `凭据「${credential?.name || credentialId}」`}？${label === "删除" || label === "撤销" ? "所有配置将永久失效，历史流量和审计保留。" : "节点同步后生效；账号和用户自己的停用限制仍保留。"} OpenVPN 同步会使同节点连接短暂重连。`,
      ...(action === "revoke-all-credentials" ? { confirmText: credentialOwner.email } : {}),
    });
    if (!confirmed) return;
    setBusy(action === "revoke-all-credentials" ? credentialOwner.id : credentialId || action); setNotice(null);
    try {
      await api(`/api/v1/admin/users/${credentialOwner.id}/credentials`, { method: "POST", body: JSON.stringify({ action, credentialId }) });
      toast("操作已保存，请查看各凭据的节点同步状态。");
      await Promise.all([loadAccess(credentialOwner), onRefresh()]);
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
    finally { setBusy(""); }
  }

  async function copyCertificate(certificate: AccountCertificateAccess) {
    try {
      await navigator.clipboard.writeText(certificate.certificatePem);
      toast(`证书 ${certificate.serial} 已复制。`);
    } catch { setNotice({ tone: "error", message: "浏览器无法访问剪贴板，请展开证书后手动复制。" }); }
  }

  function downloadCertificate(certificate: AccountCertificateAccess) {
    const url = URL.createObjectURL(new Blob([certificate.certificatePem], { type: "application/x-x509-ca-cert" }));
    const link = document.createElement("a");
    link.href = url; link.download = `openvpn-${certificate.serial}.crt`; link.click(); URL.revokeObjectURL(url);
  }

  const statusLabels: Record<string, string> = { active: "已启用", pending: "待审核", suspended: "已停用", rejected: "已拒绝" };
  const chips = [["all", "全部"], ["pending", "待审核"], ["active", "已启用"], ["suspended", "已停用"], ["rejected", "已拒绝"]].map(([value, label]) => ({ value, label, count: value === "all" ? users.length : users.filter((user) => user.status === value).length }));
  const allPendingSelected = selectablePending.length > 0 && selectablePending.every((user) => selected.has(user.id));
  function rowActions(user: AdminUser) {
    const items: MenuItem[] = [];
    let primary = <button className="button ghost small" onClick={() => void openCredentials(user)}>访问详情</button>;
    if (user.status === "pending") {
      primary = <button className="button primary small" disabled={busy === user.id} onClick={() => void update(user, "active")}>通过</button>;
      items.push({ label: "访问详情", onSelect: () => void openCredentials(user) }, "divider", { label: "拒绝申请", danger: true, disabled: busy === user.id, onSelect: () => void update(user, "rejected") });
    } else if (user.status === "suspended") {
      primary = <button className="button ghost small" disabled={busy === user.id} onClick={() => void update(user, "active")}>恢复</button>;
      items.push({ label: "访问详情", onSelect: () => void openCredentials(user) });
    } else if (user.role !== "owner" && user.status === "active") {
      items.push({ label: "停用账号", danger: true, disabled: busy === user.id, onSelect: () => void update(user, "suspended") });
    }
    return <div className="row-actions">{primary}{items.length > 0 ? <Menu label={`${user.email} 的更多操作`} items={items} /> : <span className="menu-spacer" />}</div>;
  }

  return <>
    <PageHeader title="账号管理" description="新凭据默认有效 365 天，旧证书保留原期限。停用或撤销可提前终止使用；换发后需用户重新导入配置。" actions={<button className="button ghost" onClick={() => void onRefresh()}><Icon name="refresh" size={16} />刷新</button>} />
    <InlineNotice notice={notice} />
    {pending.length > 0 && filter !== "pending" && <div className="inline-notice warning"><span><b>{pending.length} 个账号等待审核。</b>可勾选后批量通过或拒绝。</span><button className="button ghost small" onClick={() => setFilter("pending")}>查看待审核</button></div>}
    <section className="panel flush table-panel">
      <TableToolbar search={search} onSearch={setSearch} placeholder="搜索名称或邮箱" chips={chips} chip={filter} onChip={setFilter} sort={sort} onSort={setSort} sortOptions={[["created", "注册时间（最新）"], ["name", "名称"], ["traffic", "近 30 天流量"], ["activity", "最近活动"]]} />
      <BatchBar count={selectedPending.length} unit="个待审核账号" onClear={() => setSelected(new Set())}>
        <button className="button primary small" disabled={Boolean(busy)} onClick={() => void batchReview("active")}>批量通过</button>
        <button className="button danger small" disabled={Boolean(busy)} onClick={() => void batchReview("rejected")}>批量拒绝</button>
      </BatchBar>
      <div className="table-wrap"><table className="data-table user-table"><thead><tr><th className="check"><input type="checkbox" aria-label="选择全部待审核账号" title="仅待审核账号可批量处理" disabled={!selectablePending.length} checked={allPendingSelected} onChange={(event) => setSelected(event.target.checked ? new Set(selectablePending.map((user) => user.id)) : new Set())} /></th><th>用户</th><th>访问资产</th><th>近 30 天流量</th><th>状态</th><th>注册时间</th><th className="align-right">操作</th></tr></thead><tbody>{visible.map((user) => <tr key={user.id} className={selected.has(user.id) ? "selected" : ""}>
        <td className="check">{user.status === "pending" ? <input type="checkbox" aria-label={`选择 ${user.email}`} checked={selected.has(user.id)} onChange={(event) => setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(user.id); else next.delete(user.id); return next; })} /> : null}</td>
        <td className="cell-main"><div className="user-cell"><span className="avatar">{user.displayName.slice(0, 1).toUpperCase()}</span><span><b>{user.displayName}{user.role === "owner" && <em className="role-tag">所有者</em>}</b><small>{user.email}</small></span></div></td>
        <td className="m-hide"><b>{user.accessSummary?.activeCredentialCount || 0} / {user.accessSummary?.credentialCount || 0} 份凭据</b><small>{user.accessSummary?.activeProfileCount || 0} 份有效配置 · {user.accessSummary?.activeCertificateCount || 0} 张有效证书</small></td>
        <td className="m-hide"><b>{formatBytes(user.accessSummary?.totalBytes)}</b><small>最后活动 <Time value={user.accessSummary?.lastActivityAt} /></small></td>
        <td className="cell-status"><Pill value={user.status} label={statusLabels[user.status]} tone={user.status === "pending" ? "warning" : undefined} />{user.rejectionReason && <small>{user.rejectionReason}</small>}</td>
        <td className="m-hide"><Time value={user.createdAt} /></td>
        <td className="align-right cell-actions">{rowActions(user)}</td>
      </tr>)}</tbody></table></div>
      {!visible.length && <Empty action={search || filter !== "all" ? <button className="button ghost" onClick={() => { setSearch(""); setFilter("all"); }}>清除筛选</button> : undefined}>{users.length ? "没有符合条件的账号。" : "还没有账号。"}</Empty>}
    </section>
    {credentialOwner && <Modal title={`${credentialOwner.displayName} 的访问资产`} description={`${credentialOwner.email} · 公开证书可查看和下载，私钥不会返回管理端。`} onClose={() => { setCredentialOwner(null); setAccessOverview(null); }} wide>
      <InlineNotice notice={notice} />
      <div className="account-access-toolbar">
        <div className="access-toolbar-main">
          <label>流量统计周期<select value={rangeDays} onChange={(event) => { const days = Number(event.target.value); setRangeDays(days); void loadAccess(credentialOwner, days); }}><option value={7}>最近 7 天</option><option value={30}>最近 30 天</option><option value={90}>最近 90 天</option></select></label>
          <button className="button ghost" disabled={credentialsBusy} onClick={() => void loadAccess(credentialOwner)}>{credentialsBusy ? "刷新中…" : "刷新数据"}</button>
        </div>
        {(() => {
          const canDisable = Boolean(accessOverview?.credentials.some((item) => item.status === "active" && !item.adminDisabled));
          const canRevoke = Boolean(accessOverview?.credentials.some((item) => item.status !== "revoked"));
          return (canDisable || canRevoke) && <div className="access-toolbar-bulk" role="group" aria-label="账号批量操作">
            <span>全部凭据</span>
            {canDisable && <button className="button ghost" disabled={Boolean(busy)} onClick={() => void manageAccess("disable-all-credentials")}>全部停用</button>}
            {canRevoke && <button className="button danger" disabled={Boolean(busy)} onClick={() => void manageAccess("revoke-all-credentials")}>撤销全部凭据</button>}
          </div>;
        })()}
      </div>
      {credentialsBusy && !accessOverview ? <div className="skeleton-block" role="status" aria-label="正在读取账号访问资产"><i /><i /><i /></div> : accessOverview ? <>
        <div className="access-summary-grid"><article><small>连接凭据</small><b>{accessOverview.summary.activeCredentialCount}<em> / {accessOverview.summary.credentialCount}</em></b><span>有效 / 全部</span></article><article><small>连接配置</small><b>{accessOverview.summary.activeProfileCount}<em> / {accessOverview.summary.profileCount}</em></b><span>有效 / 历史</span></article><article><small>OpenVPN 证书</small><b>{accessOverview.summary.activeCertificateCount}<em> / {accessOverview.summary.certificateCount}</em></b><span>有效 / 全部</span></article><article><small>{rangeDays} 天总流量</small><b>{formatBytes(accessOverview.totals.totalBytes)}</b><span>↑ {formatBytes(accessOverview.totals.uploadBytes)} · ↓ {formatBytes(accessOverview.totals.downloadBytes)}</span></article></div>
        {credentialsBusy && <div className="access-refreshing">正在刷新统计…</div>}
        <div className="chips connection-chips" role="group" aria-label="连接类型">{[["all", "全部连接"], ["subscription", "订阅"], ["single", "节点配置"]].map(([value, label]) => <button className={connectionFilter === value ? "active" : ""} aria-pressed={connectionFilter === value} key={value} onClick={() => setConnectionFilter(value)}>{label}</button>)}</div>
        {visibleConnections.length ? <div className="account-device-list">{visibleConnections.map((credential) => {
          const profiles = accessOverview.profiles.filter((item) => item.credentialId === credential.id);
          const certificates = accessOverview.certificates.filter((item) => item.credentialId === credential.id);
          return <article className="account-device-card" key={credential.id}>
            <header className="access-card-head">
              <div className="access-card-title"><span className="credential-protocol">{credential.protocol === "wireguard" ? "WG" : credential.protocol === "vless" ? "VL" : "OV"}</span><div><h3>{credential.name}</h3><p>{credential.subscriptionId ? "订阅" : "节点配置"} · {credential.protocol === "wireguard" ? "WireGuard" : credential.protocol === "vless" ? "VLESS + REALITY" : "OpenVPN"} · 创建于 <Time value={credential.createdAt} /></p></div></div>
              <div className="access-card-status">{credential.protocol === "vless" && credential.online ? <Pill value="online" label="最近活跃" /> : <Pill value={credential.state} />}<span className={`sync-label ${credential.syncStatus}`}>同步{({ pending: "中", applied: "完成", failed: "失败" } as Record<string, string>)[credential.syncStatus] || "待确认"}</span></div>
            </header>
            <div className="access-card-facts">
              <div><small>{rangeDays} 天流量</small><strong>{formatBytes(credential.totalBytes)}</strong><span>↑ {formatBytes(credential.uploadBytes)} · ↓ {formatBytes(credential.downloadBytes)}</span></div>
              <div><small>{credential.protocol === "vless" ? "使用状态" : "当前连接"}</small><strong>{credential.protocol === "vless" ? credential.online ? "最近活跃" : "暂无活动" : credential.connectionCount}{credential.protocol !== "vless" && <em> 条</em>}</strong><span>最近活动 <Time value={credential.lastActivityAt} /></span></div>
              <div><small>连接有效期至</small><b>{formatTime(credential.expiresAt)}</b><span>{credential.expiringSoon ? `剩余 ${credential.daysRemaining} 天，请通知用户换发` : "停用或撤销可提前终止访问"}</span></div>
              <div><small>连接身份</small><code>…{credential.identitySuffix}</code><span>用于区分凭据，不代表设备</span></div>
            </div>
            <div className="access-card-actions">
              <p>停用可恢复；撤销将永久作废所有配置副本。</p>
              <div role="group" aria-label={`${credential.name}的操作`}>
                {credential.status === "active" && <button className={`button ${credential.adminDisabled ? "primary" : "ghost"}`} disabled={Boolean(busy)} onClick={() => void manageAccess(credential.adminDisabled ? "enable-credential" : "disable-credential", credential.id)}>{credential.adminDisabled ? "启用凭据" : "停用凭据"}</button>}
                <button className="button danger" disabled={Boolean(busy)} onClick={() => void manageAccess("delete-credential", credential.id)}>删除凭据</button>
                {credential.status === "active" && <button className="button danger solid" disabled={Boolean(busy)} onClick={() => void manageAccess("revoke-credential", credential.id)}>撤销凭据</button>}
              </div>
            </div>
            {credential.protocol === "openvpn" && <section className="access-subsection"><div className="access-subhead"><b>OpenVPN 公开证书</b><span>{certificates.length} 张</span></div>{certificates.length ? certificates.map((certificate) => <details className="certificate-row" key={certificate.certificateId}><summary><span><b>{certificate.subject}</b><small>序列号 {certificate.serial} · 有效期至 {formatTime(certificate.notAfter)}</small></span><Pill value={certificate.status} /><span><b>{formatBytes(certificate.totalBytes)}</b><small>凭据窗口流量</small></span><i className="chev" /></summary><div className="certificate-detail"><dl><div><dt>SHA-256 指纹</dt><dd><code>{certificate.fingerprint || "—"}</code></dd></div><div><dt>签发机构</dt><dd>{certificate.authorityRealm} · {certificate.authorityStatus}</dd></div><div><dt>生效时间</dt><dd>{formatTime(certificate.notBefore)}</dd></div><div><dt>吊销时间</dt><dd>{formatTime(certificate.revokedAt)}</dd></div><div><dt>最后活动</dt><dd>{formatTime(certificate.lastActivityAt)}</dd></div><div><dt>上传 / 下载</dt><dd>{formatBytes(certificate.uploadBytes)} / {formatBytes(certificate.downloadBytes)}</dd></div></dl><div className="certificate-actions"><button className="button ghost small" onClick={() => void copyCertificate(certificate)}>复制证书</button><button className="button ghost small" onClick={() => downloadCertificate(certificate)}>下载 .crt</button></div><pre>{certificate.certificatePem}</pre><small>平台按连接凭据聚合全部配置副本的会话和流量，不区分实际安装设备。</small></div></details>) : <p className="access-empty-inline">尚未签发证书。生成 OpenVPN 配置后，公开证书会显示在这里。</p>}</section>}
            <section className="access-subsection"><div className="access-subhead"><b>连接配置</b><span>{profiles.length} 份</span></div>{profiles.length ? <div className="profile-history">{profiles.map((profile) => <div key={profile.profileId}><span className="credential-protocol">{profile.protocol === "wireguard" ? "WG" : profile.protocol === "vless" ? "VL" : "OV"}</span><span><b>{profile.nodeName} · {profile.regionCode || "—"} {profile.regionName}</b><small>rev {profile.revision} · {profile.transport} · 配置可用至 {formatTime(profile.expiresAt)} · 身份 …{profile.credentialIdentity.replaceAll(":", "").slice(-10) || "—"}</small></span><Pill value={profile.status} /><span className="credential-traffic"><b>{formatBytes(profile.totalBytes)}</b><small>配置有效期窗口</small></span></div>)}</div> : <Empty>该凭据还没有生成连接配置。</Empty>}</section>
          </article>;
        })}</div> : <Empty>{connectionFilter === "all" ? "该账号还没有创建连接凭据。" : "该账号暂无此类连接，可切换到全部连接查看。"}</Empty>}
      </> : <Empty>无法读取该账号的访问资产。</Empty>}
    </Modal>}
  </>;
}
