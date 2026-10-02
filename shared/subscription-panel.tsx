import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import "./subscription-panel.css";

type Item = { id: string; credential_id: string; display_name: string; email: string; protocol: string; status: string; user_disabled: boolean; admin_disabled: boolean; account_status: string; expires_at: string; last_fetched_at: string | null; total_bytes: string; synced_nodes: number };
type Api = <T>(path: string, init?: RequestInit) => Promise<T>;
const clients = [
  { id: "hiddify", name: "Hiddify", platform: "iPhone · Android · Mac · Windows · Linux", url: "https://github.com/hiddify/hiddify-app/releases" },
  { id: "clash", name: "Clash Verge Rev", platform: "Mac · Windows · Linux", url: "https://github.com/clash-verge-rev/clash-verge-rev/releases" },
];
const bytes = (value: string) => { const n = Number(value); return n >= 1073741824 ? `${(n/1073741824).toFixed(2)} GB` : `${(n/1048576).toFixed(1)} MB`; };
const date = (value: string | null) => value ? new Date(value).toLocaleString("zh-CN") : "尚未拉取";

export function SubscriptionPanel({ api, admin = false, createOnly = false, availableProtocols = ["wireguard", "vless"], onCreated }: { api: Api; admin?: boolean; createOnly?: boolean; availableProtocols?: string[]; onCreated?: (credentialId: string) => void }) {
  const endpoint = admin ? "/api/v1/admin/subscriptions" : "/api/v1/subscriptions";
  const [items, setItems] = useState<Item[]>([]), [name, setName] = useState("我的订阅");
  const [protocol, setProtocol] = useState("wireguard"), [client, setClient] = useState("hiddify");
  const effectiveProtocol = availableProtocols.includes(protocol) ? protocol : availableProtocols.find((p) => ["wireguard", "vless"].includes(p)) || "";
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [link, setLink] = useState(""), [confirm, setConfirm] = useState<{ item: Item; action: string } | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!confirm) return;
    const previous = document.activeElement as HTMLElement | null;
    const buttons = dialogRef.current?.querySelectorAll<HTMLButtonElement>("button");
    buttons?.[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setConfirm(null);
      if (event.key === "Tab" && buttons?.length) {
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); previous?.focus(); };
  }, [confirm]);
  const refresh = useCallback(async () => { const result = await api<{ subscriptions: Item[] }>(endpoint); setItems(result.subscriptions); }, [api, endpoint]);
  useEffect(() => { void refresh().catch((e: Error) => setError(e.message)); const timer = setInterval(() => { void refresh().catch(() => {}); }, 30000); return () => clearInterval(timer); }, [refresh]);
  function showLink(token: string) { setLink(`${window.location.origin}/api/subscription?token=${encodeURIComponent(token)}`); }
  async function create(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      const result = await api<{ token: string; credentialId: string }>(endpoint, { method: "POST", body: JSON.stringify({ name, protocol: effectiveProtocol }) });
      showLink(result.token); setNotice("订阅已创建。首次节点权限同步通常需要几十秒；看到已同步节点后再导入。以后可在“我的连接”验证登录密码后再次获取链接。"); await refresh(); onCreated?.(result.credentialId);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function action(item: Item, action: string) {
    setConfirm(null); setBusy(true); setError("");
    try {
      const result = await api<{ token?: string; sync?: { status: string } }>(endpoint, { method: "PATCH", body: JSON.stringify({ id: item.id, action }) });
      if (result.token) showLink(result.token); else setLink("");
      setNotice(result.token ? "旧链接已失效，请重新导入新链接。已下载的连接凭据不会因此撤销；如链接泄露，请撤销此订阅并新建。"
        : result.sync?.status === "failed" ? "操作已保存，但节点权限同步失败，请到账号管理检查。" : "操作已保存，节点权限将在同步后生效；离线节点需要恢复连接后同步。");
      await refresh();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function copy() { try { await navigator.clipboard.writeText(link); setNotice("订阅链接已复制，请在客户端中添加远程订阅。"); } catch { setError("无法自动复制，请选中下方链接手动复制。"); } }
  const selected = clients.find((c) => c.id === client)!;
  const importUrl = client === "hiddify" ? `hiddify://import/${link}#Northstar` : `clash://install-config?url=${encodeURIComponent(link)}&name=Northstar`;
  return <section className="subscription-panel" aria-label={admin ? "订阅管理" : "动态订阅"}>
    <div className="subscription-heading"><div><p className="subscription-kicker">ONE IMPORT · ALL NODES</p><h2>{admin ? "订阅管理" : "一次导入，随时换节点"}</h2><p>{admin ? "按账号管理订阅访问权限。流量与连接凭据统一归集。" : "自动获取可用节点，在客户端切换；新增节点刷新后即可出现。"}</p></div><button disabled={busy} onClick={() => void refresh().catch((e: Error) => setError(e.message))}>刷新状态</button></div>
    {error && <p className="subscription-error" role="alert">{error}</p>}{notice && <p className="subscription-notice" role="status">{notice}</p>}
    {!admin && <div className="subscription-setup"><form onSubmit={create}>
      <label>给订阅取个名字<input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：日常使用" /></label>
      <label>使用的客户端<select value={client} onChange={(e) => setClient(e.target.value)}>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <details><summary>连接方式</summary><label>底层协议<select value={effectiveProtocol} onChange={(e) => setProtocol(e.target.value)}>{availableProtocols.includes("wireguard") && <option value="wireguard">WireGuard</option>}{availableProtocols.includes("vless") && <option value="vless">VLESS + REALITY</option>}</select></label><small>订阅包含该方式下的全部可用节点。新服务须管理员先部署。WireGuard 多端同时使用请各建一份订阅。</small></details>
      <button className="subscription-primary" disabled={busy || !effectiveProtocol}>{busy ? "处理中…" : effectiveProtocol ? "创建订阅" : "暂无可用节点"}</button>
    </form><aside><h3>三步开始使用</h3><ol><li>安装 <a href={selected.url} target="_blank" rel="noreferrer">{selected.name}</a><small>{selected.platform}</small></li><li>创建订阅，复制链接并在客户端添加订阅。</li><li>打开连接，选择「自动选择」或手动切换节点。</li></ol><p>支持订阅更新；手机后台刷新由客户端和系统决定。建议开启客户端自动更新，新增节点未出现时手动刷新。</p><p>官方 WireGuard / OpenVPN 客户端请切换到“指定节点”，下载配置文件。</p></aside></div>}
    {link && <div className="subscription-link"><b>个人订阅链接 · 请勿分享或上传转换网站</b><input readOnly aria-label="订阅链接" value={link} onFocus={(e) => e.target.select()} /><div className="subscription-actions"><button onClick={() => void copy()}>复制链接</button><a className="subscription-import" href={importUrl}>尝试导入 {selected.name}</a><button onClick={() => setLink("")}>隐藏链接</button></div><small>若客户端没有打开，请使用复制链接导入。刷新失败时先检查节点同步状态。</small></div>}
    {!createOnly && <div className="subscription-list">{items.map((item) => {
      const expired = new Date(item.expires_at).getTime() <= Date.now();
      const usable = item.status === "active" && !expired;
      const state = !usable ? (item.status === "revoked" ? "已撤销" : "已到期") : item.account_status !== "active" ? "账号已停用" : item.admin_disabled ? "管理员停用" : item.user_disabled ? "本人停用" : "有效";
      return <article key={item.id}><div className="subscription-row"><div><h3>{item.display_name}</h3><small>{admin ? `${item.email} · ` : ""}{item.protocol === "vless" ? "VLESS + REALITY" : "WireGuard"} · {state}</small></div><b>{bytes(item.total_bytes)}<small>近 30 天流量</small></b></div><p>{item.synced_nodes} 个节点已同步 · 到期 {date(item.expires_at)}</p><small>上次成功拉取：{date(item.last_fetched_at)}</small><div className="subscription-actions">
        {usable && <button disabled={busy || (!admin && item.admin_disabled)} onClick={() => setConfirm({ item, action: (admin ? item.admin_disabled : item.user_disabled) ? "enable" : "disable" })}>{(admin ? item.admin_disabled : item.user_disabled) ? "启用" : "停用"}</button>}
        {!admin && usable && !item.admin_disabled && !item.user_disabled && <button disabled={busy} onClick={() => setConfirm({ item, action: "reset-link" })}>重置链接</button>}
        {item.status === "active" && <button className="subscription-danger" disabled={busy} onClick={() => setConfirm({ item, action: "revoke" })}>撤销访问</button>}
        <button className="subscription-danger" disabled={busy} onClick={() => setConfirm({ item, action: "delete" })}>删除</button>
      </div></article>;
    })}{!items.length && <p className="subscription-empty">{admin ? "暂无订阅。用户创建后会显示在这里。" : "还没有订阅。创建后，无需逐个下载节点。"}</p>}</div>}
    {confirm && <div ref={dialogRef} className="subscription-confirm" role="alertdialog" aria-modal="true" aria-label="确认订阅操作"><div><h3>确认操作：{confirm.item.display_name}</h3><p>{confirm.action === "reset-link" ? "旧订阅链接将失效，需要重新导入；已有配置仍可连接。泄露时请撤销整个订阅。" : ["revoke", "delete"].includes(confirm.action) ? "将撤销该订阅在各节点的访问权限，无法恢复原凭据。删除后保留审计和历史流量。" : "将更新该订阅的节点访问权限。权限同步存在延迟，离线节点需恢复后才能生效。"}</p><div className="subscription-actions"><button onClick={() => setConfirm(null)}>取消</button><button className="subscription-primary" onClick={() => void action(confirm.item,confirm.action)}>确认</button></div></div></div>}
  </section>;
}
