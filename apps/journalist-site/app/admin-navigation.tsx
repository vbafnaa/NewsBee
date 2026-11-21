"use client";

import Link from "next/link";

export type AdminPage = "alerts" | "locations" | "inbox" | "source-map" | "edition-map" | "interest-usage" | "discovery" | "model-usage" | "health" | "neighbour-stories" | "remembrance" | "drive-diagnostics" | "clear-data" | "site-backup" | "administrators" | "publication-governance" | "account" | "output-channels" | "campaigns" | "video-campaigns" | "newsletter";

const locationPages: AdminPage[] = ["locations", "alerts", "source-map", "discovery"];
const newsroomPages: AdminPage[] = ["output-channels", "publication-governance", "edition-map"];
const marketingPages: AdminPage[] = ["video-campaigns", "campaigns", "interest-usage"];
const systemPages: AdminPage[] = ["health", "model-usage", "drive-diagnostics", "newsletter", "site-backup", "clear-data"];

export function AdminNavigation({ page, owner }: { page: AdminPage; owner: boolean }) {
  const navItems = [
    { label: "Locations", href: "/admin", current: locationPages.includes(page) },
    { label: "Newsrooms", href: "/admin/publications", current: newsroomPages.includes(page) },
    { label: "People", href: "/admin/access", current: page === "administrators" },
    { label: "Inbox", href: "/inbox", current: ["inbox", "neighbour-stories", "remembrance"].includes(page) },
    { label: "Marketing", href: "/admin/video-campaigns", current: marketingPages.includes(page) },
    { label: "System", href: "/health", current: systemPages.includes(page) },
    { label: owner ? "Environment & API settings" : "Personal API keys", href: "/account", current: page === "account" },
  ];
  return <nav className="portal-primary-nav" aria-label="Admin navigation">
    <Link className="sidebar-link" href="/newsroom">Newsrooms workspace</Link>
    {navItems.map((item) => <Link
      aria-current={item.current ? "page" : undefined}
      className={`sidebar-link${item.current ? " active" : ""}`}
      href={item.href} key={item.href}
    >{item.label}</Link>)}
  </nav>;
}

export function AdminSectionNavigation({ page, owner, localArticleReview = false }: {
  page: AdminPage; owner: boolean; localArticleReview?: boolean;
}) {
  if (marketingPages.includes(page)) return <nav className="card-actions workspace-links" aria-label="Marketing navigation">
    <Link href="/admin/video-campaigns" aria-current={page === "video-campaigns" ? "page" : undefined}>Video campaigns</Link>
    <Link href="/admin/campaigns" aria-current={page === "campaigns" ? "page" : undefined}>Campaign requests (read-only)</Link>
    <Link href="/interest-usage">Insights / Google Analytics (external)</Link>
  </nav>;
  if (newsroomPages.includes(page)) return <nav className="card-actions workspace-links" aria-label="Newsroom management navigation">
    <Link href="/admin/publications" aria-current={page === "output-channels" ? "page" : undefined}>Manage newsrooms</Link>
    <Link href="/newsroom">Editions, Studio &amp; publishing</Link>
    {owner && <Link href="/admin/publication-governance" aria-current={page === "publication-governance" ? "page" : undefined}>Owner audit &amp; ownership history</Link>}
  </nav>;
  if (!systemPages.includes(page)) return null;
  return <section aria-label="System tools">
    <nav className="card-actions workspace-links" aria-label="System navigation">
      <Link href="/health" aria-current={["health", "model-usage"].includes(page) ? "page" : undefined}>Pipeline, model usage &amp; video diagnostics</Link>
      <Link href="/drive-diagnostics" aria-current={page === "drive-diagnostics" ? "page" : undefined}>Storage</Link>
      <Link href="/newsletter" aria-current={page === "newsletter" ? "page" : undefined}>Audience &amp; delivery history (email unavailable)</Link>
    </nav>
    {owner && <details open={["site-backup", "clear-data"].includes(page) || undefined}>
      <summary>Owner recovery &amp; Danger zone</summary>
      <p>Full restore replaces accounts and governance and revokes sessions. Reader/source cleanup is destructive. Each tool requires deliberate confirmation; opening it changes nothing.</p>
      <div className="card-actions">
        <Link href="/site-backup" aria-current={page === "site-backup" ? "page" : undefined}>Full site backup &amp; restore</Link>
        <Link href="/clear-data" aria-current={page === "clear-data" ? "page" : undefined}>Clear Reader / source data</Link>
        {localArticleReview && <Link href="/article-review">Article generation review (local)</Link>}
      </div>
    </details>}
  </section>;
}
