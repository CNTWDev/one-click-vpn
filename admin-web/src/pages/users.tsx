import { consoleLanguage, t, useConsoleLanguage } from "../i18n";
import { useState } from "react";
import { accessSummary } from "./account-access";
import { UserAccessDialog } from "./user-access";
import { api } from "../api";
import { useConfirm } from "../confirm-dialog";
import { Icon } from "../icons";
import { useQueryParam } from "../router";
import { useToast } from "../toast";
import type { AdminUser } from "../types";
import { BatchBar, Empty, formatBytes, includesText, InlineNotice, Menu, type MenuItem, Modal, type Notice, PageHeader, Pill, TableToolbar, Time } from "./shared";

export function UsersPage({ users, onRefresh }: { users: AdminUser[]; onRefresh: () => Promise<void> }) {
  useConsoleLanguage();
  const [filter, setFilter] = useQueryParam("filter", "all");
  const [search, setSearch] = useQueryParam("q");
  const [sort, setSort] = useQueryParam("sort", "created");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [accessUser, setAccessUser] = useState<AdminUser | null>(null);
  const [resetLink, setResetLink] = useState<{ user: AdminUser; url: string } | null>(null);
  const time = (value?: string | null) => value ? new Date(value).getTime() || 0 : 0;
  const accessEnded = (user: AdminUser) => user.status === "active" && user.access?.state !== "active";
  const accessEnding = (user: AdminUser) => user.status === "active" && accessSummary(user.access).tone === "warning";
  const matches = (user: AdminUser) => filter === "all" || (filter === "ending" ? accessEnding(user) : filter === "ended" ? accessEnded(user) : user.status === filter);
  const until = (user: AdminUser) => user.access?.state === "active" ? user.access.until ? time(user.access.until) : Number.MAX_SAFE_INTEGER : 0;
  const visible = users.filter((user) => matches(user) && includesText(search, user.displayName, user.email))
    .sort((left, right) => sort === "name" ? left.displayName.localeCompare(right.displayName, consoleLanguage.locale())
      : sort === "traffic" ? (right.accessSummary?.totalBytes || 0) - (left.accessSummary?.totalBytes || 0)
        : sort === "until" ? until(left) - until(right)
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

  // The administrator only hands over a one-time link; the user picks the new password themselves.
  async function createResetLink(user: AdminUser) {
    setBusy(user.id); setNotice(null);
    try {
      const result = await api<{ url: string }>(`/api/v1/admin/users/${user.id}/password-reset`, { method: "POST" });
      setResetLink({ user, url: result.url });
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
    finally { setBusy(""); }
  }

  async function copyResetLink() {
    if (!resetLink) return;
    try { await navigator.clipboard.writeText(resetLink.url); toast(t("重置链接已复制。")); }
    catch { setNotice({ tone: "error", message: t("浏览器无法访问剪贴板，请手动复制链接。") }); }
  }

  const statusLabels: Record<string, string> = { active: t("已启用"), pending: t("待审核"), suspended: t("已停用"), rejected: t("已拒绝") };
  const chips = [["all", t("全部")], ["pending", t("待审核")], ["active", t("已启用")], ["suspended", t("已停用")], ["rejected", t("已拒绝")], ["ending", t("即将到期")], ["ended", t("已失效")]].map(([value, label]) => ({ value, label, count: value === "all" ? users.length : users.filter((user) => value === "ending" ? accessEnding(user) : value === "ended" ? accessEnded(user) : user.status === value).length }))
    .filter((chip) => chip.count > 0 || !["ending", "ended"].includes(chip.value) || chip.value === filter);
  const allPendingSelected = selectablePending.length > 0 && selectablePending.every((user) => selected.has(user.id));
  function rowActions(user: AdminUser) {
    const items: MenuItem[] = [];
    let primary = <button className="button ghost small" onClick={() => setAccessUser(user)}>{t("访问详情")}</button>;
    if (user.status === "pending") {
      primary = <button className="button primary small" disabled={busy === user.id} onClick={() => void update(user, "active")}>{t("通过")}</button>;
      items.push({ label: t("访问详情"), onSelect: () => setAccessUser(user) }, "divider", { label: t("拒绝申请"), danger: true, disabled: busy === user.id, onSelect: () => void update(user, "rejected") });
    } else if (user.status === "suspended") {
      primary = <button className="button ghost small" disabled={busy === user.id} onClick={() => void update(user, "active")}>{t("恢复")}</button>;
      items.push({ label: t("访问详情"), onSelect: () => setAccessUser(user) });
    } else if (user.role !== "owner" && user.status === "active") {
      items.push({ label: t("重置密码链接"), disabled: busy === user.id, onSelect: () => void createResetLink(user) }, "divider", { label: t("停用账号"), danger: true, disabled: busy === user.id, onSelect: () => void update(user, "suspended") });
    }
    return <div className="row-actions">{primary}{items.length > 0 ? <Menu label={t("{0} 的更多操作", [user.email])} items={items} /> : <span className="menu-spacer" />}</div>;
  }

  return <>
    <PageHeader title={t("账号管理")} description={t("账号能否连接由权益决定：有效期和流量按全部节点合计。停用账号或撤销凭据会立即终止使用。")} actions={<button className="button ghost" onClick={() => void onRefresh()}><Icon name="refresh" size={16} />{t("刷新")}</button>} />
    <InlineNotice notice={notice} />
    {pending.length > 0 && filter !== "pending" && <div className="inline-notice warning"><span><b>{t("{0} 个账号等待审核。", [pending.length])}</b> {t("可勾选后批量通过或拒绝。")}</span><button className="button ghost small" onClick={() => setFilter("pending")}>{t("查看待审核")}</button></div>}
    <section className="panel flush table-panel">
      <TableToolbar search={search} onSearch={setSearch} placeholder={t("搜索名称或邮箱")} chips={chips} chip={filter} onChip={setFilter} sort={sort} onSort={setSort} sortOptions={[["created", t("注册时间（最新）")], ["name", t("名称")], ["until", t("到期时间（最近）")], ["traffic", t("近 30 天流量")], ["activity", t("最近活动")]]} />
      <BatchBar count={selectedPending.length} unit={t("个待审核账号")} onClear={() => setSelected(new Set())}>
        <button className="button primary small" disabled={Boolean(busy)} onClick={() => void batchReview("active")}>{t("批量通过")}</button>
        <button className="button danger small" disabled={Boolean(busy)} onClick={() => void batchReview("rejected")}>{t("批量拒绝")}</button>
      </BatchBar>
      <div className="table-wrap"><table className="data-table cards user-table"><thead><tr><th className="check"><input type="checkbox" aria-label={t("选择全部待审核账号")} title={t("仅待审核账号可批量处理")} disabled={!selectablePending.length} checked={allPendingSelected} onChange={(event) => setSelected(event.target.checked ? new Set(selectablePending.map((user) => user.id)) : new Set())} /></th><th>{t("用户")}</th><th>{t("权益")}</th><th>{t("近 30 天流量")}</th><th>{t("状态")}</th><th>{t("注册时间")}</th><th className="align-right">{t("操作")}</th></tr></thead><tbody>{visible.map((user) => <tr key={user.id} className={selected.has(user.id) ? "selected" : ""}>
        <td className="check">{user.status === "pending" ? <input type="checkbox" aria-label={t("选择 {0}", [user.email])} checked={selected.has(user.id)} onChange={(event) => setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(user.id); else next.delete(user.id); return next; })} /> : null}</td>
        <td className="cell-main"><div className="user-cell"><span className="avatar">{user.displayName.slice(0, 1).toUpperCase()}</span><span><b>{user.displayName}{user.role === "owner" && <em className="role-tag">{t("所有者")}</em>}</b><small>{user.email}</small></span></div></td>
        <td className="m-hide access-cell">{(() => { const summary = accessSummary(user.access); return <><b className={summary.tone === "neutral" || user.status !== "active" ? "" : `tone-text ${summary.tone}`}>{summary.title}</b><small>{summary.detail}</small></>; })()}</td>
        <td className="m-hide"><b>{formatBytes(user.accessSummary?.totalBytes)}</b><small>{t("最后活动")} <Time value={user.accessSummary?.lastActivityAt} /></small></td>
        <td className="cell-status"><Pill value={user.status} label={statusLabels[user.status]} tone={user.status === "pending" ? "warning" : undefined} />{user.rejectionReason && <small>{user.rejectionReason}</small>}</td>
        <td className="m-hide"><Time value={user.createdAt} /></td>
        <td className="align-right cell-actions">{rowActions(user)}</td>
      </tr>)}</tbody></table></div>
      {!visible.length && <Empty action={search || filter !== "all" ? <button className="button ghost" onClick={() => { setSearch(""); setFilter("all"); }}>{t("清除筛选")}</button> : undefined}>{users.length ? t("没有符合条件的账号。") : t("还没有账号。")}</Empty>}
    </section>
    {resetLink && <Modal title={t("重置密码链接")} description={t("发给 {0}，对方打开后自己设置新密码。24 小时内有效，只能使用一次。", [resetLink.user.email])} onClose={() => setResetLink(null)} footer={<div className="form-actions"><button className="button primary" onClick={() => void copyResetLink()}>{t("复制链接")}</button></div>}>
      <input readOnly value={resetLink.url} aria-label={t("重置密码链接")} onFocus={(event) => event.currentTarget.select()} />
    </Modal>}
    {accessUser && <UserAccessDialog user={accessUser} onClose={() => setAccessUser(null)} onChanged={() => void onRefresh()} />}
  </>;
}
