// Small presentational pieces shared by the journalist workspace views. No hooks, so both
// server pages and client views can use them.
import type { ReactNode } from "react";

const ICONS = {
  overview: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z",
  edition: "M7 3h7l4 4v14H7zM14 3v4h4M10 12h5M10 16h5",
  video: "M4 6h11v12H4zM15 10l5-3v10l-5-3",
  settings: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  bell: "M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0",
  community: "M12 21s-7-6.2-7-11a7 7 0 1 1 14 0c0 4.8-7 11-7 11zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
  draft: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4",
  arrow: "M5 12h14M13 6l6 6-6 6",
  check: "M5 12l5 5L20 7",
  alert: "M12 3l10 18H2zM12 10v5M12 18h.01",
  chevron: "M6 9l6 6 6-6",
  chevronRight: "M9 6l6 6-6 6",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4",
  plus: "M12 5v14M5 12h14",
  external: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
  help: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17h.01",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  close: "M6 6l12 12M18 6L6 18",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
  operations: "M4 6h16M4 12h16M4 18h10",
  inbox: "M4 13l2.5-7h11L20 13v5H4zM4 13h5l1 2h4l1-2h5",
  map: "M9 4L3 6v14l6-2 6 2 6-2V4l-6 2zM9 4v14M15 6v14",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  play: "M4 5h16v14H4zM10 9v6l5-3z",
  storage: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  transfer: "M4 8h14l-4-4M20 16H6l4 4",
  code: "M9 8l-4 4 4 4M15 8l4 4-4 4M13 6l-2 12",
  lock: "M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3",
  users: "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21v-1a6 6 0 0 1 12 0v1M16 3.5a4 4 0 0 1 0 7.5M22 21v-1a6 6 0 0 0-4-5.6",
  image: "M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9h.01",
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return <svg className="jw-icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false"
    fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d={ICONS[name]} />
  </svg>;
}

export function PageHeader({ eyebrow, title, titleId = "workspace-title", description, actions, children }: {
  eyebrow?: ReactNode; title: ReactNode; titleId?: string; description?: ReactNode; actions?: ReactNode; children?: ReactNode;
}) {
  return <header className="jw-page-header">
    <div className="jw-page-heading">
      {eyebrow && <p className="jw-eyebrow">{eyebrow}</p>}
      <h1 id={titleId} tabIndex={-1}>{title}</h1>
      {description && <p className="jw-page-description">{description}</p>}
      {children}
    </div>
    {actions && <div className="jw-page-actions">{actions}</div>}
  </header>;
}

export type EditionStatus = "editing" | "ready_for_approval" | "approved" | "publishing" | "published";
export type EditionStatusKey = EditionStatus | "withdrawn" | "correction";

export const EDITION_STATUS_LABELS: Record<EditionStatusKey, string> = {
  editing: "Draft",
  ready_for_approval: "Ready for approval",
  approved: "Approved",
  publishing: "Publishing",
  published: "Published",
  withdrawn: "Withdrawn",
  correction: "Correction",
};

const EDITION_STATUS_TONES: Record<EditionStatusKey, string> = {
  editing: "draft",
  ready_for_approval: "review",
  approved: "approved",
  publishing: "running",
  published: "ok",
  withdrawn: "muted",
  correction: "warning",
};

/** The one status a list shows for an edition: withdrawn and correction win over the workflow stage. */
export function editionStatusKey(status: string, options: { withdrawn?: boolean; correction?: boolean } = {}): EditionStatusKey {
  if (options.withdrawn) return "withdrawn";
  if (options.correction && status !== "published") return "correction";
  return status in EDITION_STATUS_LABELS ? status as EditionStatus : "editing";
}

export function StatusPill({ status, children }: { status: EditionStatusKey | "running" | "failed" | "ok" | "muted" | "warning"; children?: ReactNode }) {
  const tone = status in EDITION_STATUS_TONES ? EDITION_STATUS_TONES[status as EditionStatusKey] : status;
  return <span className={`jw-pill jw-pill-${tone}`}>{children ?? EDITION_STATUS_LABELS[status as EditionStatusKey]}</span>;
}

export function StatCard({ label, value, detail, icon, tag }: { label: string; value: ReactNode; detail?: ReactNode; icon: IconName; tag?: ReactNode }) {
  return <article className="jw-card jw-stat">
    <div className="jw-stat-head"><p className="jw-eyebrow">{label}{tag}</p><span className="jw-stat-icon"><Icon name={icon} /></span></div>
    <p className="jw-stat-value">{value}</p>
    {detail && <p className="jw-stat-detail">{detail}</p>}
  </article>;
}

export function formatEditionWindow(window: [string, string] | string[]) {
  const [start, end] = window.map((day) => new Date(`${day}T00:00:00Z`));
  if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return window.join(" – ");
  const month = (date: Date) => date.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  const day = (date: Date) => date.getUTCDate();
  return start.getUTCMonth() === end.getUTCMonth()
    ? `${month(start)} ${day(start)}–${day(end)}`
    : `${month(start)} ${day(start)}–${month(end)} ${day(end)}`;
}

export function formatDate(seconds: number | null | undefined) {
  if (!seconds) return "—";
  return new Date(seconds * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
