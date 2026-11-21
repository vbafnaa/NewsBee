"use client";

import Link, { useLinkStatus } from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useNewsroomPath, useNewsroomTask } from "./newsroom-tasks";
import { NEWSROOM_TASK_LABELS, newsroomHref, type NewsroomTask, type NewsroomView } from "./newsroom-routes";
import { Icon, type IconName } from "./newsroom-ui";
import type { NewsroomPublication } from "./newsroom-shell";

type NavItem = { view: NewsroomView; label: string; icon: IconName; current: NewsroomTask[]; badge?: string };
type Role = "owner" | "admin" | "editor";

/**
 * The sidebar, in the order the user set: Workspace, Create, Current and Admin. Everyone sees Admin's one item,
 * Newsroom admin, a read-only status page whose links into Operations are locked for people who can't open them.
 * Inbox opens from the bell, and Settings is in the user card's menu.
 */
export const NEWSROOM_NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  { label: "Workspace", items: [
    { view: "overview", label: "Overview", icon: "overview", current: ["overview"] },
  ] },
  { label: "Create", items: [
    { view: "collect-sources", label: "New source map", icon: "map", current: ["collect-sources"] },
    { view: "new-edition", label: "New edition", icon: "sparkle", current: ["new-edition"], badge: "KEY" },
    { view: "new-video", label: "New video", icon: "video", current: ["new-video"] },
  ] },
  { label: "Current", items: [
    { view: "source-map", label: "Source map", icon: "map", current: ["source-map"] },
    { view: "editions", label: "Editions", icon: "edition", current: ["editions", "activity", "writing"] },
    { view: "videos", label: "Videos", icon: "video", current: ["videos"] },
    { view: "analytics", label: "Analytics", icon: "chart", current: ["analytics"] },
  ] },
  { label: "Admin", items: [
    { view: "admin", label: "Newsroom admin", icon: "settings", current: ["admin"] },
  ] },
];

/** Marks a sidebar link while its navigation is pending, so a click is visibly taken. */
function PendingMark() {
  const { pending } = useLinkStatus();
  return <span className={`jw-nav-pending${pending ? " is-pending" : ""}`} aria-hidden="true" />;
}

/** `role` stays in the signature for the shell; Newsroom admin itself locks what a role can't open. */
export function NewsroomSideNav({ publicationId }: { publicationId: string; role?: Role }) {
  const task = useNewsroomTask();
  const pathname = useNewsroomPath();
  // The item someone just clicked shows as active at once, before the next page has loaded.
  const [clicked, setClicked] = useState<{ href: string; from: string | null } | null>(null);
  const pending = clicked && clicked.from === pathname ? clicked.href : null;
  return <nav className="jw-nav" aria-label="Newsroom navigation">
    {NEWSROOM_NAV_GROUPS.map((group) => <div className="jw-nav-group" key={group.label}>
      <p className="jw-nav-label">{group.label}</p>
      {group.items.map((item) => {
        const href = newsroomHref(publicationId, item.view);
        const current = pending ? pending === href : item.current.includes(task);
        return <Link key={item.view} href={href} onClick={() => setClicked({ href, from: pathname })}
          className={`jw-nav-link${current ? " active" : ""}`} aria-current={current ? "page" : undefined}>
          <Icon name={item.icon} /><span>{item.label}</span>{item.badge && <span className="jw-key" aria-hidden="true">{item.badge}</span>}<PendingMark />
        </Link>;
      })}
    </div>)}
  </nav>;
}

/**
 * The ⋯ account menu and Help are plain <details> popovers. A client-side navigation doesn't reload
 * the page, so without this an open one stays open, and the account menu's panel sits over the
 * lower sidebar items. Close them on every route change, on a click outside, and on Escape.
 */
export function NewsroomMenus() {
  const pathname = useNewsroomPath();
  useEffect(() => {
    for (const menu of document.querySelectorAll(".jw details[open]")) menu.removeAttribute("open");
  }, [pathname]);
  useEffect(() => {
    const closeOthers = (keep: EventTarget | null) => {
      for (const menu of document.querySelectorAll(".jw details[open]")) {
        if (!(keep && menu.contains(keep as Node))) menu.removeAttribute("open");
      }
    };
    const onPointer = (event: PointerEvent) => closeOthers(event.target);
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") closeOthers(null); };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, []);
  return null;
}

export function NewsroomTopbarTitle() {
  const task = useNewsroomTask();
  return <span className="jw-topbar-page">{NEWSROOM_TASK_LABELS[task]}</span>;
}

/** Picks the newsroom. Moving keeps the same view, except an open edition, which belongs to one newsroom. */
export function NewsroomSwitcher({ publications, publicationId }: { publications: NewsroomPublication[]; publicationId?: string }) {
  const router = useRouter();
  const task = useNewsroomTask();
  const choices = publications.filter((publication) => publication.archivedAt == null || publication.id === publicationId);
  const current = choices.find((publication) => publication.id === publicationId);
  // Moving newsroom keeps the view, except things that belong to one newsroom's edition.
  const view: NewsroomView = !publicationId ? "overview" : task === "writing" || task === "activity" ? "editions" : task;
  return <form className="jw-switcher" action="/newsroom" method="get" onSubmit={(event) => {
    event.preventDefault();
    const id = new FormData(event.currentTarget).get("publicationId");
    // Keep the query (e.g. ?generation=), as the older newsroom picker did; a community or run belongs to the old coverage.
    const query = new URLSearchParams(window.location.search);
    for (const key of ["location", "run"]) query.delete(key);
    if (typeof id === "string" && id) router.push(newsroomHref(id, view, query.size ? `?${query}` : ""));
  }}>
    <label htmlFor="newsroom-publication" className="jw-nav-label">Newsroom workspace</label>
    {/* The full name wraps in view; the native select sits over it, so long names are never cut off. */}
    <div className="jw-switcher-control" title={current?.name}>
      <span className="jw-switcher-mark" aria-hidden="true">{(current?.name ?? "N").trim().charAt(0).toUpperCase()}</span>
      <span className="jw-switcher-name" aria-hidden="true">{current?.name ?? "Choose a newsroom"}</span>
      <select id="newsroom-publication" name="publicationId" required defaultValue={publicationId ?? ""}
        onChange={(event) => event.currentTarget.form?.requestSubmit()}>
        <option value="" disabled>Choose a newsroom</option>
        {choices.map((publication) => <option value={publication.id} key={publication.id} disabled={publication.archivedAt != null}>
          {publication.name}{publication.archivedAt != null ? " · Archived" : publication.accessMode === "inspection" ? " · Inspect" : ""}
        </option>)}
      </select>
      <Icon name="chevron" size={16} />
    </div>
    <input type="hidden" name="task" value={view} />
    <noscript><button className="secondary" type="submit">Open</button></noscript>
  </form>;
}
