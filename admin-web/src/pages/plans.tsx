import { t, useConsoleLanguage } from "../i18n";
import { type FormEvent, useEffect, useState } from "react";
import { api } from "../api";
import { Icon } from "../icons";
import { useToast } from "../toast";
import type { AccessPlan } from "../types";
import { planTerms } from "./account-access";
import { Empty, formatBytes, InlineNotice, Modal, type Notice, PageHeader, Pill } from "./shared";

const GB = 1024 ** 3;
type Form = { id: string; name: string; days: string; gb: string; devices: string; isWelcome: boolean; enabled: boolean };
const emptyForm: Form = { id: "", name: "", days: "30", gb: "", devices: "", isWelcome: false, enabled: true };

/** Console → 用户 → 套餐: the reusable grant templates (trial, week, month, year, welcome gift). */
export function PlansPage() {
  useConsoleLanguage();
  const [plans, setPlans] = useState<AccessPlan[] | null>(null), [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState<Notice | null>(null), [formNotice, setFormNotice] = useState<Notice | null>(null);
  const toast = useToast();
  useEffect(() => {
    api<{ plans: AccessPlan[] }>("/api/v1/admin/plans").then((result) => setPlans(result.plans)).catch((error: Error) => setNotice({ tone: "error", message: error.message }));
  }, []);

  async function save(body: Record<string, unknown>, done: string) {
    setBusy(true); setFormNotice(null);
    try { setPlans((await api<{ plans: AccessPlan[] }>("/api/v1/admin/plans", { method: "POST", body: JSON.stringify(body) })).plans); toast(done); return true; }
    catch (error) { (form ? setFormNotice : setNotice)({ tone: "error", message: (error as Error).message }); return false; }
    finally { setBusy(false); }
  }
  const payload = (plan: AccessPlan) => ({ id: plan.id, name: plan.name, durationDays: plan.durationDays, quotaBytes: plan.quotaBytes, deviceLimit: plan.deviceLimit, isWelcome: plan.isWelcome, enabled: plan.enabled });
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form) return;
    const ok = await save({ id: form.id || undefined, name: form.name, durationDays: form.days ? Number(form.days) : null,
      quotaBytes: form.gb ? Math.round(Number(form.gb) * GB) : null, deviceLimit: form.devices ? Number(form.devices) : null, isWelcome: form.isWelcome, enabled: form.enabled }, form.id ? t("套餐已更新。") : t("套餐已创建。"));
    if (ok) setForm(null);
  }
  function edit(plan: AccessPlan) {
    setFormNotice(null);
    setForm({ id: plan.id, name: plan.name, days: plan.durationDays ? String(plan.durationDays) : "", gb: plan.quotaBytes ? String(Math.round((plan.quotaBytes / GB) * 100) / 100) : "",
      devices: plan.deviceLimit ? String(plan.deviceLimit) : "", isWelcome: plan.isWelcome, enabled: plan.enabled });
  }

  return <>
    <PageHeader title={t("套餐")} description={t("套餐是给账号增加权益时的模板。修改套餐只影响之后的发放，已发放的权益保持不变。")}
      actions={<button className="button primary" onClick={() => { setFormNotice(null); setForm(emptyForm); }}><Icon name="plus" size={16} />{t("新建套餐")}</button>} />
    <InlineNotice notice={notice} />
    <section className="panel flush table-panel">
      {plans === null ? <div className="skeleton-block" role="status" aria-label={t("正在读取套餐")}><i /><i /><i /></div> : plans.length ? <div className="table-wrap"><table className="data-table cards plan-table">
        <thead><tr><th>{t("名称")}</th><th>{t("有效期")}</th><th>{t("流量")}</th><th>{t("设备上限")}</th><th>{t("状态")}</th><th className="align-right">{t("操作")}</th></tr></thead>
        <tbody>{plans.map((plan) => <tr key={plan.id}>
          <td className="cell-main"><b>{plan.name}</b><small className="m-only">{planTerms(plan)}</small>{plan.isWelcome && <small>{t("新注册用户自动获得")}</small>}</td>
          <td className="m-hide">{plan.durationDays ? t("{0} 天", [plan.durationDays]) : t("长期有效")}</td>
          <td className="m-hide">{plan.quotaBytes ? formatBytes(plan.quotaBytes) : t("不限流量")}</td>
          <td className="m-hide">{plan.deviceLimit ?? t("不限")}</td>
          <td className="cell-status"><Pill value={plan.enabled ? "enabled" : "disabled"} label={plan.enabled ? t("已启用") : t("已停用")} tone={plan.enabled ? "success" : "neutral"} /></td>
          <td className="align-right cell-actions"><div className="row-actions">
            <button className="button ghost small" disabled={busy} onClick={() => void save({ ...payload(plan), enabled: !plan.enabled }, plan.enabled ? t("套餐已停用。") : t("套餐已启用。"))}>{plan.enabled ? t("停用") : t("启用")}</button>
            <button className="button ghost small" onClick={() => edit(plan)}>{t("编辑")}</button></div></td>
        </tr>)}</tbody></table></div> : <Empty>{t("还没有套餐。")}</Empty>}
    </section>
    {form && <Modal title={form.id ? t("编辑套餐") : t("新建套餐")} description={t("天数、流量和设备上限留空都表示不限。设备数包括客户端、订阅和节点配置。")} onClose={() => setForm(null)}
      footer={<><InlineNotice notice={formNotice} /><div className="form-actions"><button type="button" className="button ghost" onClick={() => setForm(null)}>{t("取消")}</button><button type="submit" form="plan-form" className="button primary" disabled={busy}>{busy ? t("保存中…") : t("保存")}</button></div></>}>
      <form id="plan-form" className="form-grid" onSubmit={(event) => void submit(event)}>
        <label className="span-2">{t("名称")}<input required maxLength={60} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder={t("月卡")} /></label>
        <label>{t("有效天数")}<input type="number" min={1} max={3650} placeholder={t("长期有效")} value={form.days} onChange={(event) => setForm({ ...form, days: event.target.value })} /></label>
        <label>{t("流量（GB）")}<input type="number" min={0.1} step={0.1} placeholder={t("不限流量")} value={form.gb} onChange={(event) => setForm({ ...form, gb: event.target.value })} /></label>
        <label>{t("设备上限")}<input type="number" min={1} max={100} placeholder={t("不限")} value={form.devices} onChange={(event) => setForm({ ...form, devices: event.target.value })} /></label>
        <label>{t("状态")}<select value={form.enabled ? "on" : "off"} onChange={(event) => setForm({ ...form, enabled: event.target.value === "on", isWelcome: event.target.value === "on" && form.isWelcome })}><option value="on">{t("启用")}</option><option value="off">{t("停用")}</option></select></label>
        <label className="grant-check span-2"><input type="checkbox" disabled={!form.enabled} checked={form.isWelcome} onChange={(event) => setForm({ ...form, isWelcome: event.target.checked })} />{t("新注册用户自动获得这个套餐")}</label>
      </form>
    </Modal>}
  </>;
}
