import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { pipelineDeps } from "@/lib/pipeline";
import { requireSignedInPrincipal } from "@/lib/portal-access";
import { listOutputChannelDirectory } from "@/pipeline/orchestration/output-channels";
import PublishingChannels from "@/app/publishing/channels";
import NewsroomShell from "./newsroom-shell";
import { principalDisplayName } from "@/lib/display-name";
import { canManageNewsrooms } from "@/pipeline/publications/permissions";
import { legacyNewsroomTarget, newsroomHref, NEWSROOM_TASK_LABELS, type NewsroomView } from "./newsroom-routes";
import { Icon, PageHeader } from "./newsroom-ui";

const VIEWS: NewsroomView[] = ["overview", "inbox", "new-edition", "collect-sources", "editions", "activity", "source-map", "videos", "new-video", "analytics", "admin", "settings"];

/** Where `/newsroom?publicationId=…&task=…` lands: a view name, or an anchor from the older single page. */
function destinationFor(publicationId: string, task: string | undefined, query: URLSearchParams) {
  if (task && (VIEWS as string[]).includes(task) && !query.has("draft")) {
    return newsroomHref(publicationId, task as NewsroomView, query.size ? `?${query}` : "");
  }
  return legacyNewsroomTarget(publicationId, query.toString(), task ? `#${task}` : "")
    ?? newsroomHref(publicationId, "overview", query.size ? `?${query}` : "");
}

export default async function NewsroomPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined> & { publicationId?: string; task?: string; draft?: string; generation?: string }>;
}) {
  const principal = await requireSignedInPrincipal();
  const directory = await listOutputChannelDirectory((await pipelineDeps()).db, principal);
  const publications = directory.filter((publication) => publication.archivedAt == null);
  const params = await searchParams;
  const { publicationId: requested, task } = params;
  const entries = Object.entries(params).flatMap(([key, value]) => value === undefined ? [] : (Array.isArray(value) ? value : [value]).map((entry): [string, string] => [key, entry]));
  const query = new URLSearchParams(entries.filter(([key]) => key !== "publicationId" && key !== "task"));
  if (requested) {
    if (!directory.some((publication) => publication.id === requested)) notFound();
    redirect(destinationFor(requested, task, query));
  }
  const view = task && (VIEWS as string[]).includes(task) ? task as NewsroomView : undefined;
  return <NewsroomShell email={principal.email} name={await principalDisplayName(principal)} role={principal.role} publications={publications}>
    <PageHeader eyebrow="Newsrooms" title="Your work"
      description={view ? `Choose where to open ${NEWSROOM_TASK_LABELS[view]}.` : task ? "Choose a newsroom to continue." : "Choose a newsroom to open its editions, videos and settings."} />
    <section className="newsroom-landing" aria-label="Newsrooms">
      {!publications.length
        ? <div className="jw-card empty-state"><h3>No newsrooms assigned</h3><p>{canManageNewsrooms(principal)
          ? "Create a newsroom in Operations. Management access does not assign you to other newsrooms."
          : "Ask an administrator to assign you to an existing newsroom. Journalists create editions inside assigned newsrooms."}</p></div>
        : <div className="publication-card-grid">{publications.map((publication) => <article className="publication-card jw-card" key={publication.id}>
          <div>
            {(publication.accessMode === "inspection" || !publication.selectedLocationIds.length || !publication.enabled) && <p className="jw-eyebrow">
              {[publication.accessMode === "inspection" && "Read-only inspection",
                !publication.selectedLocationIds.length && "Coverage setup needed",
                !publication.enabled && "Paused"].filter(Boolean).join(" · ")}
            </p>}
            <h3>{publication.name}</h3>
            <p>{publication.selectedLocationIds.length} covered {publication.selectedLocationIds.length === 1 ? "community" : "communities"} · {publication.destinations.map((destination) => destination.type === "reader" ? "Web" : "Video").join(" + ")}</p>
          </div>
          <div className="card-actions">
            <Link className="jw-button" aria-label={`${publication.accessMode === "direct" ? "Open" : "Inspect"} ${publication.name}`}
              href={destinationFor(publication.id, task, query)}>{publication.accessMode === "direct" ? "Open" : "Inspect"}<Icon name="arrow" size={14} /></Link>
          </div>
        </article>)}</div>}
    </section>
    {canManageNewsrooms(principal) && <PublishingChannels email={principal.email} surface="newsroom" creationOnly />}
  </NewsroomShell>;
}
