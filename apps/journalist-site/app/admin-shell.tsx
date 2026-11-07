import Link from "next/link";
import type { ReactNode } from "react";
import { signOut } from "@/auth";
import { getMongoDatabase } from "@/auth";
import { currentPrincipal } from "@/lib/admin-session";
import { effectiveCredentialProfile } from "@/pipeline/accounts/credentials";
import { profileMetadata } from "@/pipeline/accounts/execution";

type AdminPage = "dashboard" | "alerts" | "locations" | "inbox" | "source-map" | "interest-usage" | "discovery" | "model-usage" | "health" | "neighbour-stories" | "remembrance" | "drive-diagnostics" | "clear-data" | "administrators" | "account" | "approvals";

export default async function AdminShell({
  email,
  page,
  title,
  description,
  children,
}: {
  email: string;
  page: AdminPage;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const principal = await currentPrincipal();
  let readiness = "API profile not configured — browsing is available.";
  if (principal) {
    try {
      const profile = profileMetadata(principal, await effectiveCredentialProfile(await getMongoDatabase(), principal));
      readiness = profile?.revoked ? "API profile revoked — configure a replacement in Settings."
        : profile?.source === "environment" ? profile.configurationError ?? `Deployment defaults ${profile.automatic ? "automatic" : "saved"} · Model ${profile.capabilities.model ? "configured" : "not configured"} · Paid search ${profile.capabilities.paidSearch ? "configured" : "off"}.`
        : profile ? `Personal profile v${profile.version} · Model ${profile.capabilities.model ? "configured" : "not configured"} · Paid search ${profile.capabilities.paidSearch ? "configured" : "off"}.`
        : readiness;
    } catch { readiness = "API profile unavailable — browsing is available. Check Settings."; }
  }
  const navGroups: { label: string; items: { id: AdminPage; label: string; href: string }[] }[] = [
    { label: "Newsroom", items: [
      { id: "dashboard", label: "Overview", href: "/dashboard" },
      { id: "locations", label: "Location workspaces", href: "/locations" },
      { id: "inbox", label: "Editorial inbox", href: "/inbox" },
      { id: "alerts", label: "Attention queue", href: "/alerts" },
    ] },
    { label: "Internal maps", items: [
      { id: "source-map", label: "Source map", href: "/source-map" },
      { id: "interest-usage", label: "Interest and usage map", href: "/interest-usage" },
    ] },
    { label: "Operations", items: [
      { id: "health", label: "System health", href: "/health" },
      { id: "discovery", label: "Discovery", href: "/discovery" },
      { id: "model-usage", label: "Model usage", href: "/model-usage" },
      { id: "drive-diagnostics", label: "Storage", href: "/drive-diagnostics" },
      { id: "clear-data", label: "Clear reader data", href: "/clear-data" },
      { id: "administrators", label: "Users", href: "/administrators" },
      { id: "account", label: "Account & API settings", href: "/account" },
      { id: "approvals", label: "Approval inbox", href: "/approvals" },
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
            {group.items.filter((item) => principal?.role === "owner" || !["clear-data", "administrators", "approvals"].includes(item.id)).map((item) => (
            <Link
              aria-current={active(item.id) ? "page" : undefined}
              className={active(item.id) ? "sidebar-link active" : "sidebar-link"}
              href={item.href}
              key={item.id}
            >
              <span>{item.label}</span>
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
          <h1>{title}</h1>
          {description && <p>{description}</p>}
        </header>
        {principal && page !== "account" && <aside className="workspace-banner" role="status"><p>{principal.role === "owner" ? "Owner" : "Editor"} · {readiness} <Link href="/account">Settings</Link></p></aside>}
        {children}
      </div>
    </main>
  );
}
