import { t, useConsoleLanguage } from "../i18n";
import { type FormEvent, useState } from "react";
import { api } from "../api";
import { useConfirm } from "../confirm-dialog";
import { useToast } from "../toast";
import { countryName, countryOptions, presetGroups, regionPresets, localizedCountryLabel, localizedPresetLabel } from "../region-catalog";
import { href } from "../router";
import type { NodeRecord, Region } from "../types";
import { Empty, InlineNotice, type Notice, PageHeader } from "./shared";

export function RegionsPage({ regions, nodes, onRefresh }: { regions: Region[]; nodes: NodeRecord[]; onRefresh: () => Promise<void> }) {
  const locale = useConsoleLanguage();
  const [editing, setEditing] = useState<Region | null>(null);
  const [form, setForm] = useState({ name: "", country: "", code: "" });
  const [locationChoice, setLocationChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const confirm = useConfirm();
  const toast = useToast();

  function edit(region: Region) {
    const preset = regionPresets.find((item) => item.name === region.name && item.code === region.code);
    setEditing(region); setForm({ name: region.name, country: region.country, code: region.code });
    setLocationChoice(preset ? `preset:${preset.id}` : region.name === countryName(region.code) ? `country:${region.code}` : "custom");
  }
  function clear() { setEditing(null); setForm({ name: "", country: "", code: "" }); setLocationChoice(""); }
  function chooseLocation(value: string) {
    setLocationChoice(value);
    if (value.startsWith("preset:")) {
      const preset = regionPresets.find((item) => item.id === value.slice(7));
      if (preset) setForm({ name: preset.name, country: countryName(preset.code), code: preset.code });
    } else if (value.startsWith("country:")) {
      const code = value.slice(8);
      const country = countryName(code);
      setForm({ name: country, country, code });
    } else if (value === "custom" && !editing) {
      setForm({ name: "", country: "", code: "" });
    }
  }
  function chooseCountry(code: string) {
    const option = countryOptions.find((item) => item.code === code);
    setForm((current) => ({ ...current, country: option?.country || countryName(code), code }));
  }
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setNotice(null);
    try {
      await api(editing ? `/api/regions/${editing.id}` : "/api/regions", { method: editing ? "PATCH" : "POST", body: JSON.stringify(form) });
      toast(editing ? t("区域已更新。") : t("区域已创建。")); clear(); await onRefresh();
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
    finally { setBusy(false); }
  }
  async function remove(region: Region) {
    if (!await confirm({
      title: t("删除区域"),
      message: t("确定删除区域 {0} · {1} 吗？仍有关联节点时系统会拒绝删除。", [region.name, region.country]),
      confirmLabel: t("删除区域"),
      danger: true,
    })) return;
    try { await api(`/api/regions/${region.id}`, { method: "DELETE" }); toast(t("区域已删除。")); await onRefresh(); }
    catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
  }
  return <>
    <PageHeader title={t("区域管理")} description={t("维护节点所在区域；区域用于展示、分组和部署选择。")} />
    <InlineNotice notice={notice} />
    <div className="region-layout">
      <section className="panel"><div className="panel-head"><h2>{t("区域列表")}</h2><span className="count-badge">{regions.length}</span></div>{regions.length ? <div className="region-list">{regions.map((region) => <article key={region.id}><span className="region-code">{region.code}</span><span className="grow"><b>{region.name}</b><small>{region.country} · <a href={href("nodes", { q: region.name })}>{t("{0} 个节点", [nodes.filter((node) => node.region_id === region.id).length])}</a></small></span><span className="row-actions"><button className="text-button" onClick={() => edit(region)}>{t("编辑")}</button><button className="text-button danger-text" onClick={() => void remove(region)}>{t("删除")}</button></span></article>)}</div> : <Empty>{t("尚未创建区域，请在右侧选择服务器位置创建。")}</Empty>}</section>
      <section className="panel sticky-panel"><div className="panel-head"><h2>{editing ? t("编辑区域") : t("创建区域")}</h2></div><form className="stack-form" onSubmit={save}><label>{t("服务器位置")}<select required value={locationChoice} onChange={(event) => chooseLocation(event.target.value)}><option value="">{t("请选择服务器所在地")}</option>{presetGroups.map((group) => <optgroup key={group} label={t("常用机房 · {0}", [t(group)])}>{regionPresets.filter((item) => item.group === group).map((item) => <option key={item.id} value={`preset:${item.id}`}>{localizedPresetLabel(item, locale)}</option>)}</optgroup>)}<optgroup label={t("全球国家 / 地区")}>{countryOptions.map((item) => <option key={item.code} value={`country:${item.code}`}>{localizedCountryLabel(item.code, locale)}</option>)}</optgroup><option value="custom">{t("自定义位置（城市未列出）")}</option></select><small>{t("选择城市、州或国家后自动填写；同一国家可以添加多个区域，未列出的位置可自定义。")}</small></label><label>{t("城市 / 区域显示名称")}<input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder={t("例如 Tokyo、US West")} /></label>{locationChoice === "custom" ? <label>{t("国家 / 地区")}<select required value={form.code} onChange={(event) => chooseCountry(event.target.value)}><option value="">{t("请选择国家 / 地区")}</option>{form.code && !countryOptions.some((item) => item.code === form.code) && <option value={form.code}>{form.country} ({form.code})</option>}{countryOptions.map((item) => <option key={item.code} value={item.code}>{localizedCountryLabel(item.code, locale)}</option>)}</select></label> : <label>{t("国家 / 地区")}<input required readOnly value={form.country} placeholder={t("自动填写")} /></label>}<label>{t("国家 / 地区代码（ISO）")}<input required readOnly value={form.code} placeholder={t("自动填写")} /></label><div className="form-actions">{editing && <button type="button" className="button ghost" onClick={clear}>{t("取消")}</button>}<button className="button primary" disabled={busy}>{busy ? t("保存中…") : t("保存区域")}</button></div></form></section>
    </div>
  </>;
}
