// Journalist workspace routes. Each view has a real URL under /newsroom/[publicationId];
// the older single-page hash links keep working through legacyNewsroomTarget.

export type NewsroomTask = "overview" | "inbox" | "new-edition" | "collect-sources" | "editions" | "edition-editor" | "writing" | "activity" | "source-map" | "videos" | "new-video" | "analytics" | "admin" | "settings";
export type NewsroomView = Exclude<NewsroomTask, "writing">;

const VIEW_SEGMENTS: Record<NewsroomView, string> = {
  overview: "",
  inbox: "/inbox",
  "new-edition": "/new-edition",
  "collect-sources": "/source-map/collect",
  "source-map": "/source-map",
  "new-video": "/new-video",
  analytics: "/analytics",
  /** Newsroom admin: read-only service status for everyone; links into Operations for operators. */
  admin: "/admin",
  editions: "/editions",
  activity: "/generation",
  /** Story videos, campaigns and channels, as tabs. */
  videos: "/videos",
  /** Opens the newsroom's current draft, or Editions when there is none. */
  "edition-editor": "/edition-editor",
  settings: "/settings",
};

export const NEWSROOM_TASK_LABELS: Record<NewsroomTask, string> = {
  overview: "Overview",
  inbox: "Inbox",
  "new-edition": "New edition",
  "collect-sources": "New source map",
  "source-map": "Source map",
  "new-video": "New video",
  analytics: "Analytics",
  admin: "Newsroom admin",
  editions: "Editions",
  writing: "Edition editor",
  activity: "Generation activity",
  videos: "Videos",
  "edition-editor": "Edition editor",
  settings: "Settings",
};

export function newsroomBase(publicationId: string) {
  return `/newsroom/${encodeURIComponent(publicationId)}`;
}

export function newsroomHref(publicationId: string, view: NewsroomView, search = "") {
  return `${newsroomBase(publicationId)}${VIEW_SEGMENTS[view]}${search}`;
}

export function newsroomEditionHref(publicationId: string, draftId: string, hash = "") {
  return `${newsroomBase(publicationId)}/editions/${encodeURIComponent(draftId)}${hash}`;
}

export function newsroomReleaseHref(publicationId: string, releaseId: string, storyId?: string) {
  const release = `${newsroomBase(publicationId)}/releases/${encodeURIComponent(releaseId)}`;
  return storyId ? `${release}/video/${encodeURIComponent(storyId)}` : release;
}

/**
 * One community's shared source map inside a newsroom: Current sources, or its Collection runs. "review" is the
 * older Review & decide tab, now part of Current sources.
 */
export function sourceMapHref(publicationId: string, location: string, tab: "sources" | "review" | "runs" = "sources", run?: string | null) {
  const query = new URLSearchParams({ location, ...(tab === "runs" ? { tab } : {}), ...(run ? { run } : {}) });
  return `${newsroomBase(publicationId)}/source-map?${query}`;
}

/** The selected draft named by an editor URL, if any. */
export function draftIdForPath(pathname: string, base: string) {
  const match = pathname.startsWith(`${base}/editions/`) ? /^\/editions\/([^/]+)\/?$/.exec(pathname.slice(base.length)) : null;
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/** The view for a path inside one newsroom. Returns null for the base path, whose view comes from its hash. */
export function newsroomTaskForPath(pathname: string, base: string): NewsroomTask | null {
  const rest = pathname.startsWith(base) ? pathname.slice(base.length).replace(/\/$/, "") : null;
  if (rest === null || rest === "") return null;
  if (rest === "/new-edition") return "new-edition";
  if (rest === "/inbox") return "inbox";
  if (rest === "/source-map/collect") return "collect-sources";
  if (rest === "/source-map") return "source-map";
  if (rest === "/analytics") return "analytics";
  if (rest === "/new-video" || rest === "/channels/new") return "new-video";
  if (rest === "/admin") return "admin";
  if (rest === "/editions") return "editions";
  if (draftIdForPath(pathname, base) !== undefined) return "writing";
  if (rest === "/generation") return "activity";
  // Story videos, campaigns and channels share one Videos area; Video Studio opens from it.
  if (rest === "/videos" || rest === "/channels" || rest.startsWith("/releases/")) return "videos";
  if (rest === "/edition-editor") return "writing";
  if (rest === "/settings") return "settings";
  return "overview";
}

/** Maps a hash from the older single-page newsroom onto the view that now owns it. */
export function newsroomTaskForHash(hash: string): NewsroomTask {
  const anchor = hash.replace(/^#/, "");
  if (anchor === "home" || anchor === "overview" || !anchor) return "overview";
  if (anchor === "editions") return "editions";
  if (anchor === "new-edition") return "new-edition";
  if (anchor === "generation-activity") return "activity";
  if (anchor === "videos") return "videos";
  if (anchor === "audience" || anchor === "delivery") return "settings";
  if (anchor === "settings" || anchor === "settings-title" || anchor === "api-keys") return "settings";
  if (anchor === "reporting" || anchor === "reporting-title" || anchor === "story-workspace-title") return "writing";
  if (anchor.startsWith("publication-release-history") ||
    anchor === "editorial-workspace-title" || anchor === "editorial-preview-title" ||
    anchor === "editorial-publish-title" || anchor === "editorial-review-title" || anchor === "editorial-original-reporting-title" ||
    anchor === "edition-headline" || anchor === "edition-intro" || anchor.startsWith("edition-story-") ||
    /^edition-(sources|section|locations|byline|image)-/.test(anchor)) return "writing";
  return "overview";
}

/**
 * Where an older newsroom link (`/newsroom/[id]?draft=…#anchor`) now lives, or null when it
 * already belongs on Overview. Query values other than `draft` are kept.
 */
export function legacyNewsroomTarget(publicationId: string, search: string, hash: string) {
  const query = new URLSearchParams(search);
  const draft = query.get("draft");
  query.delete("draft");
  const hashTask = newsroomTaskForHash(hash);
  const task = hashTask === "overview" && !draft && query.has("generation") ? "activity" : hashTask;
  if (task === "overview" && !draft) return null;
  const rest = query.size ? `?${query}` : "";
  const keepHash = hash && hash !== "#editions" && hash !== "#settings" && hash !== "#generation-activity" && hash !== "#videos" && hash !== "#new-edition"
    ? hash : "";
  if (draft && (task === "writing" || task === "overview" || task === "editions")) {
    return `${newsroomEditionHref(publicationId, draft)}${rest}${task === "writing" ? keepHash : ""}`;
  }
  if (task === "writing") return newsroomHref(publicationId, "editions", rest);
  if (task === "settings") return `${newsroomHref(publicationId, "settings", rest)}${keepHash}`;
  return newsroomHref(publicationId, task as NewsroomView, rest);
}
