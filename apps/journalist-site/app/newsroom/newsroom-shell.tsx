import Link from "next/link";
import type { ReactNode } from "react";
import { signOut } from "@/auth";
import type { Principal } from "@/pipeline/accounts/identity";
import { NewsroomTasks } from "./newsroom-tasks";
import { NewsroomMenus, NewsroomSideNav, NewsroomSwitcher, NewsroomTopbarTitle } from "./newsroom-navigation";
import { newsroomBase, newsroomHref } from "./newsroom-routes";
import { Icon } from "./newsroom-ui";
import "./newsroom.css";

export type NewsroomPublication = { id: string; name: string; accessMode?: "direct" | "inspection"; archivedAt?: number | null };

const ROLE_LABELS: Record<Principal["role"], string> = { editor: "Location journalist", admin: "Admin", owner: "Owner" };

/**
 * The journalist workspace frame: newsroom switcher, journalist navigation, user card, and a quiet
 * top bar. Owners and admins see the same frame plus one link back to Operations.
 */
export default function NewsroomShell({
  email,
  name,
  role,
  publications,
  publicationId,
  publicationName,
  inboxWaiting = 0,
  paused = false,
  support = null,
  children,
}: {
  email: string;
  /** From principalDisplayName; the email stands in when absent. */
  name?: { full: string; initials: string };
  role: Principal["role"];
  publications: NewsroomPublication[];
  publicationId?: string;
  publicationName?: string;
  /** Items waiting in this newsroom's inbox; the bell shows a dot when there are any. */
  inboxWaiting?: number;
  /** The newsroom is paused (not enabled): no new editions until it's resumed. */
  paused?: boolean;
  /** An operator inside a newsroom they don't belong to: with active support, or read-only inspection. */
  support?: "active" | "inspection" | null;
  children: ReactNode;
}) {
  const workspace = publicationId ? newsroomBase(publicationId) : "/newsroom";
  const person = name ?? { full: email, initials: email.charAt(0).toUpperCase() };
  return <NewsroomTasks workspace={workspace}>
    <div className="jw newsroom-shell" id="workspace">
      <NewsroomMenus />
      <a className="skip-workspace" href="#workspace-content">Skip to workspace</a>
      <aside className="jw-sidebar" aria-label="Journalist workspace">
        <Link className="jw-brand" href={publicationId ? newsroomHref(publicationId, "overview") : "/newsroom"}>
          <span>Newsbee</span><small>Workspace</small>
        </Link>
        <NewsroomSwitcher publications={publications} publicationId={publicationId} />
        {publicationId
          ? <NewsroomSideNav publicationId={publicationId} role={role} />
          : <nav className="jw-nav" aria-label="Newsroom navigation"><p className="jw-nav-hint">Choose a newsroom to open its editions, videos and settings.</p></nav>}
        <div className="jw-user">
          <div className="jw-user-card">
            <span className="jw-avatar" aria-hidden="true">{person.initials}</span>
            <span className="jw-user-text"><strong title={email}>{person.full}</strong><small>{ROLE_LABELS[role]}</small></span>
            <details className="jw-user-menu">
              <summary aria-label="Account menu" title="Account menu">⋯</summary>
              <div className="jw-user-menu-panel">
                {publicationId && <Link href={newsroomHref(publicationId, "settings")}><Icon name="settings" size={14} />Newsroom settings</Link>}
                <Link href="/account/security">Password &amp; sign-in</Link>
                {role !== "editor" && <Link className="jw-operations-link" href="/admin"><Icon name="operations" size={14} />Operations</Link>}
                <hr />
                <form action={async () => {
                  "use server";
                  await signOut({ redirectTo: "/login" });
                }}>
                  <button type="submit">Sign out</button>
                </form>
              </div>
            </details>
          </div>
        </div>
      </aside>
      <div className="jw-main">
        <header className="jw-topbar">
          <p className="jw-topbar-context">
            {publicationId ? <NewsroomTopbarTitle /> : <span className="jw-topbar-page">Newsrooms</span>}
            {publicationName && <><span className="jw-topbar-divider" aria-hidden="true" /><span>{publicationName}</span></>}
            {paused && <span className="jw-topbar-pill is-paused" title="No new editions until the newsroom is resumed">Newsroom paused</span>}
            {support && <span className="jw-topbar-pill is-support" title={support === "active"
              ? "You're working in this newsroom under publication-bound support; changes are audited."
              : "Newsroom inspection. Changes need active publication-bound support."}>
              {support === "active" ? "Publication-bound support active" : "Read-only operator inspection"}</span>}
          </p>
          <div className="jw-topbar-actions">
            <details className="jw-help">
              <summary>Help &amp; resources</summary>
              <div className="jw-help-panel">
                <p><strong>How an edition moves</strong></p>
                <ol>
                  <li>Choose communities and the edition week.</li>
                  <li>Generate a draft, or start writing yourself.</li>
                  <li>Edit, then mark it ready for approval.</li>
                  <li>Approve, then publish to the reader site.</li>
                </ol>
                <p>Published editions can be corrected, withdrawn or restored from the editor. Videos are made per published story.</p>
              </div>
            </details>
            {publicationId && <Link className="jw-icon-button" href={newsroomHref(publicationId, "inbox")}
              aria-label={inboxWaiting ? `Inbox, ${inboxWaiting} waiting` : "Inbox"} title={inboxWaiting ? `Inbox · ${inboxWaiting} waiting` : "Inbox"}
              data-unread={inboxWaiting ? "" : undefined}>
              <Icon name="bell" />
            </Link>}
          </div>
        </header>
        <main className="jw-content" id="workspace-content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  </NewsroomTasks>;
}
