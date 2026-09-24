import { useEffect, useRef, useState } from "react";

type Request = { title: string; description: string; confirmLabel: string; danger?: boolean; initialValue?: string };

/** Native dialog provides focus trapping, Escape and background inertness. */
export function useActionDialog() {
  const [request, setRequest] = useState<Request | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const resolver = useRef<((value: string | null) => void) | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!request) return;
    dialogRef.current?.showModal();
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
  function ask(options: Request): Promise<string | null> {
    resolver.current?.(null);
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setRequest(options);
    return new Promise((resolve) => { resolver.current = resolve; });
  }
  const dialog = request && <dialog ref={dialogRef} className="action-dialog" aria-labelledby="action-title" aria-describedby="action-description" onCancel={(event) => { event.preventDefault(); finish(null); }}>
    <form onSubmit={(event) => {
      event.preventDefault();
      const value = request.initialValue === undefined ? "confirmed" : String(new FormData(event.currentTarget).get("name") || "").trim();
      if (value) finish(value);
    }}>
      <span className={`dialog-kicker ${request.danger ? "danger" : ""}`}>{request.danger ? "请确认操作影响" : "连接管理"}</span>
      <h2 id="action-title">{request.title}</h2>
      <p id="action-description">{request.description}</p>
      {request.initialValue !== undefined && <label>连接名称<input name="name" required pattern={".*\\S.*"} defaultValue={request.initialValue} autoFocus /></label>}
      <div className="dialog-actions"><button type="button" className="secondary" autoFocus={request.initialValue === undefined} onClick={() => finish(null)}>取消</button><button className={request.danger ? "danger-link" : "primary"} type="submit">{request.confirmLabel}</button></div>
    </form>
  </dialog>;
  return { ask, dialog };
}
