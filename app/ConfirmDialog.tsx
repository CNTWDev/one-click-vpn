"use client";

type ConfirmDialogProps = {
  open: boolean;
  eyebrow?: string;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "warning" | "danger";
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({
  open,
  eyebrow = "CONFIRM ACTION",
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "warning",
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  if (!open) return null;

  return (
    <div className="modal-layer" role="presentation" onMouseDown={() => !busy && onCancel()}>
      <section className="modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-description" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div><p>{eyebrow}</p><h2 id="confirm-title">{title}</h2></div>
          <button type="button" onClick={onCancel} disabled={busy} aria-label="Close confirmation">×</button>
        </div>
        <div className="confirm-body">
          <p id="confirm-description">{description}</p>
        </div>
        <div className="modal-actions confirm-actions">
          <button type="button" className="cancel" onClick={onCancel} disabled={busy}>{cancelLabel}</button>
          <button type="button" className={tone === "danger" ? "danger-button" : "warning-button"} onClick={onConfirm} disabled={busy}>{busy ? "Working…" : confirmLabel}</button>
        </div>
      </section>
    </div>
  );
}
