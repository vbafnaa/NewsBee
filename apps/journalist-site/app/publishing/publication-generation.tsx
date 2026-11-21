"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { useCallback, useContext, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { adminApi, ApiError } from "@/lib/admin-client";
import type { RunOptions } from "@/pipeline/core/run-values";
import type { PublicationReaderMetadata } from "../../../../shared/publication-preview";
import PublicationEditorialWorkspace from "./publication-editorial-workspace";
import { NewsroomTaskPanel, useNewsroomTask } from "../newsroom/newsroom-tasks";
import { draftIdForPath, newsroomBase, newsroomEditionHref, newsroomHref } from "../newsroom/newsroom-routes";
import {
  EDITION_STATUS_LABELS, Icon, PageHeader, StatusPill, editionStatusKey, formatDate, formatEditionWindow, type EditionStatusKey,
} from "../newsroom/newsroom-ui";
import { editionPipeline, generationNeedsAttention } from "../newsroom/edition-pipeline";
import { SAMPLE_ANALYTICS, SampleTag } from "../newsroom/sample-analytics";
import type { EditionWorkActivity, PublicationDraft } from "@/pipeline/publications/generation";
import { includedPublicationStories } from "@/pipeline/publications/inclusion";
import JobProgress from "../components/job-progress";
import { editionGenerationActivity } from "../run-progress";

type ReadyLocation = {
  location_id: string;
  location_name: string;
  state: string;
  ready: boolean;
  missing_prerequisites: string[];
  remedy?: { href: string; label: string };
};
type CoverageRequest = { status: "requested" | "preparing" | "blocked" | "ready"; requested_at: string };
type CoverageRequests = {
  locations: Array<ReadyLocation & { request: CoverageRequest | null }>;
  request: CoverageRequest | null;
  request_href: string;
};
type GenerationAllowance = {
  remaining: number; exhausted: boolean; resetsAt: number;
  source: "platform" | "personal" | "environment"; reasons: string[];
  admission: { available: boolean; detail: string | null };
};
type ChildRun = {
  _id: string;
  location_id: string;
  location_name: string;
  status: string;
  error?: string | null;
  execution_blocked?: { reason: string; code?: string; resets_at?: number };
  work?: EditionWorkActivity;
};
type Generation = {
  _id: string;
  status: "starting" | "running" | "combining" | "blocked" | "paused" | "cancelling" | "ready" | "failed" | "cancelled";
  window: [string, string];
  created_at: number;
  error: string | null;
  progress: { total: number; completed: number; failed: number };
  children: ChildRun[];
};
type DraftSummary = Pick<PublicationDraft, "_id" | "title" | "window" | "editorial_status" | "locations"> & {
  origin?: "manual" | "generated";
  generation_id?: string;
  revision: number;
  created_at: number;
  correction?: { supersedes_release_id: string; reason: string };
  story_count?: number | null;
};
type ReleaseSummary = {
  draftId: string; releaseId: string; publishedAt: number;
  action: { action: "withdraw" | "restore" } | null; correctionRequired?: boolean;
};
type Workspace = {
  publication: { id: string; name: string; role: "owner" | "editor" | "privileged"; canWrite?: boolean; supportExpiresAt?: number | null };
  limits: { maxLocations: number };
  locations: ReadyLocation[];
  generations: Generation[];
  draft: PublicationDraft | null;
  drafts: DraftSummary[];
  draftsNextCursor: string | null;
  defaultOptions: RunOptions;
  recovery?: { personalFundingAllowed: boolean; managedFundingAllowed: boolean };
  execution?: { funding: "managed" | "personal" | "owner" };
} & PublicationReaderMetadata;

const activeStatuses = new Set(["starting", "running", "combining", "blocked", "paused", "cancelling"]);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

function addDays(day: string, count: number) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

function defaultWindow(): [string, string] {
  const today = new Date();
  const start = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate() + 1)).toISOString().slice(0, 10);
  return [start, addDays(start, 6)];
}

function childLabel(status: string) {
  if (status === "collecting") return "Gathering local reporting";
  if (status === "awaiting_authoring") return "Waiting to start authoring";
  if (status === "awaiting_finish") return "Waiting to finish the draft";
  if (status === "authoring") return "Drafting stories";
  if (["finishing", "publishing"].includes(status)) return "Preparing the draft";
  if (status === "built") return "Ready";
  if (status === "published") return "Published outside combined generation";
  if (status === "failed") return "Needs attention";
  if (status === "cancelled") return "Stopped";
  if (status === "blocked") return "Blocked";
  if (status === "paused") return "Paused";
  if (status === "cancelling") return "Cancelling";
  return "Stage unavailable";
}

export default function PublicationGeneration({
  publicationId,
  publicationName,
  publicationEnabled,
  supportMode,
  operator = false,
  generationAnchorId,
  reportingAnchorId,
  initialDraftId,
  initialGenerationId,
}: {
  publicationId: string;
  publicationName: string;
  publicationEnabled: boolean;
  supportMode: boolean;
  operator?: boolean;
  generationAnchorId: string;
  reportingAnchorId: string;
  initialDraftId?: string;
  initialGenerationId?: string;
}) {
  const task = useNewsroomTask();
  const [data, setData] = useState<Workspace | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [dateWindow, setDateWindow] = useState<[string, string]>(defaultWindow);
  const [options, setOptions] = useState<RunOptions | null>(null);
  const [error, setError] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [setupStarted, setSetupStarted] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [releases, setReleases] = useState<ReleaseSummary[] | null>(null);
  const [releasesError, setReleasesError] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | EditionStatusKey>("");
  const router = useContext(AppRouterContext);
  const pathname = usePathname();
  // Set when the sidebar's Edition editor found no draft to open (`/editions?no-draft=1`).
  const [noDraft, setNoDraft] = useState(false);
  useEffect(() => { setNoDraft(new URLSearchParams(window.location.search).has("no-draft")); }, [pathname]);
  const base = newsroomBase(publicationId);
  const [clock, setClock] = useState(Date.now);
  const [allowance, setAllowance] = useState<GenerationAllowance | null>(null);
  const [allowanceError, setAllowanceError] = useState("");
  const [preflightRevision, setPreflightRevision] = useState(0);
  const [coverageRequests, setCoverageRequests] = useState<CoverageRequests | null>(null);
  const [coverageError, setCoverageError] = useState("");
  const [coverageBusy, setCoverageBusy] = useState(false);
  const initialized = useRef(false);
  const requestKey = useRef<string>(crypto.randomUUID());
  const manualRequestKey = useRef<string>(crypto.randomUUID());
  const [selectedDraftId, setSelectedDraftId] = useState(() => initialDraftId ?? draftIdForPath(pathname ?? "", base));
  const [switching, setSwitching] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const historyPaged = useRef(false);
  const beforeDraftChange = useRef<(() => Promise<boolean>) | null>(null);
  const request = useRef<AbortController | null>(null);
  const switchingRef = useRef(false);
  const [selectedGenerationId, setSelectedGenerationId] = useState<string | null>(initialGenerationId ?? null);
  const [funding, setFunding] = useState<"" | "platform" | "personal">("");
  const [recoveryReason, setRecoveryReason] = useState("");
  const [recoveryError, setRecoveryError] = useState("");
  const updateSelectedDraft = useCallback((draft: PublicationDraft) => {
    setData((current) => current && current.draft?._id === draft._id ? {
      ...current, draft,
      drafts: current.drafts.map((item) => item._id === draft._id ? { ...item, editorial_status: draft.editorial_status } : item),
    } : current);
  }, []);
  const supportExpiresAt = data?.publication.supportExpiresAt;
  const canWrite = Boolean(data && (data.publication.canWrite ?? data.publication.role !== "privileged")
    && (!supportExpiresAt || supportExpiresAt > clock));
  useEffect(() => {
    if (!supportExpiresAt) return;
    const timer = window.setTimeout(() => setClock(Date.now()), Math.max(0, supportExpiresAt - Date.now()) + 1);
    return () => window.clearTimeout(timer);
  }, [supportExpiresAt]);
  const setupVisible = Boolean(data && task === "new-edition");
  const coverageBlocked = Boolean(data && (!data.locations.length || data.locations.some((location) => !location.ready)));
  useEffect(() => {
    if (!setupVisible) return;
    const controller = new AbortController();
    let timer: number | undefined;
    const query = options ? `?options=${encodeURIComponent(JSON.stringify(options))}` : "";
    const check = async () => {
      setAllowance(null);
      setAllowanceError("");
      try {
        const result = await adminApi<GenerationAllowance>(`publications/${encodeURIComponent(publicationId)}/generation-preflight${query}`, { signal: controller.signal });
        if (typeof result?.admission?.available !== "boolean"
          || (!result.admission.available && !result.admission.detail)) {
          throw new Error("Generation availability could not be read. Recheck availability.");
        }
        if (!controller.signal.aborted) { setAllowance(result); setAllowanceError(""); }
      } catch (error) {
        if (!controller.signal.aborted) { setAllowance(null); setAllowanceError(errorText(error)); }
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(() => void check(), 15_000);
      }
    };
    void check();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [setupVisible, publicationId, options, preflightRevision]);
  useEffect(() => {
    if (!setupVisible || !coverageBlocked) return;
    const controller = new AbortController();
    void adminApi<CoverageRequests>(`publications/${encodeURIComponent(publicationId)}/coverage-requests`, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) { setCoverageRequests(result); setCoverageError(""); } })
      .catch((error) => { if (!controller.signal.aborted) setCoverageError(errorText(error)); });
    return () => controller.abort();
  }, [setupVisible, coverageBlocked, publicationId]);

  async function requestCoverage(locationId: string | null) {
    if (!canWrite) return;
    setCoverageBusy(true);
    setCoverageError("");
    try {
      await adminApi(`publications/${encodeURIComponent(publicationId)}/coverage-requests`, {
        method: "POST", body: JSON.stringify({ location_id: locationId }),
      });
      setCoverageRequests(await adminApi<CoverageRequests>(`publications/${encodeURIComponent(publicationId)}/coverage-requests`));
    } catch (error) {
      setCoverageError(errorText(error));
    } finally {
      setCoverageBusy(false);
    }
  }

  useEffect(() => {
    const sync = () => setSelectedGenerationId(new URL(window.location.href).searchParams.get("generation"));
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  const navigate = useCallback((href: string, replace = false) => {
    if (router) {
      if (replace) router.replace(href, { scroll: false });
      else router.push(href);
      return;
    }
    // Outside the app router (tests, embedded previews) the history API stands in for navigation.
    window.history[replace ? "replaceState" : "pushState"](window.history.state, "", href);
    window.dispatchEvent(new window.Event("popstate"));
  }, [router]);

  // An edition opens at its own URL. Older single-page links keep `?draft=` on the newsroom's path.
  const writeSelection = useCallback((id: string, replace = false, open = false) => {
    const url = new URL(window.location.href);
    if (open || draftIdForPath(url.pathname, base) !== undefined) {
      const target = new URL(newsroomEditionHref(publicationId, id), url);
      url.searchParams.delete("draft");
      target.search = url.search;
      if (target.pathname !== url.pathname) navigate(`${target.pathname}${target.search}`, replace);
      return;
    }
    if (url.pathname.replace(/\/$/, "") !== base) return;
    url.searchParams.set("draft", id);
    window.history[replace ? "replaceState" : "pushState"](window.history.state, "", url);
  }, [base, navigate, publicationId]);

  const chooseDraft = useCallback(async (id: string, replace = false, open = false) => {
    if (switchingRef.current) return;
    if (id === selectedDraftId) {
      if (open) writeSelection(id, replace, true);
      return;
    }
    switchingRef.current = true;
    setSwitching(true);
    try {
      if (beforeDraftChange.current && !await beforeDraftChange.current()) {
        if (selectedDraftId !== undefined) writeSelection(selectedDraftId, true);
        return;
      }
      request.current?.abort();
      writeSelection(id, replace, open);
      setSelectedDraftId(id);
    } finally {
      switchingRef.current = false;
      setSwitching(false);
    }
  }, [selectedDraftId, writeSelection]);

  useEffect(() => {
    const sync = () => {
      const url = new URL(window.location.href);
      const id = draftIdForPath(url.pathname, base)
        ?? (url.pathname.replace(/\/$/, "") === base ? url.searchParams.get("draft") ?? undefined : undefined);
      if (id !== undefined && id !== selectedDraftId) void chooseDraft(id, true);
    };
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [base, chooseDraft, selectedDraftId, pathname]);

  const load = useCallback(async (readerLinksOnly = false) => {
    request.current?.abort();
    const current = new AbortController();
    request.current = current;
    try {
      const params = new URLSearchParams();
      // Without a selection, ask for no draft rather than the newest one: only the editor needs it.
      params.set("draft", selectedDraftId ?? "");
      if (selectedGenerationId !== null) params.set("generation", selectedGenerationId);
      const query = params.size ? `?${params}` : "";
      const workspace = await adminApi<Workspace>(`publications/${encodeURIComponent(publicationId)}/generations${query}`, { signal: current.signal });
      if (current.signal.aborted) return;
      if (readerLinksOnly) {
        setData((current) => current && {
          ...current, readerBaseUrl: workspace.readerBaseUrl, readerLink: workspace.readerLink,
        });
        setError("");
        return;
      }
      setData((current) => current && historyPaged.current ? {
        ...workspace,
        drafts: [...workspace.drafts, ...current.drafts.filter((item) => !workspace.drafts.some((fresh) => fresh._id === item._id))],
        draftsNextCursor: current.draftsNextCursor,
      } : workspace);
      setClock(Date.now());
      setRefreshError("");
      if (!initialized.current) {
        const ready = workspace.locations.filter((location) => location.ready);
        setSelected(ready.length <= workspace.limits.maxLocations ? ready.map((location) => location.location_id) : []);
        setOptions({ ...workspace.defaultOptions, mode: "autopilot" });
        initialized.current = true;
      }
      setError("");
    } catch (caught) {
      if (!current.signal.aborted) {
        const detail = operator ? errorText(caught) : "Edition status couldn't be refreshed. Try again shortly.";
        setError(detail);
        if (!readerLinksOnly) setRefreshError(detail);
      }
    }
  }, [publicationId, selectedDraftId, selectedGenerationId, operator]);

  useEffect(() => {
    void load();
    return () => request.current?.abort();
  }, [load]);
  const active = data?.generations.find((generation) => activeStatuses.has(generation.status));
  const targetGeneration = selectedGenerationId !== null
    ? data?.generations.find((generation) => generation._id === selectedGenerationId)
    : active ?? data?.generations[0];
  useEffect(() => {
    setFunding("");
    setRecoveryReason("");
    setRecoveryError("");
  }, [targetGeneration?._id]);

  async function recover(action: "cancel" | "retry" | "resume") {
    if (!targetGeneration || !canWrite) return;
    setBusy(true);
    setError("");
    setRecoveryError("");
    setNotice("");
    try {
      await adminApi(`publications/${encodeURIComponent(publicationId)}/generations/${encodeURIComponent(targetGeneration._id)}`, {
        method: "POST", body: JSON.stringify({ action, ...(funding ? { funding } : {}), reason: recoveryReason }),
      });
      setNotice(action === "cancel" ? "Cancellation requested. Executing work continues to hold admission until it settles." : "Generation recovery authorized. Completed community drafts were retained.");
      await load();
    } catch (caught) {
      setRecoveryError(operator ? errorText(caught) : "Recovery couldn't be confirmed. Refresh the status before trying again, or ask an operator for help.");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => { setClock(Date.now()); void load(); }, 5_000);
    return () => window.clearInterval(timer);
  }, [active?._id, load]);

  function confirmStart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!options || !canStart || busy) return;
    setConfirmOpen(true);
  }

  async function start() {
    setConfirmOpen(false);
    if (!options || !canStart || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (beforeDraftChange.current && !await beforeDraftChange.current()) return;
      await adminApi(`publications/${encodeURIComponent(publicationId)}/generations`, {
        method: "POST",
        body: JSON.stringify({
          locationIds: selected,
          window: dateWindow,
          options: { ...options, mode: "autopilot" },
          idempotencyKey: requestKey.current,
        }),
      });
      requestKey.current = crypto.randomUUID();
      setNotice("Generation started. This page will update as each community draft is prepared.");
      await load();
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "generation_busy") {
        setAllowance((current) => current && { ...current, admission: { available: false, detail: caught.message } });
        setError("Shared capacity changed before generation could start. No new generation was created. Recheck availability or start writing.");
      } else {
        setError(operator ? errorText(caught) : "Generation couldn't be confirmed. Refresh the status before trying again, or ask an operator for help.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function startWriting() {
    if (!canWrite) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (beforeDraftChange.current && !await beforeDraftChange.current()) return;
      const result = await adminApi<{ draft: PublicationDraft }>(`publications/${encodeURIComponent(publicationId)}/drafts`, {
        method: "POST",
        body: JSON.stringify({ locationIds: selected, window: dateWindow, idempotencyKey: manualRequestKey.current }),
      });
      manualRequestKey.current = crypto.randomUUID();
      await chooseDraft(result.draft._id, false, true);
      setNotice("Writing draft created. Unfinished reporting autosaves; preview is optional.");
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  async function loadOlderDrafts() {
    if (!data?.draftsNextCursor) return;
    const selection = selectedDraftId;
    const controller = request.current;
    setHistoryBusy(true);
    try {
      const result = await adminApi<Workspace>(`publications/${encodeURIComponent(publicationId)}/generations?draft=${encodeURIComponent(selection ?? "")}&draftBefore=${encodeURIComponent(data.draftsNextCursor)}`);
      if (controller?.signal.aborted) return;
      historyPaged.current = true;
      setData((current) => current && {
        ...current,
        drafts: [...new Map([...current.drafts, ...result.drafts].map((draft) => [draft._id, draft])).values()],
        draftsNextCursor: result.draftsNextCursor,
      });
    } catch (caught) {
      if (!controller?.signal.aborted) setError(errorText(caught));
    } finally {
      setHistoryBusy(false);
    }
  }

  // Release dates and withdrawals for the edition list; read again only when the list changes.
  const releasesFor = useRef<number | null>(null);
  const draftCount = data?.drafts.length;
  useEffect(() => {
    if ((task !== "editions" && task !== "overview") || draftCount === undefined || releasesFor.current === draftCount) return;
    releasesFor.current = draftCount;
    const controller = new AbortController();
    void adminApi<{ releases?: ReleaseSummary[] }>(`publications/${encodeURIComponent(publicationId)}/releases`, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) { setReleases(Array.isArray(result?.releases) ? result.releases : []); setReleasesError(""); } })
      .catch((caught) => { if (!controller.signal.aborted) { releasesFor.current = null; setReleasesError(errorText(caught)); } });
  }, [task, publicationId, draftCount]);

  const releaseByDraft = useMemo(() => new Map((releases ?? []).map((release) => [release.draftId, release])), [releases]);
  const editionRows = useMemo(() => (data?.drafts ?? []).map((item) => {
    const release = releaseByDraft.get(item._id);
    const status = editionStatusKey(item.editorial_status, {
      withdrawn: release?.action?.action === "withdraw", correction: Boolean(item.correction),
    });
    return { item, release, status, title: item.title || `Weekly edition · ${formatEditionWindow(item.window)}` };
  }), [data?.drafts, releaseByDraft]);

  if (!data) return <>
    <NewsroomTaskPanel key="overview" task="overview">
      <div className="jw-card"><p className={error ? "alert" : undefined} role={error ? "alert" : "status"}>{error || "Loading editions…"}</p></div>
    </NewsroomTaskPanel>
    <NewsroomTaskPanel key="editions" task={["editions", "new-edition"]}>
    <section className="newsroom-anchor newsroom-product-section" id={generationAnchorId} aria-label="Editions">
      <div className="jw-card"><p className={error ? "alert" : undefined} role={error ? "alert" : "status"}>{error || "Loading edition setup…"}</p></div>
    </section>
    </NewsroomTaskPanel>
    <NewsroomTaskPanel key="edition-editor" task="writing">
      <p role="status">{error || "Loading selected edition…"}</p>
    </NewsroomTaskPanel>
    <NewsroomTaskPanel key="activity" task="activity">
      <p role={error ? "alert" : "status"}>{error || "Loading generation activity…"}</p>
    </NewsroomTaskPanel>
  </>;
  const canStartWriting = canWrite && publicationEnabled
    && selected.length > 0 && selected.length <= data.limits.maxLocations;
  const canStart = canStartWriting && !active && options && allowance?.admission.available && !allowance.exhausted && !allowance.reasons?.length;
  const draft = data.draft && data.draft._id === selectedDraftId ? data.draft : null;
  const formId = `generation-${publicationId}`;
  const selectedCoverage = selected.map((id) => data.locations.find((location) => location.location_id === id)?.location_name ?? id).join(" + ");
  const needsAttention = data.generations.some((generation) => generationNeedsAttention(generation) || generation.status === "failed" || Boolean(generation.error));
  const notReady = data.locations.filter((location) => !location.ready);
  const awaitingApproval = data.drafts.filter((item) => item.editorial_status === "ready_for_approval");
  const correctionsDue = (releases ?? []).filter((release) => release.correctionRequired && release.action?.action !== "withdraw");
  const pipelineGeneration = active ?? data.generations[0];
  const pipeline = pipelineGeneration ? editionPipeline(pipelineGeneration) : null;
  const activityHref = newsroomHref(publicationId, "activity");
  // Main opened a finished generation's draft by itself; now it's one obvious link on Overview and Editions.
  const latestGeneration = data.generations[0];
  const finishedDraft = latestGeneration?.status === "ready"
    ? data.drafts.find((item) => item.generation_id === latestGeneration._id && item.editorial_status !== "published") : undefined;
  const openEdition = (id: string) => (event: { preventDefault(): void; metaKey?: boolean; ctrlKey?: boolean }) => {
    if (event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    void chooseDraft(id, false, true);
  };
  const query = search.trim().toLowerCase();
  const visibleRows = editionRows.filter((row) => (!statusFilter || row.status === statusFilter)
    && (!query || `${row.title} ${row.item.window.join(" ")} ${EDITION_STATUS_LABELS[row.status]}`.toLowerCase().includes(query)));
  const finishedDraftLink = finishedDraft && <p className="jw-card-note jw-new-draft" role="status">
    The {formatEditionWindow(finishedDraft.window)} edition has finished generating.{" "}
    <a href={newsroomEditionHref(publicationId, finishedDraft._id)} onClick={openEdition(finishedDraft._id)}>Open the new draft →</a>
  </p>;
  const activeProgress = active && <div className="jw-card jw-active-generation">
    <JobProgress label="Generate edition" activity={editionGenerationActivity(active, clock / 1000)} refreshError={refreshError} />
    <Link href={activityHref}>Inspect activity and recovery</Link>
  </div>;

  return <>
    {data.readerLink?.state === "unavailable" && task !== "settings" && task !== "videos" && <div className="alert" role="status">
      {data.readerLink.detail} <button type="button" className="secondary" onClick={() => void load(true)}>Retry workspace links</button>
    </div>}

    <NewsroomTaskPanel key="overview" task="overview">
      {/* Placed by the Overview grid: pipeline beside the reader-activity chart, latest editions beside source health. */}
      <section className="jw-card jw-area-pipeline" aria-labelledby="pipeline-title" id="needs-attention" tabIndex={-1}>
        <div className="jw-card-head">
          <div><p className="jw-eyebrow">Edition pipeline</p><h2 id="pipeline-title">{active ? "In progress" : pipelineGeneration ? "Latest generation" : "Nothing generating"}</h2></div>
          <Link className="jw-card-more" href={activityHref} aria-label="Generation activity and recovery">⋯</Link>
        </div>
        {pipelineGeneration && pipeline ? <>
          <div className="jw-pipeline-head">
            <span className="jw-progress-ring" style={{ "--value": pipeline.percent } as React.CSSProperties} role="img" aria-label={`${pipeline.percent}% of stages complete`}>{pipeline.percent}%</span>
            <div>
              <strong>{formatEditionWindow(pipelineGeneration.window)} edition</strong>
              <p><small>{pipelineGeneration.progress.completed} of {pipelineGeneration.progress.total} community drafts ready</small></p>
            </div>
          </div>
          <ol className="jw-steps">{pipeline.stages.map((stage, index) => <li key={stage.label} data-state={stage.state}>
            <span className="jw-step-mark">{stage.state === "done" ? <Icon name="check" size={12} /> : stage.state === "failed" ? "!" : index + 1}</span>
            <span><strong>{stage.label}</strong><small>{stage.state === "done" ? "Done" : stage.state === "current" ? stage.detail : stage.state === "failed" ? "Needs attention" : "Waiting"}</small></span>
          </li>)}</ol>
        </> : <p className="jw-stat-detail">No edition is generating. Start a new edition to collect this week&apos;s local reporting.</p>}
        {finishedDraftLink}
        {needsAttention && <p className="jw-card-alert" role="status">A generation has failed or blocked work. <Link href={activityHref}>Resume, retry or cancel</Link></p>}
        {!data.locations.length && <p className="jw-card-alert" role="status">No communities are configured yet. <Link href={newsroomHref(publicationId, "new-edition")}>Request coverage</Link></p>}
        {notReady.length > 0 && <p className="jw-card-alert" role="status">{notReady.length} {notReady.length === 1 ? "community isn't" : "communities aren't"} ready: {notReady.map((location) => location.location_name).join(", ")}. <Link href={newsroomHref(publicationId, "new-edition")}>See what&apos;s missing</Link></p>}
        <Link className="jw-button jw-button-outline" href={pipelineGeneration ? activityHref : newsroomHref(publicationId, "new-edition")}>
          {pipelineGeneration ? "View pipeline" : "Start a new edition"}<Icon name="arrow" size={14} /></Link>
      </section>
      <section className="jw-card jw-area-latest" aria-labelledby="latest-editions-title">
        <div className="jw-card-head">
          <div><p className="jw-eyebrow">Recent work</p><h2 id="latest-editions-title">Latest editions</h2></div>
          <Link className="jw-link-arrow" href={newsroomHref(publicationId, "editions")}>View all<Icon name="arrow" size={14} /></Link>
        </div>
        {(awaitingApproval.length > 0 || correctionsDue.length > 0) && <p className="jw-card-note">
          {awaitingApproval.length > 0 && <>{awaitingApproval.length} {awaitingApproval.length === 1 ? "edition is" : "editions are"} ready for approval. <a href={newsroomEditionHref(publicationId, awaitingApproval[0]._id)} onClick={openEdition(awaitingApproval[0]._id)}>Review</a>{correctionsDue.length > 0 ? " · " : ""}</>}
          {correctionsDue.length > 0 && <>{correctionsDue.length} published {correctionsDue.length === 1 ? "edition needs" : "editions need"} a correction after a source change. <a href={newsroomEditionHref(publicationId, correctionsDue[0].draftId)} onClick={openEdition(correctionsDue[0].draftId)}>Open</a></>}
        </p>}
        {editionRows.length ? <ul className="jw-list">{editionRows.slice(0, 5).map((row, index) => <li key={row.item._id}>
          <a className="jw-list-row" href={newsroomEditionHref(publicationId, row.item._id)} onClick={openEdition(row.item._id)}>
            <span className="jw-list-icon"><Icon name="edition" /></span>
            <span className="jw-list-text"><strong>{row.title}</strong>
              <small>{row.item.story_count != null ? `${row.item.story_count} ${row.item.story_count === 1 ? "story" : "stories"} · ` : ""}{formatDate(row.release?.publishedAt ?? row.item.created_at)}</small></span>
            <StatusPill status={row.status} />
            <span className="jw-views" title="Sample data. Real analytics ship in a later release."><Icon name="eye" />{row.status === "published" ? SAMPLE_ANALYTICS.editionViews[index % SAMPLE_ANALYTICS.editionViews.length].toLocaleString("en-US") : "—"}</span>
            <Icon name="chevronRight" size={14} />
          </a>
        </li>)}</ul>
          : <div className="jw-empty"><p>No editions yet.</p><Link className="jw-button" href={newsroomHref(publicationId, "new-edition")}>Create the first edition</Link></div>}
        {editionRows.some((row) => row.status === "published") && <p className="jw-card-foot"><SampleTag /> View counts are sample data until analytics ship.</p>}
      </section>
    </NewsroomTaskPanel>

    <NewsroomTaskPanel key="editions" task="editions">
    <section className="newsroom-anchor newsroom-product-section" id={generationAnchorId} aria-labelledby="publication-generation-title">
      <PageHeader eyebrow="Current" title="Editions" titleId="publication-generation-title"
        description={<>Every edition for {publicationName}, from drafts to published releases. <Link href={activityHref}>Generation activity</Link></>}
        actions={<Link className="jw-button" href={newsroomHref(publicationId, "new-edition")}><Icon name="sparkle" />Add edition</Link>} />
      {error && <p className="alert" role="alert">{error}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}
      {noDraft && <div className="jw-card jw-empty jw-no-draft" role="status">
        <p><strong>No draft yet.</strong> There&apos;s no unpublished edition to open in the editor.</p>
        <Link className="jw-button" href={newsroomHref(publicationId, "new-edition")}><Icon name="sparkle" />Create a new edition</Link>
      </div>}
      {activeProgress}
      {finishedDraftLink}
      {!active && needsAttention && <p className="notice" role="status">
        Generation needs attention: failed or blocked work. <Link href={activityHref}>Inspect activity and recovery</Link>.
      </p>}
      {releasesError && <p className="alert" role="alert">Published dates couldn&apos;t be loaded: {releasesError}</p>}
      <section className="jw-card jw-table-card edition-selection" aria-label="Edition history">
        <div className="jw-table-tools">
          <label className="jw-search"><span className="visually-hidden">Search editions</span><Icon name="search" size={16} />
            <input type="search" placeholder="Search editions…" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
          <label className="jw-filter"><span className="visually-hidden">Filter by status</span>
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}>
              <option value="">Filter</option>
              {(Object.keys(EDITION_STATUS_LABELS) as EditionStatusKey[]).filter((key) => key !== "publishing")
                .map((key) => <option key={key} value={key}>{EDITION_STATUS_LABELS[key]}</option>)}
            </select></label>
        </div>
        <div className="jw-table-scroll">
          <table className="jw-table edition-navigation">
            <thead><tr><th scope="col">Edition</th><th scope="col">Content</th><th scope="col">Status</th><th scope="col">Published</th><th scope="col">Views <SampleTag /></th></tr></thead>
            <tbody>{visibleRows.map((row) => <tr key={row.item._id} aria-current={row.item._id === selectedDraftId ? "true" : undefined}>
              <td><a href={newsroomEditionHref(publicationId, row.item._id)} onClick={openEdition(row.item._id)}
                aria-label={`Open edition ${row.item.title || row.item.window.join(" to ")}`}>{row.title}</a>
                <br /><small>{formatEditionWindow(row.item.window)}{row.item.origin === "manual" ? " · Written" : row.item.generation_id ? " · Generated" : ""} · created {formatDate(row.item.created_at)}</small></td>
              <td>{row.item.story_count != null ? `${row.item.story_count} ${row.item.story_count === 1 ? "story" : "stories"}` : "—"}</td>
              <td><StatusPill status={row.status} /></td>
              <td>{row.release ? formatDate(row.release.publishedAt) : "—"}</td>
              <td>{row.status === "published" ? SAMPLE_ANALYTICS.editionViews[editionRows.filter((other) => other.status === "published").indexOf(row) % SAMPLE_ANALYTICS.editionViews.length].toLocaleString("en-US") : "—"}</td>
            </tr>)}</tbody>
          </table>
        </div>
        {!data.drafts.length && <div className="jw-empty"><p>No editions yet. Generate a draft or start writing.</p>
          <Link className="jw-button" href={newsroomHref(publicationId, "new-edition")}>New edition</Link></div>}
        {data.drafts.length > 0 && !visibleRows.length && <p className="jw-empty">No editions match this search.</p>}
        {(data.draftsNextCursor || data.drafts.length > 0) && <div className="jw-table-foot">
          <small>{visibleRows.length} of {data.drafts.length} loaded</small>
          {data.draftsNextCursor && <button type="button" className="secondary" disabled={historyBusy || switching} onClick={() => void loadOlderDrafts()}>{historyBusy ? "Loading…" : "Load older drafts"}</button>}
        </div>}
      </section>
    </section>
    </NewsroomTaskPanel>

    <NewsroomTaskPanel key="activity" task="activity">
      <section id="generation-activity" className="generation-recovery newsroom-product-section" aria-labelledby="newsroom-task-activity">
      <PageHeader eyebrow={<Link href={newsroomHref(publicationId, "editions")}>Editions</Link>} title="Generation activity and recovery"
        titleId="newsroom-task-activity" description="Follow each community's progress. Recovery never switches drafts or starts automatically." />
      {refreshError && <p className="alert" role="alert">Generation refresh failed: {refreshError}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}
      {!data.generations.length && <div className="jw-card jw-empty"><p>No generation activity for this newsroom.</p></div>}
      {selectedGenerationId !== null && !targetGeneration && <p className="alert" role="alert">The selected generation is unavailable. No other generation will receive recovery actions.</p>}
      {data.generations.length > 0 && <div className="panel">
        <label className="field">Generation to inspect or recover
          <select aria-label="Selected generation" value={targetGeneration?._id ?? ""} onChange={(event) => {
            const id = event.target.value;
            const url = new URL(window.location.href);
            url.searchParams.set("generation", id);
            window.history.pushState(window.history.state, "", url);
            setSelectedGenerationId(id);
          }}>
            {!targetGeneration && <option value="">Selected generation unavailable</option>}
            {data.generations.map((generation) => <option key={generation._id} value={generation._id}>
              {generation.window.join(" – ")} · {generation.status} · {operator ? generation._id.slice(0, 8) : new Date(generation.created_at * 1000).toLocaleString()}
            </option>)}
          </select>
        </label>
        <p>Recovery never switches drafts.</p>
      </div>}
      {targetGeneration && <div className="panel generation-progress">
        <h3>Generation {targetGeneration.status}: {targetGeneration.progress.total} communities</h3>
        <JobProgress label="Generate edition" activity={editionGenerationActivity(targetGeneration, clock / 1000)} refreshError={refreshError} />
        <p>{targetGeneration.progress.completed} of {targetGeneration.progress.total} community drafts ready. Completed results remain saved; unfinished work holds the newsroom slot.</p>
        {targetGeneration.error && <p className="alert" role="alert">{operator ? targetGeneration.error
          : "Generation needs attention. Completed community drafts are saved. Review recovery options below or ask an operator for help."}</p>}
        {recoveryError && <p className="alert" role="alert">{recoveryError}</p>}
        <ol className="generation-location-progress">
          {targetGeneration.children.map((child) => <li key={child._id}>
            <span><strong>{child.location_name}</strong><small>{operator
              ? child.execution_blocked?.reason || child.error || childLabel(child.status)
              : child.execution_blocked || child.error ? "This community needs attention. Review recovery options below or ask an operator for help." : childLabel(child.status)}</small>
              {child.execution_blocked?.resets_at && <small>Allowance resets {new Date(child.execution_blocked.resets_at * 1000).toUTCString()}</small>}
              {operator && <a href={`/edition-map?${new URLSearchParams({ location: child.location_id, run: child._id })}`}
                target="_blank" rel="noopener noreferrer">Edition map: read-only funnel / comparison (new tab)</a>}
            </span>
            <span className={`status-badge tone-${child.status === "built" ? "ok" : ["failed", "published"].includes(child.status) ? "failed" : ["collecting", "authoring", "finishing", "publishing"].includes(child.status) && !child.execution_blocked ? "running" : "idle"}`}>{childLabel(child.status)}</span>
          </li>)}
        </ol>
        {canWrite && !["ready", "cancelled"].includes(targetGeneration.status) && <div className="card-actions">
          {["blocked", "paused", "failed"].includes(targetGeneration.status) && <>
            <label className="field">Recovery funding<select value={funding} onChange={(event) => setFunding(event.target.value as typeof funding)}>
              <option value="">Retain existing funding where permitted; choose explicitly to change funding</option>
              {data.recovery?.managedFundingAllowed && <option value="platform">Deliberately sponsor with managed platform services</option>}
              {data.recovery?.personalFundingAllowed && <option value="personal">Deliberately use my own personal credentials</option>}
            </select></label>
            <label className="field">Reason for funding changes<input maxLength={300} value={recoveryReason} onChange={(event) => setRecoveryReason(event.target.value)} /></label>
            <button type="button" disabled={busy || targetGeneration.status === "failed"} onClick={() => void recover("resume")}>Authorize resume</button>
            <button type="button" disabled={busy} onClick={() => void recover("retry")}>Retry missing/failed work only</button>
            <p>Fresh authorization rechecks access, readiness, providers and today&apos;s allowance. Polling never reconnects work or resets charged calls.</p>
          </>}
          <button type="button" className="secondary" disabled={busy || targetGeneration.status === "cancelling"} onClick={() => void recover("cancel")}>
            {targetGeneration.status === "cancelling" ? "Waiting for executing work to settle…" : "Cancel this generation"}
          </button>
        </div>}
        {targetGeneration.status === "ready" && (() => {
          const ready = data.drafts.find((item) => item.generation_id === targetGeneration._id);
          return ready ? <p><a href={newsroomEditionHref(publicationId, ready._id)} onClick={openEdition(ready._id)}>Open the generated draft</a></p> : null;
        })()}
      </div>}
      </section>
    </NewsroomTaskPanel>

    <NewsroomTaskPanel key="edition-setup" task="new-edition">
    <section className="newsroom-product-section" aria-labelledby="new-edition-title">
      <PageHeader eyebrow="Create" title="Create a new edition" titleId="new-edition-title"
        description="Turn the week's most important local reporting into a complete Newsbee edition." />
      {error && <p className="alert" role="alert">{error}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}
      {activeProgress}
      <div className="jw-card jw-intro" hidden={setupStarted}>
        <div>
          <span className="jw-intro-mark"><Icon name="sparkle" size={22} /></span>
          <StatusPill status="editing">Get started</StatusPill>
          <h2>Create a new edition</h2>
          <p>Pick the communities and week, let Newsbee draft it or write it yourself, then review, approve and publish.</p>
          <button type="button" onClick={() => {
            setSetupStarted(true);
            window.requestAnimationFrame(() => document.getElementById("edition-setup-title")?.focus());
          }}>Get started<Icon name="arrow" size={14} /></button>
        </div>
        <ol className="jw-intro-steps">
          <li><span><strong>Choose communities and the week</strong><small>Pick Ready communities and the seven-day edition window, or request coverage.</small></span></li>
          <li><span><strong>Generate a draft or start writing</strong><small>Newsbee gathers local reporting and drafts stories, or you write from scratch.</small></span></li>
          <li><span><strong>Edit and send for approval</strong><small>Check sources, evidence and flags, then mark the edition ready for approval.</small></span></li>
          <li><span><strong>Approve and publish</strong><small>Approve the exact revision, then publish to the reader site. Videos come after.</small></span></li>
        </ol>
      </div>
      <form id={formId} className="jw-card generation-start newsroom-step-panel" onSubmit={confirmStart} hidden={!setupStarted}>
        <h2 id="edition-setup-title" tabIndex={-1}>Choose how to start</h2>
        <p>Choose Ready communities and the edition week for one combined draft. Generate with {data.execution?.funding === "managed" ? "Newsbee-managed services" : data.execution?.funding === "personal" ? "your personal provider keys" : "your account's provider settings"}, or start writing without provider calls. Both use the same editor, approval and explicit Publish.</p>
        <div className="generation-setup-grid">
          <fieldset disabled={!canWrite || busy}>
            <legend>Communities</legend>
            <p className="chart-caption">Choose up to {data.limits.maxLocations} communities marked Ready.</p>
            {data.locations.filter((location) => location.ready).length > data.limits.maxLocations && <p className="notice">Choose the communities for this edition explicitly; no subset has been selected for you.</p>}
            <div className="generation-location-grid">
              {data.locations.map((location) => <label className={location.ready ? "generation-location-choice" : "generation-location-choice unavailable"} key={location.location_id}>
                <input type="checkbox" disabled={!location.ready || (!selected.includes(location.location_id) && selected.length >= data.limits.maxLocations)}
                  checked={selected.includes(location.location_id)}
                  onChange={(event) => setSelected(event.target.checked
                    ? [...selected, location.location_id]
                    : selected.filter((id) => id !== location.location_id))} />
                <span><strong>{location.location_name}</strong><small>{location.ready ? "Ready" : location.missing_prerequisites.join(" ") || location.state}</small></span>
              </label>)}
            </div>
          </fieldset>
          <fieldset disabled={!canWrite || busy}>
            <legend>Edition week</legend>
            <div className="filters">
              <label className="field">Starts<input type="date" required value={dateWindow[0]} onChange={(event) => setDateWindow([event.target.value, addDays(event.target.value, 6)])} /></label>
              <label className="field">Ends<input type="date" required readOnly value={dateWindow[1]} /></label>
            </div>
            <p className="chart-caption">The combined edition covers exactly seven days.</p>
          </fieldset>
        </div>
        {!data.locations.length && <p className="notice">No communities are configured for this newsroom. Request coverage before starting an edition.</p>}
        {data.locations.length > 0 && !data.locations.some((location) => location.ready) && <p className="notice">Coverage is still preparing. Resolve the listed prerequisites before starting an edition.</p>}
        {coverageBlocked && <div className="coverage-remedies">
          {coverageError && <p className="alert" role="alert">Coverage request status unavailable: {coverageError}. Existing readiness requirements still apply.</p>}
          {coverageRequests && <>
            {!coverageRequests.locations.length && <p>
              {coverageRequests.request ? `Coverage request: ${coverageRequests.request.status}.` : "Ask an operator to configure newsroom coverage."}{" "}
              <button type="button" className="secondary" disabled={!canWrite || coverageBusy} onClick={() => void requestCoverage(null)}>{coverageRequests.request ? "Refresh coverage request" : "Request newsroom coverage"}</button>
            </p>}
            {coverageRequests.locations.filter((location) => !location.ready).map((location) => <p key={location.location_id}>
              <strong>{location.location_name}:</strong> {location.missing_prerequisites.join(" ")}{" "}
              {location.request && <span>Request: {location.request.status}. </span>}
              <button type="button" className="secondary" disabled={!canWrite || coverageBusy} onClick={() => void requestCoverage(location.location_id)}>{location.request ? "Refresh request" : "Request preparation"}</button>
            </p>)}
          </>}
        </div>}
        {options && <details className="generation-advanced">
          <summary>Generation preferences</summary>
          <div className="filters">
            <label className="field">Story discovery<select value={options.flow} onChange={(event) => setOptions({ ...options, flow: event.target.value as RunOptions["flow"] })}>
              <option value="current">Standard</option>
              <option value="agentic">Broader local search</option>
            </select></label>
            <label className="field">Story visuals<select value={options.image_mode ?? "illustrated"} onChange={(event) => setOptions({ ...options, image_mode: event.target.value as NonNullable<RunOptions["image_mode"]> })}>
              <option value="illustrated">Reviewed illustrations</option>
              <option value="current">Source photos when verified</option>
              <option value="agentic">Search and review photos</option>
            </select></label>
            <label className="field">Maximum stories per community<input type="number" min="1" value={options.story_limit ?? ""}
              onChange={(event) => setOptions({ ...options, story_limit: event.target.value ? Number(event.target.value) : null })} /></label>
          </div>
          <p className="chart-caption">{data.execution?.funding === "managed"
            ? "Newsbee-managed services are available to assigned Journalists. No personal API keys are required."
            : data.execution?.funding === "personal"
              ? "Administrators always use their own encrypted provider settings, including when assigned newsroom journalist rights. Missing keys never fall back to managed services."
              : "Owner deployed credentials are used by default; personal overrides still apply."}</p>
        </details>}
        {allowance && <p className="chart-caption">{allowance.source === "platform" ? "Managed allowance across newsrooms" : "Your account allowance"}: {allowance.remaining} calls remaining. Resets {new Date(allowance.resetsAt * 1000).toUTCString()}. Writing manually does not use this allowance.</p>}
        {allowance?.reasons?.length ? <p className="alert" role="alert">{allowance.reasons.join(" ")}</p> : null}
        {allowanceError && <p className="alert" role="alert">Generation preflight unavailable: {allowanceError}. Start writing does not require provider keys, generation allowance or shared capacity.</p>}
        {allowance?.reasons?.length && data.execution?.funding !== "managed" ? <p><Link href={`${newsroomHref(publicationId, "settings")}#api-keys`}>Open your personal API keys</Link></p> : null}
        {allowance && !allowance.admission.available && <p className="notice" role="status">{allowance.admission.detail}</p>}
        {!allowance && !allowanceError && <p role="status">Checking generation funding, allowance and shared availability…</p>}
        {allowance?.admission.available && <p className="chart-caption" role="status">Shared capacity is available now. Availability is checked again when you submit; no place is reserved.</p>}
        <button type="button" className="secondary" onClick={() => setPreflightRevision((value) => value + 1)}>Recheck availability</button>
        {active && <p className="notice">Generation is already in progress. You can still start a separate writing draft.</p>}
        {canWrite && !publicationEnabled && <p className="notice" role="status">This newsroom is paused, so Generate draft and Start writing are off. An owner can resume it in Operations.</p>}
        {canWrite
          ? <div className="card-actions">
            <button type="submit" disabled={!canStart || busy}>{busy ? "Starting…" : "Generate draft"}</button>
            <button type="button" className="secondary" disabled={!canStartWriting || busy} onClick={() => void startWriting()}>Start writing</button>
          </div>
          : <p className="notice">This workspace is read-only. Active publication-bound support is required for operator changes.</p>}
      </form>
      {targetGeneration?.status === "failed" && <p className="alert" role="alert">{operator && targetGeneration.error
        ? targetGeneration.error : <>The combined draft could not be completed. <Link href={activityHref}>Review activity and recovery</Link>.</>}</p>}
      {confirmOpen && <ConfirmGeneration window={dateWindow} coverage={selectedCoverage || publicationName}
        onCancel={() => setConfirmOpen(false)} onConfirm={() => void start()} />}
    </section>
    </NewsroomTaskPanel>

    <NewsroomTaskPanel key="edition-editor" task="writing">
    <section className="newsroom-anchor newsroom-product-section editorial-selected-edition" id={reportingAnchorId}
      inert={busy || switching || task !== "writing"}
      aria-labelledby="reporting-title">
      <h2 id="reporting-title" className="visually-hidden">Selected edition</h2>
      {draft
        ? <PublicationEditorialWorkspace key={`${publicationId}:${draft._id}`} publicationId={publicationId} draftId={draft._id}
          beforeDraftChange={beforeDraftChange} onSelectDraft={(id) => chooseDraft(id, false, true)}
          canWrite={canWrite} task={task} onDraftChange={updateSelectedDraft} />
        : selectedDraftId !== undefined ? <div className="jw-card"><p className="alert" role="alert">
          The selected draft is unavailable or still loading. No other draft is open for editing or publication. <Link href={newsroomHref(publicationId, "editions")}>Choose an available edition</Link>.
        </p><button type="button" className="secondary" onClick={() => void load()}>Retry selected draft</button></div>
        : <div className="jw-card jw-empty"><p>Choose an edition to edit.</p><Link className="jw-button" href={newsroomHref(publicationId, "editions")}>Go to editions</Link></div>}
    </section>
    </NewsroomTaskPanel>
  </>;
}

/** Frame 02: confirm before starting a long generation. */
function ConfirmGeneration({ window: editionWindow, coverage, onCancel, onConfirm }: {
  window: [string, string]; coverage: string; onCancel: () => void; onConfirm: () => void;
}) {
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    confirm.current?.focus();
    return () => previous?.focus?.();
  }, []);
  return <div className="jw-modal-backdrop" onKeyDown={(event) => { if (event.key === "Escape") onCancel(); }}>
    <div className="jw-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-generation-title" aria-describedby="confirm-generation-copy">
      <button type="button" className="jw-modal-close" aria-label="Close" onClick={onCancel}><Icon name="close" size={16} /></button>
      <div className="jw-modal-body">
        <span className="jw-intro-mark"><Icon name="sparkle" size={20} /></span>
        <p className="jw-eyebrow">Confirm generation</p>
        <h2 id="confirm-generation-title">New edition</h2>
        <p id="confirm-generation-copy">This starts generating the {formatEditionWindow(editionWindow)} edition for <strong>{coverage}</strong>. You can leave this page and follow progress from the Overview.</p>
        <div className="jw-estimate"><Icon name="clock" /><p><strong>How long it takes</strong><br /><small>It depends on each community&apos;s sources, so there&apos;s no fixed estimate. Each community&apos;s progress shows as it runs.</small></p></div>
        <div className="jw-modal-actions">
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
          <button type="button" ref={confirm} onClick={onConfirm}>Start generation<Icon name="arrow" size={14} /></button>
        </div>
      </div>
    </div>
  </div>;
}
