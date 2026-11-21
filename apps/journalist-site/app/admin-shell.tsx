import Link from "next/link";
import type { ReactNode } from "react";
import { signOut } from "@/auth";
import { getMongoDatabase } from "@/auth";
import { requireOperatorPrincipal } from "@/lib/portal-access";
import { infrastructureSettings, resolveExecutionProviderPolicy } from "@/pipeline/accounts/execution";
import { AdminNavigation, AdminSectionNavigation, type AdminPage } from "./admin-navigation";

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
  const principal = await requireOperatorPrincipal();
  let readiness = "Managed provider readiness unavailable.";
  let readinessError = false;
  if (principal.role === "owner" && page !== "account") {
    try {
      const { settings } = await resolveExecutionProviderPolicy(await getMongoDatabase(), infrastructureSettings(), principal, { kind: "platform" });
      const searchConfigured = Boolean(settings.tavilySearchApiKey || settings.integrations.serpapiKey || settings.integrations.searchapiKey || settings.integrations.exaKey || (settings.integrations.brightdataKey && settings.integrations.brightdataZone));
      readiness = `Newsbee-managed providers · Model ${settings.modelProviders.some((provider) => provider.model && provider.apiKey) ? "configured" : "not configured"} · Paid search ${searchConfigured ? "configured" : "off"}.`;
    } catch {
      readiness = "Managed provider configuration unavailable. Ask the workspace operator to check deployment settings.";
      readinessError = true;
    }
  }
  return (
    <main className="admin-shell portal-shell admin-portal-shell" id="workspace">
      <a className="skip-workspace" href="#workspace-content">Skip to workspace</a>
      <aside className="sidebar">
        <div className="portal-brand-row">
          <Link className="brand" href="/admin"><span className="portal-brand-mark" aria-hidden="true">N</span><span>Newsbee Admin</span></Link>
        </div>
        <AdminNavigation page={page} owner={principal.role === "owner"} />
        <div className="sidebar-account">
          <span title={email}>{email}</span>
          <Link href="/account/security">Password & sign-in</Link>
          <form action={async () => {
            "use server";
            await signOut({ redirectTo: "/login" });
          }}>
            <button className="secondary" type="submit">Sign out</button>
          </form>
        </div>
      </aside>
      <div className="admin-content" id="workspace-content" tabIndex={-1}>
        <header className="page-heading portal-page-heading">
          <p className="eyebrow">{principal.role === "owner" ? "Owner" : "Admin"} · Global operations · Not a newsroom assignment</p>
          <h1>{title}</h1>
          {(description || page !== "account") && <details className="admin-page-help">
            <summary>Help</summary>
            {description && <p>{description}</p>}
            {page !== "account" && !readinessError && principal.role === "owner" && <p>{readiness} <Link href="/account">Provider settings</Link></p>}
            {principal.role !== "owner" && <p>Global administration does not grant platform provider access or newsroom membership. <Link href="/account">Personal settings</Link></p>}
          </details>}
        </header>
        <AdminSectionNavigation page={page} owner={principal.role === "owner"}
          localArticleReview={process.env.NEWSBEE_MODE === "local" && !process.env.VERCEL && process.env.NODE_ENV !== "production"} />
        {readinessError && <p className="alert" role="alert">{readiness} <Link href="/account">Provider settings</Link></p>}
        {children}
      </div>
    </main>
  );
}
