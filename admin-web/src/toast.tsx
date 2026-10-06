import { t, useConsoleLanguage } from "./i18n";
import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from "react";

type Toast = { id: number; tone: "success" | "error" | "info"; message: string };
type ToastFn = (message: string, tone?: Toast["tone"]) => void;
const ToastContext = createContext<ToastFn | null>(null);

/** Top-right, auto-dismissing confirmations so success messages never push page content down. */
export function ToastProvider({ children }: { children: ReactNode }) {
  useConsoleLanguage();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setToasts((items) => items.filter((item) => item.id !== id)), []);
  const show = useCallback<ToastFn>((message, tone = "success") => {
    const id = next.current++;
    setToasts((items) => [...items.slice(-3), { id, tone, message }]);
    window.setTimeout(() => dismiss(id), tone === "error" ? 7000 : 4000);
  }, [dismiss]);
  return <ToastContext.Provider value={show}>
    {children}
    <div className="toast-stack" aria-live="polite">{toasts.map((toast) => <div key={toast.id} className={`toast ${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"}>
      <span>{toast.message}</span><button type="button" aria-label={t("关闭提示")} onClick={() => dismiss(toast.id)}>×</button>
    </div>)}</div>
  </ToastContext.Provider>;
}

export function useToast(): ToastFn {
  useConsoleLanguage();
  const toast = useContext(ToastContext);
  if (!toast) throw new Error("useToast must be used inside <ToastProvider>");
  return toast;
}
