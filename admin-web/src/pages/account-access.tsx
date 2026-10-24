import { t, useConsoleLanguage } from "../i18n";
import { type FormEvent, useEffect, useState } from "react";
import { api } from "../api";
import { useConfirm } from "../confirm-dialog";
import { useToast } from "../toast";
import type { AccessGrant, AccessPlan, AccountAccess } from "../types";
import { formatBytes, formatDate, InlineNotice, type Notice, Pill } from "./shared";

const SOON_DAYS = 7;

/** One line for lists: the end of the period and the traffic left, with a tone for what needs attention. */
export function accessSummary(access?: AccountAccess | null): { title: string; detail: string; tone: "success" | "warning" | "danger" | "neutral" } {
  if (!access || access.state === "none") return { title: t("无可用权益"), detail: "—", tone: "danger" };
  if (access.state === "expired") return { title: t("已到期"), detail: access.endedAt ? formatDate(access.endedAt) : "—", tone: "danger" };
  if (access.state === "exhausted") return { title: t("流量已用完"), detail: t("已用 {0} / {1}", [formatBytes(access.usedBytes), formatBytes(access.quotaBytes || 0)]), tone: "danger" };
  const soon = access.until !== null && Date.parse(access.until) - Date.now() <= SOON_DAYS * 86_400_000;
  const low = access.quotaBytes !== null && (access.remainingBytes || 0) <= access.quotaBytes * 0.1;
  return {
    title: access.until ? t("至 {0}", [formatDate(access.until)]) : t("长期有效"),
    detail: access.quotaBytes === null ? t("不限流量") : t("剩余 {0} / {1}", [formatBytes(access.remainingBytes || 0), formatBytes(access.quotaBytes)]),
    tone: soon || low ? "warning" : "neutral",
  };
}

const daysLeft = (until: string) => Math.max(0, Math.ceil((Date.parse(until) - Date.now()) / 86_400_000));

export function planTerms(plan: Pick<AccessPlan, "durationDays" | "quotaBytes" | "deviceLimit">): string {
  return [plan.durationDays ? t("{0} 天", [plan.durationDays]) : t("长期有效"), plan.quotaBytes ? formatBytes(plan.quotaBytes) : t("不限流量"),
    ...(plan.deviceLimit ? [t("{0} 台设备", [plan.deviceLimit])] : [])].join(" · ");
}

const sourceLabels = (): Record<AccessGrant["source"], string> => ({ admin: t("后台开通"), gift: t("福利赠送"), welcome: t("新用户赠送"), order: t("订阅订单"), migration: t("原有账号") });
const stateLabels = (): Record<AccessGrant["state"], string> => ({ active: t("生效中"), upcoming: t("待生效"), expired: t("已到期"), exhausted: t("已用完"), revoked: t("已撤销") });
const stateTones: Record<AccessGrant["state"], "success" | "progress" | "neutral" | "danger"> = { active: "success", upcoming: "progress", expired: "neutral", exhausted: "danger", revoked: "neutral" };

type View = { access: AccountAccess; grants: AccessGrant[] };
type Form = { plan: string; period: "forever" | "days" | "date"; days: string; date: string; traffic: "unlimited" | "gb"; gb: string; devices: string; gift: boolean; note: string };
const emptyForm: Form = { plan: "", period: "days", days: "30", date: "", traffic: "unlimited", gb: "", devices: "", gift: false, note: "" };

/** Console → 账号管理 → 访问详情: what the account may use and every grant that gave it. */
export function AccessPanel({ userId, onChanged }: { userId: string; onChanged?: () => void }) {
  useConsoleLanguage();
  const [view, setView] = useState<View | null>(null), [plans, setPlans] = useState<AccessPlan[]>([]);
  const [form, setForm] = useState<Form | null>(null), [busy, setBusy] = useState(false), [notice, setNotice] = useState<Notice | null>(null);
  const confirm = useConfirm(), toast = useToast(), path = `/api/v1/admin/users/${userId}/access`;
  useEffect(() => {
    let current = true;
    api<View>(path).then((value) => { if (current) setView(value); }).catch((error: Error) => { if (current) setNotice({ tone: "error", message: error.message }); });
    return () => { current = false; };
  }, [path]);
  useEffect(() => { void api<{ plans: AccessPlan[] }>("/api/v1/admin/plans").then((result) => setPlans(result.plans)).catch(() => undefined); }, []);

  async function send(body: Record<string, unknown>, done: string) {
    setBusy(true); setNotice(null);
    try { setView(await api<View>(path, { method: "POST", body: JSON.stringify(body) })); toast(done); setForm(null); onChanged?.(); return true; }
    catch (error) { setNotice({ tone: "error", message: (error as Error).message }); return false; }
    finally { setBusy(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form) return;
    const custom = form.plan === "custom";
    await send(custom ? {
      action: "grant", gift: form.gift, note: form.note,
      days: form.period === "days" ? Number(form.days) : null,
      endsAt: form.period === "date" && form.date ? `${form.date}T23:59:59.999Z` : null,
      quotaGb: form.traffic === "gb" ? Number(form.gb) : null, deviceLimit: form.devices ? Number(form.devices) : null,
    } : { action: "grant", planId: form.plan, gift: form.gift, note: form.note }, t("权益已增加，节点会在半分钟内同步。"));
  }
  async function revoke(grant: AccessGrant) {
    if (!await confirm({ title: t("撤销这条权益？"), message: t("撤销后立即重新计算有效期和流量，排在它后面的权益会提前开始。"), confirmLabel: t("撤销权益"), danger: true })) return;
    await send({ action: "revoke", grantId: grant.id }, t("权益已撤销。"));
  }

  const summary = accessSummary(view?.access);
  const access = view?.access;
  const enabledPlans = plans.filter((plan) => plan.enabled);
  const sources = sourceLabels(), states = stateLabels();
  return <section className="access-panel" aria-labelledby={`access-${userId}`}>
    <div className="access-panel-head"><h3 id={`access-${userId}`}>{t("账号权益")}</h3>
      {!form && <button className="button primary small" disabled={!view} onClick={() => setForm({ ...emptyForm, plan: enabledPlans.find((plan) => !plan.isWelcome)?.id || "custom" })}>{t("增加权益")}</button>}</div>
    <InlineNotice notice={notice} />
    {access && <div className="access-facts">
      <article className={`tone-${summary.tone === "neutral" ? "plain" : summary.tone}`}><small>{t("有效期")}</small><b>{access.state === "active" ? access.until ? formatDate(access.until) : t("长期有效") : summary.title}</b>
        <span>{access.state === "active" ? access.until ? t("剩 {0} 天", [daysLeft(access.until)]) : t("没有到期日") : access.state === "expired" ? summary.detail : t("增加权益后恢复")}</span></article>
      <article><small>{t("流量")}</small><b>{access.quotaBytes === null ? t("不限") : formatBytes(access.remainingBytes || 0)}</b>
        {access.quotaBytes !== null ? <><span>{t("已用 {0} / {1}", [formatBytes(access.usedBytes), formatBytes(access.quotaBytes)])}</span><i className={`quota-bar${(access.remainingBytes || 0) <= access.quotaBytes * 0.1 ? " low" : ""}`} aria-hidden="true"><i style={{ width: `${Math.min(100, (access.usedBytes / access.quotaBytes) * 100)}%` }} /></i></> : <span>{t("全部节点合计")}</span>}</article>
      <article><small>{t("设备上限")}</small><b>{access.deviceLimit ?? "—"}</b><span>{access.deviceLimit ? t("来自套餐") : t("系统默认或单独设置")}</span></article>
    </div>}
    {form && <form className="grant-form" onSubmit={(event) => void submit(event)}>
      <label className="span-2">{t("内容")}<select value={form.plan} onChange={(event) => setForm({ ...form, plan: event.target.value })}>
        {enabledPlans.map((plan) => <option key={plan.id} value={plan.id}>{`${plan.name} · ${planTerms(plan)}`}</option>)}
        <option value="custom">{t("自定义…")}</option></select></label>
      {form.plan === "custom" && <>
        <label>{t("有效期")}<span className="field-pair"><select value={form.period} onChange={(event) => setForm({ ...form, period: event.target.value as Form["period"] })}><option value="days">{t("按天数")}</option><option value="date">{t("到指定日期")}</option><option value="forever">{t("长期有效")}</option></select>
          {form.period === "days" && <input type="number" min={1} max={3650} required aria-label={t("天数")} value={form.days} onChange={(event) => setForm({ ...form, days: event.target.value })} />}
          {form.period === "date" && <input type="date" required aria-label={t("到期日期")} value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} />}</span></label>
        <label>{t("流量")}<span className="field-pair"><select value={form.traffic} onChange={(event) => setForm({ ...form, traffic: event.target.value as Form["traffic"] })}><option value="unlimited">{t("不限流量")}</option><option value="gb">{t("限定流量")}</option></select>
          {form.traffic === "gb" && <input type="number" min={0.1} step={0.1} required aria-label={t("流量（GB）")} placeholder="GB" value={form.gb} onChange={(event) => setForm({ ...form, gb: event.target.value })} />}</span></label>
        <label>{t("设备上限")}<input type="number" min={1} max={100} placeholder={t("不变")} value={form.devices} onChange={(event) => setForm({ ...form, devices: event.target.value })} /></label>
      </>}
      <label className={form.plan === "custom" ? "" : "span-2"}>{t("备注")}<input maxLength={200} placeholder={t("可留空")} value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} /></label>
      <label className="grant-check span-2"><input type="checkbox" checked={form.gift} onChange={(event) => setForm({ ...form, gift: event.target.checked })} />{t("记为福利赠送")}</label>
      <p className="grant-hint span-2">{t("有天数的权益接在当前有效期之后开始，其余立即生效。流量按全部节点合计扣减。")}</p>
      <div className="form-actions span-2"><button type="button" className="button ghost" onClick={() => setForm(null)}>{t("取消")}</button><button className="button primary" disabled={busy}>{busy ? t("保存中…") : t("确认增加")}</button></div>
    </form>}
    {view && <div className="grant-list">{view.grants.map((grant) => <div key={grant.id} className={grant.state === "revoked" || grant.state === "expired" ? "past" : ""}>
      <span className="grow"><b>{grant.planName || (grant.source === "migration" ? t("升级前已有的账号") : t("自定义权益"))}</b>
        <small>{[sources[grant.source], grant.endsAt ? t("{0} 至 {1}", [formatDate(grant.startsAt), formatDate(grant.endsAt)]) : t("{0} 起长期有效", [formatDate(grant.startsAt)]),
          grant.quotaBytes === null ? t("不限流量") : t("已用 {0} / {1}", [formatBytes(grant.usedBytes), formatBytes(grant.quotaBytes)]), ...(grant.note ? [grant.note] : [])].join(" · ")}</small></span>
      <Pill value={grant.state} label={states[grant.state]} tone={stateTones[grant.state]} />
      {(grant.state === "active" || grant.state === "upcoming" || grant.state === "exhausted") ? <button className="button ghost small" disabled={busy} onClick={() => void revoke(grant)}>{t("撤销")}</button> : <span className="menu-spacer" />}
    </div>)}</div>}
  </section>;
}

