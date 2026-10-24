import { t, useConsoleLanguage } from "../i18n";
import { type ChangeEvent, type FormEvent, useCallback, useEffect, useState } from "react";
import { BrandMark } from "../../../shared/brand";
import { api } from "../api";
import { useConfirm } from "../confirm-dialog";
import { useToast } from "../toast";
import { Empty, InlineNotice, Menu, type Notice, PageHeader, Pill, StateDot } from "./shared";

type Site = { id: string; name: string; portalDomain: string; consoleDomain: string; apiDomain: string; logoSvg: string; mailFromName: string; isDefault: boolean };
type Role = "portal" | "console" | "api";
type DomainCheck = { role: Role; domain: string; status: "ok" | "other-site" | "unreachable"; detail: string };

const empty = { name: "", portalDomain: "", apiDomain: "", consoleDomain: "", mailFromName: "", logoSvg: "" };
const roles: Array<{ role: Role; key: "portalDomain" | "apiDomain" | "consoleDomain"; label: string; port: number }> = [
  { role: "portal", key: "portalDomain", label: "用户访问", port: 3100 },
  { role: "api", key: "apiDomain", label: "订阅 / API", port: 3000 },
  { role: "console", key: "consoleDomain", label: "管理后台", port: 3200 },
];

/** Brands on the shared engine: each site has its own name, logo and three hostnames; accounts and nodes are shared. */
export function SitesPage() {
  useConsoleLanguage();
  const [sites, setSites] = useState<Site[] | null>(null);
  const [editing, setEditing] = useState<Site | null>(null);
  const [form, setForm] = useState(empty);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [checks, setChecks] = useState<Record<string, DomainCheck[] | "checking">>({});
  const confirm = useConfirm();
  const toast = useToast();

  const refresh = useCallback(() => api<{ sites: Site[] }>("/api/v1/admin/sites")
    .then((result) => setSites(result.sites))
    .catch((error: Error) => setNotice({ tone: "error", message: error.message })), []);
  useEffect(() => { void refresh(); }, [refresh]);

  function edit(site: Site) {
    setEditing(site);
    setForm({ name: site.name, portalDomain: site.portalDomain, apiDomain: site.apiDomain, consoleDomain: site.consoleDomain, mailFromName: site.mailFromName, logoSvg: site.logoSvg });
  }
  function clear() { setEditing(null); setForm(empty); }

  async function chooseLogo(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 48 * 1024) { setNotice({ tone: "error", message: t("Logo 需小于 48 KB。") }); return; }
    const text = await file.text();
    if (!/<svg[\s>]/i.test(text)) { setNotice({ tone: "error", message: t("请选择 SVG 格式的 Logo。") }); return; }
    setForm((current) => ({ ...current, logoSvg: text.trim() }));
  }

  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setNotice(null);
    try {
      await api(editing ? `/api/v1/admin/sites/${editing.id}` : "/api/v1/admin/sites", { method: editing ? "PUT" : "POST", body: JSON.stringify(form) });
      toast(editing ? t("站点已更新。") : t("站点已创建。按左侧说明在宝塔添加这几个域名。")); clear(); await refresh();
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
    finally { setBusy(false); }
  }

  async function makeDefault(site: Site) {
    if (!await confirm({ title: t("设为默认站点"), message: t("未绑定的域名和客户端 App 将显示 {0}。", [site.name]), confirmLabel: t("设为默认") })) return;
    try { await api(`/api/v1/admin/sites/${site.id}`, { method: "PATCH", body: JSON.stringify({ default: true }) }); toast(t("默认站点已更改。")); await refresh(); }
    catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
  }

  async function remove(site: Site) {
    if (!await confirm({ title: t("删除站点"), message: t("删除后，{0} 的域名将显示默认站点。账号和节点不受影响。", [site.name]), confirmLabel: t("删除站点"), danger: true })) return;
    try { await api(`/api/v1/admin/sites/${site.id}`, { method: "DELETE" }); toast(t("站点已删除。")); if (editing?.id === site.id) clear(); await refresh(); }
    catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
  }

  async function check(site: Site) {
    setChecks((current) => ({ ...current, [site.id]: "checking" }));
    try { const result = await api<{ checks: DomainCheck[] }>(`/api/v1/admin/sites/${site.id}/check`); setChecks((current) => ({ ...current, [site.id]: result.checks })); }
    catch (error) { setChecks((current) => { const next = { ...current }; delete next[site.id]; return next; }); setNotice({ tone: "error", message: (error as Error).message }); }
  }

  const checkLabel = (result: DomainCheck) => result.status === "ok" ? t("已连通") : result.status === "other-site" ? t("指向了其他站点：{0}", [result.detail]) : t("无法访问：{0}", [result.detail]);

  return <>
    <PageHeader title={t("站点")} description={t("同一套账号和节点，按访问域名显示不同的名称和 Logo。")} />
    <InlineNotice notice={notice} />
    <div className="region-layout">
      <div className="site-stack">
        <section className="panel"><div className="panel-head"><h2>{t("站点列表")}</h2><span className="count-badge">{sites?.length ?? 0}</span></div>
          {sites && !sites.length && <Empty>{t("还没有站点。部署时配置的域名会在下次更新后自动成为默认站点。")}</Empty>}
          {sites?.length ? <div className="site-list">{sites.map((site) => {
            const result = checks[site.id];
            return <article key={site.id}>
              <span className="site-mark"><BrandMark size={24} logoSvg={site.logoSvg} /></span>
              <div className="grow">
                <div className="site-title"><b>{site.name}</b>{site.isDefault && <Pill value="default" label={t("默认")} tone="success" />}</div>
                <dl className="site-domains">{roles.map(({ role, key, label }) => {
                  const domain = site[key];
                  const status = Array.isArray(result) ? result.find((item) => item.role === role) : undefined;
                  return <div key={role}><dt>{t(label)}</dt><dd>{domain || <span className="muted">{t("未设置")}</span>}{status && <small className={`site-check ${status.status}`}><StateDot tone={status.status === "ok" ? "success" : "danger"} />{checkLabel(status)}</small>}</dd></div>;
                })}</dl>
              </div>
              <span className="row-actions">
                <button className="text-button" disabled={result === "checking"} onClick={() => void check(site)}>{result === "checking" ? t("检查中…") : t("检查域名")}</button>
                <button className="text-button" onClick={() => edit(site)}>{t("编辑")}</button>
                {!site.isDefault && <Menu items={[{ label: t("设为默认"), onSelect: () => void makeDefault(site) }, { label: t("删除站点"), danger: true, onSelect: () => void remove(site) }]} />}
              </span>
            </article>;
          })}</div> : null}
        </section>
        <section className="panel site-guide"><div className="panel-head"><h2>{t("在宝塔添加站点")}</h2></div>
          <ol>
            <li>{t("在 DNS 把这几个域名解析到本服务器。")}</li>
            <li>{t("宝塔 → 网站 → 添加站点，每个域名建一个。")}</li>
            <li>{t("每个网站的反向代理目标：")}<table><tbody>{roles.map(({ role, label, port }) => <tr key={role}><th>{t(label)}</th><td><code>http://127.0.0.1:{port}</code></td></tr>)}</tbody></table></li>
            <li>{t("反向代理的“发送域名”填 {0}，系统靠它识别站点。", ["$host"])}</li>
            <li>{t("SSL → Let's Encrypt 申请证书，然后点“检查域名”。")}</li>
          </ol>
        </section>
      </div>
      <section className="panel sticky-panel"><div className="panel-head"><h2>{editing ? t("编辑站点") : t("新建站点")}</h2></div>
        <form className="stack-form" onSubmit={save}>
          <label>{t("站点名称")}<input required maxLength={40} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="TrackNothing" /></label>
          <label>{t("用户访问域名")}<input required value={form.portalDomain} onChange={(event) => setForm({ ...form, portalDomain: event.target.value })} placeholder="app.example.com" /></label>
          <label>{t("订阅 / API 域名")}<input required value={form.apiDomain} onChange={(event) => setForm({ ...form, apiDomain: event.target.value })} placeholder="api.example.com" /><small>{t("订阅链接使用这个域名。")}</small></label>
          <label>{t("管理后台域名")}<input value={form.consoleDomain} onChange={(event) => setForm({ ...form, consoleDomain: event.target.value })} placeholder="console.example.com" /></label>
          <label>{t("邮件发件人名称")}<input maxLength={80} value={form.mailFromName} onChange={(event) => setForm({ ...form, mailFromName: event.target.value })} placeholder={form.name || t("留空则用邮件设置里的名称")} /></label>
          <div className="site-logo-field"><span className="site-mark large"><BrandMark size={36} logoSvg={form.logoSvg} /></span><div className="grow"><b>{t("Logo")}</b><small>{form.logoSvg ? t("自定义 SVG") : t("默认图标")}</small></div>
            <div className="site-logo-actions"><label className="button ghost">{t("上传 SVG")}<input type="file" accept=".svg,image/svg+xml" hidden onChange={(event) => void chooseLogo(event)} /></label>
              {form.logoSvg && <button type="button" className="text-button" onClick={() => setForm({ ...form, logoSvg: "" })}>{t("移除")}</button>}</div>
          </div>
          <div className="form-actions">{editing && <button type="button" className="button ghost" onClick={clear}>{t("取消")}</button>}<button className="button primary" disabled={busy}>{busy ? t("保存中…") : t("保存站点")}</button></div>
        </form>
      </section>
    </div>
  </>;
}
