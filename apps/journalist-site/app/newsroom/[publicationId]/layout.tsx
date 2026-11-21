import type { ReactNode } from "react";
import { activePublicationSupport } from "@/pipeline/publications/support";
import Link from "next/link";
import PublishingChannels from "@/app/publishing/channels";
import PublicationGeneration from "@/app/publishing/publication-generation";
import PublicationSettingsPanel from "@/app/publishing/publication-settings";
import PublicationSourceFeedback from "@/app/publishing/source-feedback";
import RetainedDisclosure from "@/app/components/retained-disclosure";
import AccountSettings from "@/app/account/settings";
import { isConfiguredOwner } from "@/pipeline/accounts/identity";
import NewsroomShell from "../newsroom-shell";
import { NewsroomDestinations, NewsroomTaskPanel } from "../newsroom-tasks";
import { PageHeader } from "../newsroom-ui";
import { loadNewsroom } from "./newsroom-context";
import { principalDisplayName } from "@/lib/display-name";
import { inbox } from "@/pipeline/orchestration/inbox";
import { resolveLocationScope } from "@/pipeline/publications/newsroom-scope";
import type { Db } from "mongodb";
import type { Principal } from "@/pipeline/accounts/identity";

/** How many items wait in this newsroom's inbox, for the bell's dot. Never blocks the page. */
async function inboxWaiting(db: Db, principal: Principal, publicationId: string) {
  try {
    const result = await inbox(db, undefined, principal, await resolveLocationScope(db, principal, publicationId));
    return Object.values(result.counts).reduce((sum, count) => sum + count, 0);
  } catch {
    return 0;
  }
}

/**
 * One newsroom's journalist workspace. The edition workspace and Settings live here rather than
 * in each page, so they stay mounted while the journalist moves between views and unsaved
 * edits survive. Pages only add what is specific to their URL.
 */
export default async function NewsroomLayout({ children, params }: { children: ReactNode; params: Promise<{ publicationId: string }> }) {
  const { publicationId } = await params;
  const { principal, db, publications, access, publication } = await loadNewsroom(publicationId);
  const operator = principal.role !== "editor";
  const owner = isConfiguredOwner(principal);
  const privileged = access.context.role === "privileged";
  const [name, waiting, support] = await Promise.all([
    principalDisplayName(principal), inboxWaiting(db, principal, publicationId),
    privileged ? activePublicationSupport(db, principal, publicationId).catch(() => null) : null,
  ]);
  return <NewsroomShell email={principal.email} name={name} role={principal.role} publications={publications} inboxWaiting={waiting}
    publicationId={publicationId} publicationName={publication.name} paused={!publication.enabled}
    support={privileged ? support ? "active" : "inspection" : null}>
    {children}
    <PublicationGeneration
      key={publicationId}
      publicationId={publicationId}
      publicationName={publication.name}
      publicationEnabled={publication.enabled}
      supportMode={access.context.role === "privileged"}
      operator={operator}
      generationAnchorId="editions"
      reportingAnchorId="reporting"
    />
    <NewsroomTaskPanel task="settings" lazy>
      <section className="newsroom-anchor newsroom-product-section jw-settings" id="settings" aria-labelledby="settings-title">
        <PageHeader eyebrow="Current" title="Settings" titleId="settings-title"
          description={`Profile, writing preferences, sponsors, coverage, source feedback and API keys for ${publication.name}.`} />
        <nav className="jw-settings-nav" aria-label="Settings sections">
          <a href="#newsroom-profile">Profile &amp; preferences</a>
          <a href="#audience">Community coverage</a>
          <a href="#source-feedback">Source feedback</a>
          <a href="#api-keys">API keys</a>
        </nav>
        {access.context.role === "privileged" && <p className="notice">Newsroom inspection. Changes need active publication-bound support.</p>}
        <div id="newsroom-profile" className="jw-settings-section">
          <PublicationSettingsPanel publicationId={publicationId} publicationName={publication.name} />
        </div>
        <NewsroomDestinations>
          <PublishingChannels channelId={publicationId} email={principal.email} surface="newsroom" />
        </NewsroomDestinations>
        <RetainedDisclosure id="source-feedback" title="Source feedback" className="panel publication-settings-disclosure">
          <PublicationSourceFeedback publicationId={publicationId} />
        </RetainedDisclosure>
        <section className="jw-card jw-settings-section" id="api-keys" aria-labelledby="api-keys-title" tabIndex={-1}>
          <p className="jw-eyebrow">Your account</p>
          <h2 id="api-keys-title">{operator ? owner ? "Environment & API settings" : "Personal API keys" : "API keys"}</h2>
          {operator
            ? <>
              <p>{owner
                ? "Generation you start in any newsroom uses deployment defaults unless you save personal overrides here."
                : "Administrators always use their own encrypted keys, including inside newsrooms they're assigned to. Missing keys never fall back to managed services."}
              {" "}These keys belong to your account ({principal.email}), not to {publication.name}.</p>
              <RetainedDisclosure title="Manage keys" className="publication-settings-disclosure">
                <AccountSettings owner={owner} />
              </RetainedDisclosure>
            </>
            : <p>Journalists don&apos;t need personal API keys. Editions you generate in {publication.name} use Newsbee-managed services, and the remaining allowance shows when you set up a new edition. Writing an edition yourself never uses provider calls.</p>}
        </section>
        {operator && <p className="chart-caption">Operations: <Link href={`/admin/publication-governance?publicationId=${encodeURIComponent(publicationId)}`}>
          {access.context.role === "privileged" ? "Support and governance" : "Newsroom governance"}</Link></p>}
      </section>
    </NewsroomTaskPanel>
  </NewsroomShell>;
}
