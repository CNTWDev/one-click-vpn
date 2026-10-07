import { useI18n } from "../../shared/i18n";
import { errorText } from "../../shared/i18n-errors";
import { intlLocales } from "../../shared/i18n-core";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import QRCode from "qrcode";
import { apps, type AppId } from "./client-options";
import { dateLabel, protocolBadge, protocolLabel, relativeLabel } from "./format";

/* Small, dependency-free building blocks shared by the Portal views. */

const svg = (path: ReactNode, size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{path}</svg>;
export const Icon = {
  copy: (size?: number) => svg(<><rect x="9" y="9" width="11" height="11" rx="2.5" /><path d="M5 15V6a2 2 0 0 1 2-2h8" /></>, size),
  qr: (size?: number) => svg(<><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><path d="M14 14h2v2h-2zM18 18h2v2h-2zM14 18h2M18 14h2" /></>, size),
  download: (size?: number) => svg(<><path d="M12 4v11M7 10l5 5 5-5" /><path d="M5 19h14" /></>, size),
  dots: (size?: number) => svg(<><circle cx="5" cy="12" r="1.3" fill="currentColor" /><circle cx="12" cy="12" r="1.3" fill="currentColor" /><circle cx="19" cy="12" r="1.3" fill="currentColor" /></>, size),
  refresh: (size?: number) => svg(<><path d="M20 11a8 8 0 0 0-14.6-4.5L4 8" /><path d="M4 4v4h4" /><path d="M4 13a8 8 0 0 0 14.6 4.5L20 16" /><path d="M20 20v-4h-4" /></>, size),
  plus: (size?: number) => svg(<path d="M12 5v14M5 12h14" />, size),
  close: (size?: number) => svg(<path d="M6 6l12 12M18 6L6 18" />, size),
  check: (size?: number) => svg(<path d="M5 12.5l4.5 4.5L19 7.5" />, size),
  external: (size?: number) => svg(<><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></>, size),
};

export function AppIcon({ id }: { id: AppId }) {
  return <span className={`app-icon app-${id}`} aria-hidden="true">{apps[id].letter}</span>;
}

export function ProtocolBadge({ protocol, subscription = false }: { protocol: string; subscription?: boolean }) {
  const { t } = useI18n();
  // Same size and text for every connection; subscriptions only change the tint.
  return <span className={`proto-badge ${subscription ? "sub" : protocol}`} aria-label={subscription ? t("{0} 订阅", [protocolLabel(protocol)]) : protocolLabel(protocol)}>{protocolBadge(protocol)}</span>;
}

/** Relative time with the absolute zh-CN time on hover. */
export function Time({ value, fallback = "尚无记录", relative = true }: { value?: string | null; fallback?: string; relative?: boolean }) {
  const { t, locale } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(timer); }, []);
  if (!value) return <>{t(fallback)}</>;
  return <time dateTime={value} title={t(dateLabel(value, fallback, intlLocales[locale]))}>{t(relative ? relativeLabel(value, fallback, now, intlLocales[locale]) : dateLabel(value, fallback, intlLocales[locale]))}</time>;
}

export function InlineError({ message, onRetry, busy }: { message: string; onRetry?: () => void; busy?: boolean }) {
  const { t } = useI18n();
  return <div className="inline-error" role="alert"><span>{errorText(message, t)}</span>{onRetry && <button type="button" className="secondary small" disabled={busy} onClick={onRetry}>{t("重试")}</button>}</div>;
}

export const Skeleton = ({ height = 16, width = "100%" }: { height?: number; width?: number | string }) => <span className="skeleton" style={{ height, width }} aria-hidden="true" />;

export type Notify = (message: string, tone?: "success" | "error") => void;
/** Auto-dismissing toasts in the top-right corner; never push page content around. */
export function useToasts() {
  const { t } = useI18n();
  const [items, setItems] = useState<Array<{ id: number; message: string; tone: "success" | "error" }>>([]);
  const next = useRef(0);
  const dismiss = useCallback((id: number) => setItems((current) => current.filter((item) => item.id !== id)), []);
  const notify = useCallback<Notify>((message, tone = "success") => {
    const id = ++next.current;
    setItems((current) => [...current.slice(-2), { id, message, tone }]);
    window.setTimeout(() => dismiss(id), tone === "error" ? 8000 : 4500);
  }, [dismiss]);
  const toasts = <div className="toasts" aria-live="polite">{items.map((item) => <div key={item.id} className={`toast ${item.tone}`} role={item.tone === "error" ? "alert" : "status"}>
    <span className="toast-mark" aria-hidden="true">{item.tone === "error" ? "!" : Icon.check(14)}</span><span>{item.message}</span>
    <button type="button" aria-label={t("关闭提示")} onClick={() => dismiss(item.id)}>{Icon.close(16)}</button>
  </div>)}</div>;
  return { notify, toasts };
}

/** Native <dialog>: focus trapping, Escape and background inertness for free; becomes a bottom sheet on phones. */
export function Modal({ open, title, onClose, children, wide = false }: { open: boolean; title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return <dialog ref={ref} className={`modal ${wide ? "wide" : ""}`} aria-label={title} onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    {open && <div className="modal-body"><div className="modal-head"><h2>{title}</h2><button type="button" className="icon-button" aria-label={t("关闭")} onClick={onClose}>{Icon.close()}</button></div>{children}</div>}
  </dialog>;
}

export function QrCode({ text, label }: { text: string; label: string }) {
  const { t } = useI18n();
  const [image, setImage] = useState<{ text: string; src: string } | null>(null);
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(text, { margin: 1, width: 560, errorCorrectionLevel: "M" }).then((src) => { if (live) setImage({ text, src }); }).catch(() => { if (live) setImage({ text, src: "" }); });
    return () => { live = false; };
  }, [text]);
  if (image?.text !== text) return <span className="qr-frame"><Skeleton height={232} width={232} /></span>;
  // eslint-disable-next-line @next/next/no-img-element -- Vite app, data: URL generated locally
  return <span className="qr-frame">{image.src ? <img src={image.src} alt={label} width={232} height={232} /> : <small>{t("内容过长，无法生成二维码，请复制链接。")}</small>}</span>;
}

export type MenuItem = { label: string; onSelect: () => void; danger?: boolean; disabled?: boolean } | "-" | false | null | undefined;
/** One "⋯" button that collects all secondary management actions. */
export function Menu({ items, label = "更多操作", text, plain = false }: { items: MenuItem[]; label?: string; text?: string; plain?: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const entries = () => [...(root.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)") || [])];
    entries()[0]?.focus();
    const onPointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); root.current?.querySelector<HTMLButtonElement>(".menu-trigger")?.focus(); }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const list = entries(), index = list.indexOf(document.activeElement as HTMLButtonElement);
        list[(index + (event.key === "ArrowDown" ? 1 : list.length - 1)) % list.length]?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onPointer); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return <div className="menu" ref={root}>
    <button type="button" className={text ? "ghost small menu-trigger" : `icon-button menu-trigger ${plain ? "" : "bordered"}`} aria-haspopup="menu" aria-expanded={open} aria-label={t(label)} title={t(label)} onClick={() => setOpen(!open)}>{text ? <>{text}{Icon.dots(16)}</> : Icon.dots(20)}</button>
    {open && <div className="menu-list" role="menu" aria-label={label}>{items.filter(Boolean).map((item, index) => item && item !== "-"
      ? <button key={item.label} type="button" role="menuitem" className={item.danger ? "danger-item" : ""} disabled={item.disabled} onClick={() => { setOpen(false); item.onSelect(); }}>{item.label}</button>
      : <hr key={`separator-${index}`} />)}</div>}
  </div>;
}
