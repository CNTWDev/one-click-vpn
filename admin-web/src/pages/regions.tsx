import { type FormEvent, useState } from "react";
import { api } from "../api";
import { useConfirm } from "../confirm-dialog";
import { countryName, countryOptions, presetGroups, regionPresets } from "../region-catalog";
import type { NodeRecord, Region } from "../types";
import { Empty, InlineNotice, type Notice, PageHeader } from "./shared";

export function RegionsPage({ regions, nodes, onRefresh }: { regions: Region[]; nodes: NodeRecord[]; onRefresh: () => Promise<void> }) {
  const [editing, setEditing] = useState<Region | null>(null);
  const [form, setForm] = useState({ name: "", country: "", code: "" });
  const [locationChoice, setLocationChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const confirm = useConfirm();

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
      setNotice({ tone: "success", message: editing ? "区域已更新。" : "区域已创建。" }); clear(); await onRefresh();
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
    finally { setBusy(false); }
  }
  async function remove(region: Region) {
    if (!await confirm({
      title: "删除区域",
      message: `确定删除区域 ${region.name} · ${region.country} 吗？仍有关联节点时系统会拒绝删除。`,
      confirmLabel: "删除区域",
      danger: true,
    })) return;
    try { await api(`/api/regions/${region.id}`, { method: "DELETE" }); setNotice({ tone: "success", message: "区域已删除。" }); await onRefresh(); }
    catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
  }
  return <>
    <PageHeader eyebrow="REGIONS" title="区域管理" description="维护节点所在区域；区域用于展示、分组和部署选择。" />
    <InlineNotice notice={notice} />
    <div className="region-layout">
      <section className="panel"><div className="panel-head"><div><p className="eyebrow">REGION DIRECTORY</p><h2>区域列表</h2></div></div>{regions.length ? <div className="region-list">{regions.map((region) => <article key={region.id}><span className="region-code">{region.code}</span><span className="grow"><b>{region.name}</b><small>{region.country} · {nodes.filter((node) => node.region_id === region.id).length} 个节点</small></span><span className="row-actions"><button className="text-button" onClick={() => edit(region)}>编辑</button><button className="text-button danger-text" onClick={() => void remove(region)}>删除</button></span></article>)}</div> : <Empty>尚未创建区域。</Empty>}</section>
      <section className="panel sticky-panel"><div className="panel-head"><div><p className="eyebrow">{editing ? "EDIT REGION" : "NEW REGION"}</p><h2>{editing ? "编辑区域" : "创建区域"}</h2></div></div><form className="stack-form" onSubmit={save}><label>服务器位置<select required value={locationChoice} onChange={(event) => chooseLocation(event.target.value)}><option value="">请选择服务器所在地</option>{presetGroups.map((group) => <optgroup key={group} label={`常用机房 · ${group}`}>{regionPresets.filter((item) => item.group === group).map((item) => <option key={item.id} value={`preset:${item.id}`}>{item.label}</option>)}</optgroup>)}<optgroup label="全球国家 / 地区">{countryOptions.map((item) => <option key={item.code} value={`country:${item.code}`}>{item.label}</option>)}</optgroup><option value="custom">自定义位置（城市未列出）</option></select><small>选择城市、州或国家后自动填写；同一国家可以添加多个区域，未列出的位置可自定义。</small></label><label>城市 / 区域显示名称<input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如 Tokyo、US West" /></label>{locationChoice === "custom" ? <label>国家 / 地区<select required value={form.code} onChange={(event) => chooseCountry(event.target.value)}><option value="">请选择国家 / 地区</option>{form.code && !countryOptions.some((item) => item.code === form.code) && <option value={form.code}>{form.country} ({form.code})</option>}{countryOptions.map((item) => <option key={item.code} value={item.code}>{item.label}</option>)}</select></label> : <label>国家 / 地区<input required readOnly value={form.country} placeholder="自动填写" /></label>}<label>国家 / 地区代码（ISO）<input required readOnly value={form.code} placeholder="自动填写" /></label><div className="form-actions">{editing && <button type="button" className="button ghost" onClick={clear}>取消</button>}<button className="button primary" disabled={busy}>{busy ? "保存中…" : "保存区域"}</button></div></form></section>
    </div>
  </>;
}
