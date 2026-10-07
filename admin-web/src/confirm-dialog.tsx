import { t, useConsoleLanguage } from "./i18n";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

export type ConfirmInput = { label: string; placeholder?: string; required?: boolean };
/** confirmText: irreversible actions require typing this exact text (e.g. the node name) before the button enables. */
export type ConfirmOptions = { title: string; message: string; confirmLabel?: string; danger?: boolean; input?: ConfirmInput; confirmText?: string };

type ConfirmFn = {
  (options: ConfirmOptions & { input: ConfirmInput }): Promise<string | null>;
  (options: ConfirmOptions & { input?: undefined }): Promise<boolean>;
};

const ConfirmContext = createContext<ConfirmFn | null>(null);

/** Native <dialog> provides focus trapping, Escape handling and background inertness. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  useConsoleLanguage();
  const [request, setRequest] = useState<ConfirmOptions | null>(null);
  const [typed, setTyped] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const resolver = useRef<((value: string | null) => void) | null>(null);
  const trigger = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!request) return;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [request]);
  useEffect(() => () => { resolver.current?.(null); }, []);

  function finish(value: string | null) {
    dialogRef.current?.close();
    resolver.current?.(value);
    resolver.current = null;
    setRequest(null);
    trigger.current?.focus();
  }

  const ask = useCallback((options: ConfirmOptions): Promise<string | null> => {
    resolver.current?.(null);
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setTyped(""); setRequest(options);
    return new Promise((resolve) => { resolver.current = resolve; });
  }, []);

  const confirm = useMemo(() => ((options: ConfirmOptions) => ask(options).then((value) => (
    options.input ? value : value !== null
  ))) as ConfirmFn, [ask]);

  return <ConfirmContext.Provider value={confirm}>
    {children}
    {request && <dialog
      ref={dialogRef}
      className={`confirm-dialog ${request.danger ? "danger" : ""}`}
      aria-labelledby="confirm-dialog-title"
      aria-describedby="confirm-dialog-message"
      onCancel={(event) => { event.preventDefault(); finish(null); }}
      onKeyDown={(event) => {
        // Keep Escape from also reaching window listeners (e.g. an underlying Modal).
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(null); }
      }}
    >
      <form onSubmit={(event) => {
        event.preventDefault();
        if (request.confirmText !== undefined) { if (typed.trim() === request.confirmText) finish("confirmed"); return; }
        if (!request.input) { finish("confirmed"); return; }
        const value = String(new FormData(event.currentTarget).get("value") ?? "");
        if (request.input.required && !value.trim()) return;
        finish(value);
      }}>
        <p className="eyebrow">{request.danger ? t("危险操作") : t("操作确认")}</p>
        <h2 id="confirm-dialog-title">{request.title}</h2>
        <p id="confirm-dialog-message">{request.message}</p>
        {request.confirmText !== undefined && <label>
          <span>{t("请输入")} <code>{request.confirmText}</code> {t("以确认")}</span>
          <input name="confirm-text" value={typed} onChange={(event) => setTyped(event.target.value)} placeholder={request.confirmText} autoComplete="off" spellCheck={false} autoFocus />
        </label>}
        {request.input && <label>
          {request.input.label}
          <input
            name="value"
            required={request.input.required}
            pattern={request.input.required ? ".*\\S.*" : undefined}
            placeholder={request.input.placeholder}
            autoComplete="off"
            autoFocus
          />
        </label>}
        <div className="form-actions">
          <button type="button" className="button ghost" autoFocus={!request.input && request.confirmText === undefined} onClick={() => finish(null)}>{t("取消")}</button>
          <button type="submit" className={`button ${request.danger ? "danger solid" : "primary"}`} disabled={request.confirmText !== undefined && typed.trim() !== request.confirmText}>{request.confirmLabel || t("确认")}</button>
        </div>
      </form>
    </dialog>}
  </ConfirmContext.Provider>;
}

export function useConfirm(): ConfirmFn {
  useConsoleLanguage();
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error("useConfirm must be used inside <ConfirmProvider>");
  return confirm;
}
