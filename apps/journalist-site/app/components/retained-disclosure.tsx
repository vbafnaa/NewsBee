"use client";

import { useEffect, useState, type ReactNode } from "react";

export default function RetainedDisclosure({ title, children, className, id, revealKey }: {
  title: string; children: ReactNode; className?: string; id?: string; revealKey?: string;
}) {
  const [visited, setVisited] = useState(Boolean(revealKey));
  const [open, setOpen] = useState(Boolean(revealKey));
  useEffect(() => {
    if (revealKey) { setOpen(true); setVisited(true); }
  }, [revealKey]);
  return <details id={id} className={className} open={open} onToggle={(event) => {
    const expanded = event.currentTarget.open;
    setOpen(expanded);
    if (expanded) setVisited(true);
  }}>
    <summary>{title}</summary>
    {visited && <div hidden={!open} inert={!open}>{children}</div>}
  </details>;
}
