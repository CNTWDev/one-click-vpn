import { formatDate, message, translateMessage, type LocalizedMessage } from "../../../shared/i18n-core";
import { errorText } from "../../../shared/i18n-errors";
import { useI18n } from "../../../shared/i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import "./subscriptions.css";

type Item = { id: string; credential_id: string; display_name: string; email: string; protocol: string; status: string; user_disabled: boolean; admin_disabled: boolean; account_status: string; expires_at: string; last_fetched_at: string | null; total_bytes: string; synced_nodes: number };
type Api = <T>(path: string, init?: RequestInit) => Promise<T>;
const bytes = (value: string) => { const n = Number(value); return n >= 1073741824 ? `${(n/1073741824).toFixed(2)} GB` : `${(n/1048576).toFixed(1)} MB`; };

/** Console: every account's subscription, with access controls. Links are only ever shown to their owner, in the Portal. */
export function SubscriptionPanel({ api }: { api: Api }) {
  const { t, locale } = useI18n();
  const date = (value: string | null) => value ? formatDate(value, locale) : t("尚未拉取");
  const endpoint = "/api/v1/admin/subscriptions";
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState<LocalizedMessage>("");
  const [confirm, setConfirm] = useState<{ item: Item; action: string } | null>(null);
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
  async function action(item: Item, action: string) {
    setConfirm(null); setBusy(true); setError("");
    try {
      const result = await api<{ sync?: { status: string } }>(endpoint, { method: "PATCH", body: JSON.stringify({ id: item.id, action }) });
      setNotice(result.sync?.status === "failed" ? message("操作已保存，但节点权限同步失败，请到账号管理检查。") : message("操作已保存，节点权限将在同步后生效；离线节点需要恢复连接后同步。"));
      await refresh();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <section className="subscription-panel" aria-label={t("订阅管理")}>
    <div className="subscription-heading"><div><p className="subscription-kicker">{t("ONE IMPORT · ALL NODES")}</p><h2>{t("订阅管理")}</h2><p>{t("每个账号一份订阅，包含全部节点，可导入任意多个应用。按账号管理访问权限。")}</p></div><button disabled={busy} onClick={() => void refresh().catch((e: Error) => setError(e.message))}>{t("刷新状态")}</button></div>
    {error && <p className="subscription-error" role="alert">{errorText(error, t)}</p>}{notice && <p className="subscription-notice" role="status">{translateMessage(notice, t)}</p>}
    <div className="subscription-list">{items.map((item) => {
      const expired = new Date(item.expires_at).getTime() <= Date.now();
      const usable = item.status === "active" && !expired;
      const state = !usable ? (item.status === "revoked" ? t("已撤销") : t("已到期")) : item.account_status !== "active" ? t("账号已停用") : item.admin_disabled ? t("管理员停用") : item.user_disabled ? t("本人停用") : t("有效");
      return <article key={item.id}><div className="subscription-row"><div><h3>{item.display_name}</h3><small>{item.email} · {state}</small></div><b>{bytes(item.total_bytes)}<small>{t("近 30 天流量")}</small></b></div><p>{item.synced_nodes} {t("个节点已同步 · 到期")} {date(item.expires_at)}</p><small>{t("上次成功拉取：")}{date(item.last_fetched_at)}</small><div className="subscription-actions">
        {usable && <button disabled={busy} onClick={() => setConfirm({ item, action: item.admin_disabled ? "enable" : "disable" })}>{item.admin_disabled ? t("启用") : t("停用")}</button>}
        {item.status === "active" && <button className="subscription-danger" disabled={busy} onClick={() => setConfirm({ item, action: "revoke" })}>{t("撤销访问")}</button>}
        <button className="subscription-danger" disabled={busy} onClick={() => setConfirm({ item, action: "delete" })}>{t("删除")}</button>
      </div></article>;
    })}{!items.length && <p className="subscription-empty">{t("暂无订阅。用户第一次在门户导入时会自动生成。")}</p>}</div>
    {confirm && <div ref={dialogRef} className="subscription-confirm" role="alertdialog" aria-modal="true" aria-label={t("确认订阅操作")}><div><h3>{t("确认操作：")}{confirm.item.display_name}</h3><p>{["revoke", "delete"].includes(confirm.action) ? t("将撤销该订阅在各节点的访问权限，无法恢复原凭据。删除后保留审计和历史流量。") : t("将更新该订阅的节点访问权限。权限同步存在延迟，离线节点需恢复后才能生效。")}</p><div className="subscription-actions"><button onClick={() => setConfirm(null)}>{t("取消")}</button><button className="subscription-primary" onClick={() => void action(confirm.item,confirm.action)}>{t("确认")}</button></div></div></div>}
  </section>;
}
