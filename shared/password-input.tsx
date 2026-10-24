import { type InputHTMLAttributes, useState } from "react";
import "./password-input.css";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { showLabel: string; hideLabel: string };

/** Password field that starts masked; the eye button reveals the typed text. Shared by Portal and Console. */
export function PasswordInput({ showLabel, hideLabel, className, ...props }: Props) {
  const [visible, setVisible] = useState(false);
  const label = visible ? hideLabel : showLabel;
  return <span className={`password-input${className ? ` ${className}` : ""}`}>
    <input {...props} className="password-field" type={visible ? "text" : "password"} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
    <button type="button" className="password-toggle" aria-label={label} title={label} aria-pressed={visible}
      onMouseDown={(event) => event.preventDefault()} onClick={() => setVisible(!visible)}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {visible
          ? <path d="M9.9 4.2A10 10 0 0 1 12 4c6.4 0 10 8 10 8a17 17 0 0 1-2.2 3.3M6.6 6.6C3.7 8.6 2 12 2 12s3.6 8 10 8a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2M2 2l20 20" />
          : <path d="M2 12s3.6-8 10-8 10 8 10 8-3.6 8-10 8S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />}
      </svg>
    </button>
  </span>;
}
