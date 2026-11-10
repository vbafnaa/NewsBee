import Link from "next/link";
import type { ReactNode } from "react";
import { signOut } from "@/auth";
import { getMongoDatabase } from "@/auth";
import { currentPrincipal } from "@/lib/admin-session";
import { effectiveCredentialProfile } from "@/pipeline/accounts/credentials";
import { infrastructureSettings, personalSettings, profileMetadata } from "@/pipeline/accounts/execution";
import { isConfiguredOwner } from "@/pipeline/accounts/identity";

type AdminPage = "alerts" | "locations" | "inbox" | "source-map" | "edition-map" | "interest-usage" | "discovery" | "model-usage" | "health" | "neighbour-stories" | "remembrance" | "drive-diagnostics" | "clear-data" | "site-backup" | "administrators" | "account" | "output-channels";

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
      const credential = await effectiveCredentialProfile(await getMongoDatabase(), principal);
      const profile = profileMetadata(principal, credential);
      if (profile?.revoked) readiness = "API profile revoked — configure a replacement in Settings.";
      else {
        const effective = personalSettings(infrastructureSettings(), principal, credential);
        const searchConfigured = Boolean(effective.tavilySearchApiKey || effective.integrations.serpapiKey || effective.integrations.searchapiKey || effective.integrations.exaKey || (effective.integrations.brightdataKey && effective.integrations.brightdataZone));
        readiness = profile?.source === "environment" ? profile.configurationError ?? `Deployment defaults ${profile.automatic ? "automatic" : "saved"} · Model ${profile.capabilities.model ? "configured" : "not configured"} · Paid search ${profile.capabilities.paidSearch ? "configured" : "off"}.`
          : `Personal API keys${profile ? ` · v${profile.version}` : ""}${isConfiguredOwner(principal) ? " · Owner deployment fallback" : " · No deployment fallback"} · Model ${effective.modelProviders.some((provider) => provider.model && provider.apiKey) ? "configured" : "not configured"} · Paid search ${searchConfigured ? "configured" : "off"}.`;
      }
    } catch { readiness = "API profile unavailable — browsing is available. Check Settings."; }
  }
  const navGroups: { label: string; items: { id: AdminPage; label: string; href: string; note?: string }[] }[] = [
    { label: "Newsroom", items: [
      { id: "locations", label: "Overview", href: "/locations" },
      { id: "inbox", label: "Editorial inbox", href: "/inbox" },
      { id: "output-channels", label: "Publishing channels", href: "/publishing" },
    ] },
    { label: "Internal maps", items: [
      { id: "source-map", label: "Source map", href: "/source-map" },
      { id: "edition-map", label: "Edition map", href: "/edition-map", note: "Moved from Source map" },
    ] },
    { label: "Analytics", items: [
      { id: "interest-usage", label: "Interest and usage map", href: "/interest-usage" },
    ] },
    { label: "Operations", items: [
      { id: "health", label: "System", href: "/health" },
      { id: "drive-diagnostics", label: "Storage", href: "/drive-diagnostics" },
      { id: "clear-data", label: "Clear data", href: "/clear-data" },
      { id: "site-backup", label: "Import & export", href: "/site-backup" },
      { id: "administrators", label: "Users", href: "/administrators" },
      { id: "account", label: "Environment & API settings", href: "/account" },
    ] },
  ];

  // Reader-story and remembrance review live in the Inbox; model usage is part of System.
  const active = (id: AdminPage) => page === id || (id === "inbox" && (page === "neighbour-stories" || page === "remembrance")) || (id === "health" && page === "model-usage");
  return (
    <main className="admin-shell" id="workspace">
      <a className="skip-workspace" href="#workspace-content">Skip to workspace</a>
      <aside className="sidebar">
        <Link className="brand" href="/locations">Newsbee</Link>
        <p className="eyebrow">Journalist workspace</p>
        <nav aria-label="Workspace navigation">
          {navGroups.map((group) => <div className="nav-group" key={group.label}>
            <p className="nav-group-label">{group.label}</p>
            {group.items.filter((item) => principal?.role === "owner" || !["clear-data", "administrators"].includes(item.id)).map((item) => (
            <Link
              aria-current={active(item.id) ? "page" : undefined}
              className={active(item.id) ? "sidebar-link active" : "sidebar-link"}
              href={item.href}
              key={item.id}
            >
              <span>{item.label}</span>{item.note && <small>{item.note}</small>}
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
