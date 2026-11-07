"use client";

import { useId, useState, type ButtonHTMLAttributes } from "react";

export default function ExplainedButton({ disabledReason, children, ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "disabled"> & { disabledReason?: string | null }) {
  const id = useId();
  const [dismissed, setDismissed] = useState(false);
  if (!disabledReason) return <button {...props}>{children}</button>;
  return <span className="explained-action" tabIndex={0} role="group"
    aria-label={`${typeof children === "string" ? children : "Action"} unavailable`} aria-describedby={id}
    onKeyDown={(event) => { if (event.key === "Escape") setDismissed(true); }}
    onBlur={() => setDismissed(false)} onMouseLeave={() => setDismissed(false)}>
    <button {...props} disabled aria-describedby={id}>{children}</button>
    <span id={id} role="tooltip" className="action-explanation" data-dismissed={dismissed}>{disabledReason}</span>
  </span>;
}
