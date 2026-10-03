import { type FormEvent, useEffect, useState } from "react";
import { api } from "../api";
import { Icon } from "../icons";
import { useToast } from "../toast";
import type { ControllerInfo } from "../types";
import { formatBytes, InlineNotice, type Notice, PageHeader, Pill, Time } from "./shared";

export function ControllerPage({ onSettingsChange }: { onSettingsChange: (settings: ControllerInfo["settings"]) => void }) {
  const [info, setInfo] = useState<ControllerInfo | null>(null);
  const [form, setForm] = useState({ displayName: "", locationLabel: "", latitude: "", longitude: "" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const toast = useToast();
  async function refresh() {
    try {
      const result = await api<ControllerInfo>("/api/controller"); setInfo(result); onSettingsChange(result.settings);
      setForm({ displayName: result.settings.display_name, locationLabel: result.settings.location_label, latitude: result.settings.latitude === null ? "" : String(result.settings.latitude), longitude: result.settings.longitude === null ? "" : String(result.settings.longitude) });
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
  }
  useEffect(() => {
    void api<ControllerInfo>("/api/controller").then((result) => {
      setInfo(result);
      onSettingsChange(result.settings);
      setForm({ displayName: result.settings.display_name, locationLabel: result.settings.location_label, latitude: result.settings.latitude === null ? "" : String(result.settings.latitude), longitude: result.settings.longitude === null ? "" : String(result.settings.longitude) });
    }).catch((error: Error) => setNotice({ tone: "error", message: error.message }));
  }, [onSettingsChange]);
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setNotice(null);
    try {
      const result = await api<ControllerInfo>("/api/controller", { method: "PUT", body: JSON.stringify({ displayName: form.displayName, locationLabel: form.locationLabel, latitude: form.latitude === "" ? null : Number(form.latitude), longitude: form.longitude === "" ? null : Number(form.longitude) }) });
      setInfo(result); onSettingsChange(result.settings); toast("Controller 设置已保存，全球拓扑已同步更新。");
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
    finally { setBusy(false); }
  }
  return <>
    <PageHeader title="Controller" description="查看控制面运行状态，并维护对外展示的名称与位置。" actions={<button className="button ghost" onClick={() => void refresh()}><Icon name="refresh" size={16} />刷新</button>} />
    <InlineNotice notice={notice} onRetry={notice?.tone === "error" ? () => void refresh() : undefined} />
    {info ? <><section className="controller-hero"><div><span className="live-mark" /> <Pill value={info.status} /><h2>{info.settings.display_name}</h2><p>{info.publicOrigin}</p></div><div className="controller-stats"><span><small>构建版本</small><b>{info.build}</b></span><span><small>运行时</small><b>Node {info.runtime.nodeVersion}</b></span><span><small>运行时间</small><b>{Math.floor(info.runtime.uptimeSeconds / 3600)} 小时</b></span><span><small>内存</small><b>{formatBytes(info.runtime.rssBytes)}</b></span><span><small>1 分钟负载</small><b>{info.runtime.load1.toFixed(2)}</b></span><span><small>公网 IP</small><b>{info.publicIp || "未检测"}</b></span></div></section><div className="two-column controller-layout"><section className="panel"><div className="panel-head"><h2>显示与位置</h2></div><form className="stack-form" onSubmit={save}><label>Controller 名称<input required value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} /></label><label>位置名称<input value={form.locationLabel} onChange={(event) => setForm({ ...form, locationLabel: event.target.value })} placeholder="Singapore · SG" /></label><div className="split-fields"><label>纬度<input type="number" min="-90" max="90" step="any" value={form.latitude} onChange={(event) => setForm({ ...form, latitude: event.target.value })} /></label><label>经度<input type="number" min="-180" max="180" step="any" value={form.longitude} onChange={(event) => setForm({ ...form, longitude: event.target.value })} /></label></div><small>经纬度必须同时填写或同时留空。当前来源：{({ unset: "未设置", environment: "环境变量", manual: "手动设置" } as Record<string, string>)[info.settings.location_source] || info.settings.location_source}</small><div className="form-actions"><button className="button primary" disabled={busy}>{busy ? "保存中…" : "保存设置"}</button></div></form></section><section className="panel"><div className="panel-head"><h2>运行详情</h2></div><dl className="detail-list"><div><dt>公网域名</dt><dd>{info.publicHost}</dd></div><div><dt>堆内存</dt><dd>{formatBytes(info.runtime.heapUsedBytes)}</dd></div><div><dt>常驻内存（RSS）</dt><dd>{formatBytes(info.runtime.rssBytes)}</dd></div><div><dt>最近观测</dt><dd><Time value={info.runtime.observedAt} /></dd></div></dl></section></div></> : notice ? null : <div className="skeleton-block" role="status" aria-label="正在读取 Controller 状态"><i /><i /><i /></div>}
  </>;
}
