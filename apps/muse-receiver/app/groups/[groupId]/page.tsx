"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

type Group = { id: string; name: string; url: string; createdAt: string };
type Post = {
  key: string;
  id: string;
  text: string;
  permalink?: string;
  publishedAt?: string;
  observedAt: string;
  rawTime?: string;
  commentCount?: number | null;
  reactions?: { total?: number | null; kinds: string[]; counts: Record<string, number> };
  sourceLinks: string[];
  contentVerified?: boolean;
  truncated?: boolean;
  foundIn: string[];
  lastSeenAt: string;
};
type Report = {
  id: string;
  runTime: string;
  status: string;
  createdAt: string;
  chronologicalStatus: string;
  recentActivityStatus: string;
  issues: string[];
};
type Feed = { posts: Post[]; reports: Report[]; page: number; hasMore: boolean };
type Prompt = { prompt: string; reportUrl: string };

function message(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

async function getJson<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, cache: "no-store" });
  if (!response.ok) throw new Error(`Request failed (${response.status}). Please try again.`);
  return (await response.json()) as T;
}

function dateLabel(value?: string): string {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function safeUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export default function GroupPage() {
  const params = useParams<{ groupId: string }>();
  const groupId = params.groupId;
  const apiPath = `/api/groups/${encodeURIComponent(groupId)}`;
  const [refresh, setRefresh] = useState(0);
  const [page, setPage] = useState(0);
  const [group, setGroup] = useState<Group | null>(null);
  const [feed, setFeed] = useState<Feed | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [groupLoading, setGroupLoading] = useState(true);
  const [feedLoading, setFeedLoading] = useState(true);
  const [promptLoading, setPromptLoading] = useState(true);
  const [groupError, setGroupError] = useState("");
  const [feedError, setFeedError] = useState("");
  const [promptError, setPromptError] = useState("");
  const [copyState, setCopyState] = useState("");
  const [exportError, setExportError] = useState("");
  const [exporting, setExporting] = useState(false);

  useEffect(() => { setPage(0); }, [apiPath]);

  useEffect(() => {
    const controller = new AbortController();
    setGroupLoading(true);
    setPromptLoading(true);
    setGroupError("");
    setPromptError("");
    setCopyState("");
    getJson<{ group: Group }>(apiPath, controller.signal)
      .then((result) => setGroup(result.group))
      .catch((error: unknown) => { if (!controller.signal.aborted) setGroupError(message(error)); })
      .finally(() => { if (!controller.signal.aborted) setGroupLoading(false); });
    getJson<Prompt>(`${apiPath}/prompt`, controller.signal)
      .then(setPrompt)
      .catch((error: unknown) => { if (!controller.signal.aborted) setPromptError(message(error)); })
      .finally(() => { if (!controller.signal.aborted) setPromptLoading(false); });
    return () => controller.abort();
  }, [apiPath, refresh]);

  useEffect(() => {
    const controller = new AbortController();
    setFeedLoading(true);
    setFeedError("");
    getJson<Feed>(`${apiPath}/posts?page=${page}`, controller.signal)
      .then(setFeed)
      .catch((error: unknown) => { if (!controller.signal.aborted) setFeedError(message(error)); })
      .finally(() => { if (!controller.signal.aborted) setFeedLoading(false); });
    return () => controller.abort();
  }, [apiPath, page, refresh]);

  function goToPage(nextPage: number) {
    setFeedLoading(true);
    setPage(nextPage);
  }

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopyState(`${label} copied to clipboard.`);
    } catch {
      setCopyState(`Could not copy ${label.toLowerCase()}. Select the text and copy it manually.`);
    }
  }

  async function exportJson() {
    if (exporting) return;
    setExporting(true);
    setExportError("");
    try {
      const response = await fetch(`${apiPath}/export`, { cache: "no-store" });
      if (!response.ok) throw new Error(`Export failed (${response.status}). Please try again.`);
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = `muse-${groupId.replace(/[^a-zA-Z0-9_-]/g, "_")}-export.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch (error) {
      setExportError(message(error));
    } finally {
      setExporting(false);
    }
  }

  const groupUrl = safeUrl(group?.url);
  return (
    <div className="app-shell">
      <header className="site-header"><Link className="brand" href="/" aria-label="Muse Receiver home"><span className="brand-mark" aria-hidden="true">m</span><span>Muse <strong>Receiver</strong></span></Link><Link className="header-back" href="/">← All groups</Link></header>
      <main className="page-wrap detail-wrap">
        <Link href="/" className="breadcrumb">← Back to groups</Link>
        {groupLoading ? <section className="detail-intro"><span className="eyebrow">GROUP WORKSPACE</span><div className="state-inline" role="status"><span className="spinner" aria-hidden="true" /> Loading group…</div></section> : groupError || !group ? <section className="panel state-block state-error" role="alert"><strong>Could not open this group</strong><p>{groupError || "Group not found."}</p><button className="text-button" type="button" onClick={() => setRefresh((value) => value + 1)}>Try again →</button></section> : <>
          <section className="detail-intro"><span className="eyebrow"><span className="eyebrow-line" /> GROUP WORKSPACE</span><div className="detail-title-row"><div><h1>{group.name}</h1><p className="detail-subtitle">A place for Muse observations and their source reports.</p></div><button type="button" className="button button-outline refresh-button" onClick={() => setRefresh((value) => value + 1)}>↻ <span>Refresh</span></button></div><div className="group-meta"><span>ADDED {dateLabel(group.createdAt)}</span>{groupUrl && <a href={groupUrl} target="_blank" rel="noopener noreferrer" className="external-link">View Facebook group ↗</a>}</div></section>
          <aside className="notice" role="note" aria-label="Privacy and access warning"><span className="notice-icon" aria-hidden="true">!</span><div><strong>Public endpoint · No authentication</strong><p>Groups, posts, and exports are publicly readable, and anyone can submit reports; submissions are not independently verified. Do not deploy private-group content without access controls and approval.</p></div></aside>
          <div className="detail-grid">
            <section className="panel prompt-panel" aria-labelledby="prompt-title"><div className="panel-heading"><span className="section-index">01 / INSTRUCTIONS</span><h2 id="prompt-title">Muse prompt</h2><p>Copy this exact prompt for Muse. Scheduling and sending reports require separate authorized tools.</p></div>
              {promptLoading ? <div className="state-block" role="status"><span className="spinner" aria-hidden="true" /> Loading prompt…</div> : promptError || !prompt ? <div className="state-block state-error" role="alert"><strong>Prompt unavailable</strong><p>{promptError || "No prompt was returned."}</p><button className="text-button" type="button" onClick={() => setRefresh((value) => value + 1)}>Try again →</button></div> : <><div className="prompt-topline"><span>READY TO COPY · EXACT TEXT</span><button className="button button-primary button-small" type="button" onClick={() => copy(prompt.prompt, "Prompt")}>Copy prompt <span aria-hidden="true">⧉</span></button></div><pre className="prompt-text">{prompt.prompt}</pre><div className="endpoint"><span className="endpoint-label">REPORTING ENDPOINT</span><div className="endpoint-row"><code>{prompt.reportUrl}</code><button className="text-button" type="button" onClick={() => copy(prompt.reportUrl, "Reporting URL")}>Copy URL</button></div></div><p className="field-hint" role="status" aria-live="polite">{copyState || "The prompt above is displayed verbatim from the server; copying does not change it."}</p></>}
            </section>
            <aside className="panel workflow-panel"><span className="section-index">HOW IT WORKS</span><h2>From group to insight.</h2><ol className="steps"><li><span>01</span><p>Copy the exact prompt and give it to Muse.</p></li><li><span>02</span><p>Set up an external hourly scheduler and an authorized HTTP-capable sender to submit Muse’s reports to this endpoint.</p></li><li><span>03</span><p>Review posts and reports here, or export the JSON.</p></li></ol><div className="workflow-note">The prompt alone cannot schedule or send reports. This workspace only receives them; it does not create or publish Facebook posts.</div></aside>
          </div>
          <section className="posts-section" aria-labelledby="posts-title"><div className="section-heading"><div><span className="section-index">02 / OBSERVATIONS</span><h2 id="posts-title">Reported posts <span className="heading-count">{feed && !feedLoading ? feed.posts.length : "—"}</span></h2><p>Posts as received from Muse. Check source links before relying on a report.</p></div><button className="button button-outline" type="button" onClick={exportJson} disabled={exporting}>{exporting ? "Preparing export…" : "Export JSON ↓"}</button></div>{exportError && <p className="form-message error-text" role="alert">{exportError}</p>}
            {feedLoading ? <div className="panel state-block" role="status"><span className="spinner" aria-hidden="true" /> Loading posts…</div> : feedError || !feed ? <div className="panel state-block state-error" role="alert"><strong>Posts unavailable</strong><p>{feedError || "No post data was returned."}</p><button className="text-button" type="button" onClick={() => setRefresh((value) => value + 1)}>Try again →</button></div> : feed.posts.length === 0 ? <div className="panel state-block state-empty"><span className="empty-glyph" aria-hidden="true">✳</span><strong>{page === 0 ? "No posts reported yet" : "No posts on this page"}</strong><p>{page === 0 ? "Once Muse sends a report to this group’s endpoint, its posts will appear here." : "Go back to the previous page to review earlier results."}</p></div> : <div className="post-list">{feed.posts.map((post) => <article className="panel post-card" key={post.key}><div className="post-topline"><span className="post-mark" aria-hidden="true">✳</span><span>OBSERVED {dateLabel(post.observedAt)}</span><span className={post.contentVerified === true ? "status-pill verified" : "status-pill"}>{post.contentVerified === true ? "Verified content" : "Unverified content"}</span></div><p className="post-text">{post.text || "No text captured for this post."}</p>{post.truncated && <p className="post-caution">Text may be truncated; check the original source.</p>}<div className="post-facts"><span>Published: {post.publishedAt ? dateLabel(post.publishedAt) : post.rawTime || "Unknown"}</span><span>Last seen: {dateLabel(post.lastSeenAt)}</span>{post.foundIn.length > 0 && <span>Found in: {post.foundIn.join(", ")}</span>}<span>Comments: {post.commentCount == null ? "Unknown" : post.commentCount}</span><span>Reactions: {post.reactions?.total == null ? "Unknown" : post.reactions.total}</span>{post.reactions && Object.entries(post.reactions.counts).length > 0 && <span>By type: {Object.entries(post.reactions.counts).map(([kind, count]) => `${kind} ${count}`).join(", ")}</span>}</div>{post.sourceLinks.length > 0 && <div className="post-sources"><span>SOURCE LINKS</span>{post.sourceLinks.map((source, index) => safeUrl(source) ? <a key={`${source}-${index}`} href={safeUrl(source)} target="_blank" rel="noopener noreferrer">Source {index + 1} ↗</a> : <span key={`${source}-${index}`} className="invalid-link">Invalid source link</span>)}</div>}{safeUrl(post.permalink) && <a className="post-permalink" href={safeUrl(post.permalink)} target="_blank" rel="noopener noreferrer">View original post ↗</a>}</article>)}</div>}
            <nav className="pagination" aria-label="Post pages">
              <button className="button button-outline" type="button" onClick={() => goToPage(page - 1)} disabled={feedLoading || page === 0}>← Previous</button>
              <span aria-live="polite">Page {page + 1}</span>
              <button className="button button-outline" type="button" onClick={() => goToPage(page + 1)} disabled={feedLoading || !!feedError || !feed || feed.page !== page || !feed.hasMore}>Next →</button>
            </nav>
          </section>
          <section className="reports-section" aria-labelledby="reports-title">
            <div className="section-heading"><div><span className="section-index">03 / INGESTION LOG</span><h2 id="reports-title">Recent reports <span className="heading-count">{feed && !feedLoading ? feed.reports.length : "—"}</span></h2><p>A record of what Muse submitted, including incomplete runs.</p></div></div>
            {feedLoading ? <div className="panel state-block" role="status"><span className="spinner" aria-hidden="true" /> Loading reports…</div> : feedError || !feed ? <div className="panel state-block state-error" role="alert"><strong>Reports unavailable</strong><p>{feedError || "No report data was returned."}</p><button className="text-button" type="button" onClick={() => setRefresh((value) => value + 1)}>Try again →</button></div> : feed.reports.length === 0 ? <div className="panel state-block state-empty"><strong>No reports yet</strong><p>Reports will show up here after the first submission.</p></div> : <ul className="report-list">{feed.reports.map((report) => <li className="panel report-card" key={report.id}><div className="report-main"><strong>{report.status}</strong><time dateTime={report.createdAt}>{dateLabel(report.createdAt)}</time></div><div className="report-details"><span>Run: {dateLabel(report.runTime)}</span><span>Chronological: {report.chronologicalStatus}</span><span>Recent activity: {report.recentActivityStatus}</span></div>{report.issues.length > 0 && <ul className="report-issues">{report.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>}</li>)}</ul>}
          </section>
        </>}
      </main><footer className="site-footer"><span>MUSE RECEIVER</span><span>Observe responsibly. Share intentionally.</span></footer>
    </div>
  );
}
