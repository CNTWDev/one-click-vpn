import { consoleLanguage, t, useConsoleLanguage } from "../i18n";
import { intlLocales } from "../../../shared/i18n-core";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useConfirm } from "../confirm-dialog";
import { Icon } from "../icons";
import { statusLabel, statusTone, type Tone } from "../status";

export type Notice = { tone: "success" | "error" | "info"; message: string };

const currentLocale = () => intlLocales[consoleLanguage.locale()];
const parse = (value?: string | null) => { if (!value) return null; const date = new Date(value); return Number.isNaN(date.getTime()) ? null : date; };

/** Display locale never changes the timestamp sent to the API. */
export function formatTime(value?: string | null): string {
  if (!value) return "—";
  const date = parse(value);
  return date ? new Intl.DateTimeFormat(currentLocale(), { dateStyle: "medium", timeStyle: "medium" }).format(date) : value;
}

/** Intl handles word order and plural forms, including Russian. */
export function relativeTime(value?: string | null, now = Date.now()): string {
  const date = parse(value);
  if (!date) return value || "—";
  const seconds = Math.round((date.getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return t("刚刚");
  if (abs >= 86400 * 30) return new Intl.DateTimeFormat(currentLocale(), { dateStyle: "medium" }).format(date);
  const unit = abs < 3600 ? "minute" : abs < 86400 ? "hour" : "day";
  const divisor = unit === "minute" ? 60 : unit === "hour" ? 3600 : 86400;
  return new Intl.RelativeTimeFormat(currentLocale(), { numeric: "auto" }).format(Math.round(seconds / divisor), unit);
}

/** Relative time in lists, with the full time on hover. */
export function Time({ value, prefix = "" }: { value?: string | null; prefix?: string }) {
  useConsoleLanguage();
  if (!value) return <span className="muted">—</span>;
  return <time dateTime={value} title={formatTime(value)}>{prefix}{relativeTime(value)}</time>;
}

export function formatBytes(value?: number): string {
  if (!value || value < 1) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const power = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${consoleLanguage.number(value / 1024 ** power, { maximumFractionDigits: power > 1 ? 1 : 0 })} ${units[power]}`;
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  useConsoleLanguage();
  return <div className="page-head">
    <div className="page-title"><h1>{title}</h1>{description && <p>{description}</p>}</div>
    {actions && <div className="page-actions">{actions}</div>}
  </div>;
}

export function Pill({ value, label, tone }: { value: string; label?: string; tone?: Tone }) {
  useConsoleLanguage();
  return <span className={`pill tone-${tone || statusTone(value)}`}>{label || statusLabel(value)}</span>;
}

export function StateDot({ value, tone }: { value?: string; tone?: Tone }) {
  useConsoleLanguage();
  return <i className={`state-dot tone-${tone || statusTone(value)}`} aria-hidden="true" />;
}

export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  useConsoleLanguage();
  return <div className="empty"><p>{children}</p>{action}</div>;
}

/** Usage bar with threshold colours (green < 70%, amber < 90%, red above). */
export function Meter({ label, value }: { label: string; value: number }) {
  useConsoleLanguage();
  const percent = Math.max(0, Math.min(100, Math.round(value)));
  const tone = percent >= 90 ? "danger" : percent >= 70 ? "warning" : "success";
  return <span className={`meter tone-${tone}`} title={`${label} ${percent}%`}><small>{label}</small><i><b style={{ width: `${percent}%` }} /></i><em>{percent}%</em></span>;
}

export function Modal({ title, description, onClose, children, footer, wide = false, dirty = false }: { title: string; description?: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean; dirty?: boolean }) {
  useConsoleLanguage();
  const confirm = useConfirm();
  const dirtyRef = useRef(dirty);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);
  // Closing a form with unsaved input (Esc, backdrop or ×) asks first so typed SSH credentials are not lost.
  const requestClose = useCallback(async () => {
    if (dirtyRef.current && !await confirm({ title: t("放弃未保存的修改？"), message: t("表单中已填写的内容尚未保存，关闭后将丢失。"), confirmLabel: t("放弃修改"), danger: true })) return;
    onClose();
  }, [confirm, onClose]);
  useEffect(() => {
    // preventDefault stops the same Escape press from also cancelling the confirm dialog it may open.
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); void requestClose(); } };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener("keydown", closeOnEscape); };
  }, [requestClose]);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) void requestClose(); }}>
    <section className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal-head"><div><h2>{title}</h2>{description && <p>{description}</p>}</div><button className="icon-button" onClick={() => void requestClose()} aria-label={t("关闭")}><Icon name="close" /></button></div>
      <div className="modal-body">{children}</div>
      {footer && <div className="modal-foot">{footer}</div>}
    </section>
  </div>;
}

export function InlineNotice({ notice, onRetry }: { notice: Notice | null; onRetry?: () => void }) {
  useConsoleLanguage();
  return notice ? <div className={`inline-notice ${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}><span>{notice.message}</span>{onRetry && <button className="text-button" onClick={onRetry}>{t("重试")}</button>}</div> : null;
}

export type MenuItem = { label: string; onSelect: () => void; danger?: boolean; disabled?: boolean; hint?: string } | "divider";

/** A small dropdown opened from "⋯" (or any trigger); positioned fixed so table scrolling never clips it. */
export function Menu({ items, trigger, triggerClassName = "more-button", label = t("更多操作"), header }: { items: MenuItem[]; trigger?: ReactNode; triggerClassName?: string; label?: string; header?: ReactNode }) {
  useConsoleLanguage();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open || !buttonRef.current || !menuRef.current) return;
    const anchor = buttonRef.current.getBoundingClientRect();
    const box = menuRef.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.right - box.width, window.innerWidth - box.width - 8));
    const below = anchor.bottom + 6;
    const top = below + box.height > window.innerHeight - 8 && anchor.top - box.height - 6 > 8 ? anchor.top - box.height - 6 : below;
    setPosition({ top, left });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const outside = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node) && !buttonRef.current?.contains(event.target as Node)) close(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); close(); buttonRef.current?.focus(); } };
    const scroll = (event: Event) => { if (!menuRef.current?.contains(event.target as Node)) close(); };
    document.addEventListener("mousedown", outside);
    window.addEventListener("keydown", escape, true);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", close);
    return () => { document.removeEventListener("mousedown", outside); window.removeEventListener("keydown", escape, true); window.removeEventListener("scroll", scroll, true); window.removeEventListener("resize", close); };
  }, [open]);
  return <>
    <button ref={buttonRef} type="button" className={triggerClassName} aria-haspopup="menu" aria-expanded={open} aria-label={trigger ? undefined : label} title={trigger ? undefined : label} onClick={() => { setPosition(null); setOpen((value) => !value); }}>{trigger || <Icon name="more" />}</button>
    {open && <div ref={menuRef} className="menu" role="menu" style={position ? { top: position.top, left: position.left } : { top: -9999, left: -9999 }}>
      {header && <div className="menu-header">{header}</div>}
      {items.map((item, index) => item === "divider" ? <hr key={`divider-${index}`} /> : <button key={item.label} type="button" role="menuitem" className={item.danger ? "danger" : ""} disabled={item.disabled} onClick={() => { setOpen(false); item.onSelect(); }}><span>{item.label}</span>{item.hint && <small>{item.hint}</small>}</button>)}
    </div>}
  </>;
}

export type Chip = { value: string; label: string; count?: number };

/** Shared table toolbar: search, filter chips with counts, sort. State lives in the URL query (see router). */
export function TableToolbar({ search, onSearch, placeholder, chips, chip, onChip, sort, sortOptions, onSort, children }: {
  search: string; onSearch: (value: string) => void; placeholder: string; chips?: Chip[]; chip?: string; onChip?: (value: string) => void;
  sort?: string; sortOptions?: Array<[value: string, label: string]>; onSort?: (value: string) => void; children?: ReactNode;
}) {
  useConsoleLanguage();
  return <div className="table-toolbar">
    <label className="search-field"><Icon name="search" size={16} /><input type="search" value={search} onChange={(event) => onSearch(event.target.value)} placeholder={placeholder} aria-label={placeholder} />{search && <button type="button" aria-label={t("清除搜索")} onClick={() => onSearch("")}><Icon name="close" size={14} /></button>}</label>
    {chips && <div className="chips" role="group" aria-label={t("筛选")}>{chips.map((item) => <button key={item.value} type="button" className={chip === item.value ? "active" : ""} aria-pressed={chip === item.value} onClick={() => onChip?.(item.value)}>{item.label}{item.count !== undefined && <em>{item.count}</em>}</button>)}</div>}
    <span className="grow" />
    {children}
    {sortOptions && <label className="sort-field"><span>{t("排序")}</span><select value={sort} onChange={(event) => onSort?.(event.target.value)}>{sortOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
  </div>;
}

/** Fixed-to-bottom on phones; shows the selection count, actions, and a clear button. */
export function BatchBar({ count, unit, onClear, children }: { count: number; unit: string; onClear: () => void; children: ReactNode }) {
  useConsoleLanguage();
  if (!count) return null;
  return <div className="batch-bar" role="region" aria-label={t("批量操作")}><div className="batch-count"><b>{t("已选择")} {count} {unit}</b><button className="text-button" onClick={onClear}>{t("取消选择")}</button></div><span>{children}</span></div>;
}

export const includesText = (query: string, ...values: Array<string | null | undefined>) => {
  const needle = query.trim().toLowerCase();
  return !needle || values.some((value) => value?.toLowerCase().includes(needle));
};
