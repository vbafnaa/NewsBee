import Link from "next/link";
import type { ReactNode } from "react";
import { signOut } from "@/auth";

type AdminPage = "dashboard" | "alerts" | "locations" | "inbox" | "source-map" | "interest-usage" | "discovery" | "model-usage" | "health" | "neighbour-stories" | "remembrance" | "drive-diagnostics" | "clear-data" | "administrators";

export default function AdminShell({
  email,
  page,
  title,
  description,
  children,
}: {
  email: string;
  page: AdminPage;
  title: string;
  description: string;
  children: ReactNode;
}) {
  const navGroups: { label: string; items: { id: AdminPage; label: string; href: string; hint: string }[] }[] = [
    { label: "Newsroom", items: [
      { id: "dashboard", label: "Overview", href: "/dashboard", hint: "Global health & next steps" },
      { id: "locations", label: "Location workspaces", href: "/locations", hint: "Onboard, review, run & publish" },
      { id: "inbox", label: "Editorial inbox", href: "/inbox", hint: "Reader input & held stories" },
      { id: "alerts", label: "Attention queue", href: "/alerts", hint: "Source & pipeline issues" },
    ] },
    { label: "Internal maps · Password protected", items: [
      { id: "source-map", label: "Source map", href: "/source-map", hint: "Network & edition decisions" },
      { id: "interest-usage", label: "Interest and usage map", href: "/interest-usage", hint: "Reads, subscriptions & demand" },
    ] },
    { label: "Operations", items: [
      { id: "health", label: "System health", href: "/health", hint: "Scheduler, providers & history" },
      { id: "discovery", label: "Discovery", href: "/discovery", hint: "Source discovery health" },
      { id: "model-usage", label: "Model usage", href: "/model-usage", hint: "Budget & requests" },
      { id: "drive-diagnostics", label: "Storage", href: "/drive-diagnostics", hint: "Drive diagnostics" },
      { id: "clear-data", label: "Clear reader data", href: "/clear-data", hint: "Interest, clicks & impressions" },
      { id: "administrators", label: "Access", href: "/administrators", hint: "Administrators" },
    ] },
  ];

  // Reader-story and remembrance review live in the Inbox; health is the dashboard and model usage.
  const active = (id: AdminPage) => page === id || (id === "inbox" && (page === "neighbour-stories" || page === "remembrance"));
  return (
    <main className="admin-shell" id="workspace">
      <a className="skip-workspace" href="#workspace-content">Skip to workspace</a>
      <aside className="sidebar">
        <Link className="brand" href="/dashboard">Newsbee</Link>
        <p className="eyebrow">Journalist workspace</p>
        <nav aria-label="Workspace navigation">
          {navGroups.map((group) => <div className="nav-group" key={group.label}>
            <p className="nav-group-label">{group.label}</p>
            {group.items.map((item) => (
            <Link
              aria-current={active(item.id) ? "page" : undefined}
              className={active(item.id) ? "sidebar-link active" : "sidebar-link"}
              href={item.href}
              key={item.id}
            >
              <span>{item.label}</span><small>{item.hint}</small>
            </Link>
          ))}</div>)}
        </nav>
        <div className="sidebar-account">
          <span title={email}>{email}</span>
          <form action={async () => {
            "use server";
            await signOut({ redirectTo: "/login" });
          }}>
            <button className="secondary" type="submit">Sign out</button>
          </form>
        </div>
      </aside>
      <div className="admin-content" id="workspace-content" tabIndex={-1}>
        <header className="page-heading">
          <p className="eyebrow">Newsbee / Editorial workspace</p>
          <h1>{title}</h1>
          <p>{description}</p>
        </header>
        {children}
      </div>
    </main>
  );
}
