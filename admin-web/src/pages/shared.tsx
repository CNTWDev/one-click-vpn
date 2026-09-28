import { type ReactNode, useEffect } from "react";

export type Notice = { tone: "success" | "error" | "info"; message: string };

export function formatTime(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function formatBytes(value?: number): string {
  if (!value || value < 1) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const power = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** power).toFixed(power > 1 ? 1 : 0)} ${units[power]}`;
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: ReactNode }) {
  return <div className="page-head">
    <div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>
    {actions && <div className="page-actions">{actions}</div>}
  </div>;
}

export function Pill({ value }: { value: string }) {
  const label = ({ active: "有效", issued: "已签发", pending: "待处理", healthy: "正常", succeeded: "成功", failed: "失败", suspended: "已停用", rejected: "已拒绝", "never-connected": "尚未连接", "telemetry-delayed": "状态未知", disabled: "已停用", "admin-disabled": "管理员已停用", "account-disabled": "账号已停用", online: "在线", offline: "离线", revoked: "已撤销", expired: "已过期" } as Record<string, string>)[value] || value;
  return <span className={`pill ${value.toLowerCase().replaceAll("_", "-")}`}>{label}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Modal({ title, description, onClose, children, wide = false }: { title: string; description?: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener("keydown", closeOnEscape); };
  }, [onClose]);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal-head"><div><h2>{title}</h2>{description && <p>{description}</p>}</div><button className="icon-button" onClick={onClose} aria-label="关闭">×</button></div>
      {children}
    </section>
  </div>;
}

export function InlineNotice({ notice }: { notice: Notice | null }) {
  return notice ? <div className={`inline-notice ${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>{notice.message}</div> : null;
}
