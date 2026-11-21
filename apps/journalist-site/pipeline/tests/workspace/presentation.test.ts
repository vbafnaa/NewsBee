import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { expect, it, vi } from "vitest";
import AccountSettings from "../../../app/account/settings";
import { ExecutionNotice, RunExecutionSummary, type ExecutionPolicy } from "../../../app/components/execution-policy";
import { ReviewCells, ReviewKey } from "../../../app/locations/[locationId]/source-map-manager";
import { CurrentRuns } from "../../../app/locations/current-runs";
import LocationDirectory from "../../../app/locations/location-directory";
import LocationOnboarding from "../../../app/location-onboarding";
import { rebasePendingDraft } from "../../../app/publishing/publication-editorial-workspace";
import type { PublicationDraft } from "../../publications/generation";

const source = (path: string) => readFile(new URL(`../../../app/${path}`, import.meta.url), "utf8");
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

it("rebases pending editorial fields onto concurrent server presentation changes", () => {
  const latest = {
    revision: 7,
    presentation: {
      headline: "Server headline",
      intro: "Concurrent server introduction",
      sections: [{ id: "news", title: "Server section" }],
      section_order: ["news"],
      stories: [{
        id: "story",
        origin: "generated",
        generated_story_id: "story",
        section_id: "news",
        headline: "Concurrent server story headline",
        body: "Server body",
        byline: "",
        location_tags: ["north"],
        source_metadata: [],
        image_id: null,
      }],
      story_order: ["story"],
    },
  } as PublicationDraft;
  const rebased = rebasePendingDraft(latest, [
    { operation: { type: "draft", headline: "Local pending headline" }, syncPresentation: false },
    { operation: { type: "story", storyId: "story", body: "Local pending body" }, syncPresentation: false },
  ]);
  expect(rebased.revision).toBe(7);
  expect(rebased.presentation).toMatchObject({
    headline: "Local pending headline",
    intro: "Concurrent server introduction",
    stories: [{
      headline: "Concurrent server story headline",
      body: "Local pending body",
    }],
  });
});

it("puts all current runs above locations and links each run to its own workspace tab", async () => {
  const directory = await source("locations/location-directory.tsx");
  expect(directory.indexOf("Location requests and readiness")).toBeLessThan(directory.indexOf("<CurrentRuns"));
  expect(directory.indexOf("<CurrentRuns")).toBeLessThan(directory.indexOf("<h2>Locations</h2>"));
  const runs = [
    { _id: "map /1", location_id: "north /1", location_name: "North", kind: "map" as const, status: "mapping" as const, created_at: 1_700_000_000 },
    { _id: "edition-2", location_id: "south", location_name: "South", status: "awaiting_authoring" as const, created_at: 1_700_000_001, execution_blocked: { reason: "keys", at: 1 } },
  ];
  const { document } = parseHTML(renderToStaticMarkup(createElement(CurrentRuns, { runs, error: "", onRefresh: () => {} })));
  expect(document.querySelector('a[href="/locations/north%20%2F1?tab=collect-sources&run=map%20%2F1"]')?.textContent).toBe("North");
  expect(document.querySelector('a[href="/locations/south?tab=edition&run=edition-2"]')?.textContent).toBe("South");
  expect(document.querySelectorAll(".location-directory-row").length).toBe(2);
  expect(document.querySelector(".location-directory-row:last-child .status-badge")?.textContent).toContain("Paused · awaiting authoring");
  expect(document.querySelector("button")?.textContent).toBe("Refresh runs");
  expect(parseHTML(renderToStaticMarkup(createElement(CurrentRuns, { runs: [], error: "", onRefresh: () => {} }))).document.querySelector(".current-runs > p")?.textContent).toBe("No runs in progress.");
});

it("presents source refresh before edition creation, with no approval requests beside them", async () => {
  const dashboard = await source("dashboard.tsx");
  const actions = dashboard.slice(dashboard.indexOf('<div className="card-actions">', dashboard.indexOf('className="run-card"')));
  expect(actions.indexOf(">Refresh source map</ExplainedButton>")).toBeGreaterThan(0);
  expect(actions.indexOf('"Collect stories"}</ExplainedButton>')).toBeGreaterThan(0);
  expect(actions.indexOf(">Refresh source map</ExplainedButton>")).toBeLessThan(actions.indexOf('"Collect stories"}</ExplainedButton>'));
  expect(actions).toContain('map-run`, { method: "POST", body: JSON.stringify({ options: runOptions, rebuild: true })');
  expect(actions).toContain('ingestion`, { method: "POST", body: JSON.stringify({ options: runOptions })');
  expect(dashboard).not.toContain("PipelineApprovals");
});

it("lays out each run's main settings, opens paid services and keeps relaxed-rule warnings outside disclosures", async () => {
  const panel = await source("components/run-options-panel.tsx");
  const firstDetails = panel.indexOf("<details");
  expect(panel).not.toContain("Run purpose");
  for (const label of ["Run mode", "Edition flow", "Source map method", "Guardrails", "Access"]) expect(panel.indexOf(`label="${label}"`), label).toBeLessThan(firstDetails);
  expect(panel).toMatch(/<details className="location-settings" open>\s+<summary>Paid services:/);
  expect(panel).toContain("options.paid[service.id]} calls");
  expect(panel).toContain("options.guardrails_off.length");
  expect(panel.indexOf("{loosened && <p")).toBeLessThan(firstDetails);
});

it("shows who started a managed run and its funding source, with no run purpose", () => {
  const { document } = parseHTML(renderToStaticMarkup(createElement(RunExecutionSummary, { run: {
    execution: { sponsorId: "editor", initiatedBy: "editor", credentialVersion: 0, source: "platform", planHash: "plan" },
    trigger: { by: "editor@example.test" },
  } })));
  const summary = document.querySelector('[aria-label="Run execution funding"]')!;
  expect(summary.closest("details")).toBeNull();
  expect(summary.textContent).toContain("editor@example.test");
  expect(summary.textContent).toContain("Newsbee-managed providers");
  expect(summary.textContent).not.toContain("API settings version");
  for (const gone of ["Final", "Training", "Test", "Admin"]) expect(summary.textContent).not.toContain(gone);
});

it("keeps execution blockers and reconnect guidance visible", () => {
  const policy: ExecutionPolicy = {
    principal: { id: "editor", email: "editor@example.test", role: "editor" },
    reasons: ["Managed model unavailable."], editionReasons: [], mapReasons: [],
    canStart: false, canStartEdition: false, canStartMap: false,
    blocker: { id: "busy", locationId: "other", locationName: "Other desk", status: "awaiting_finish", paused: null,
      kind: "run", publicationGenerationId: null, href: "/locations/other?tab=edition&run=busy" },
    permissions: { busy: { canSpend: false, canRestart: false, restartReason: null, canReconnect: true, canClaim: false, reason: "API settings changed.", paused: null } },
  };
  const { document } = parseHTML(renderToStaticMarkup(createElement(ExecutionNotice, { policy, runId: "busy" })));
  expect(document.querySelector("details")).toBeNull();
  const notice = document.querySelector('[aria-label="Execution access"]')?.textContent ?? "";
  expect(notice).toContain("Journalists do not need personal API keys");
  expect(notice).toContain("workspace operator");
  expect(notice).not.toContain("Admin");
  expect(document.querySelector('a[href="/locations/other?tab=edition&run=busy"]')?.textContent).toBe("Other desk");
  expect(document.querySelector("button")?.textContent).toContain("Reconnect this run");
  const compact = parseHTML(renderToStaticMarkup(createElement(ExecutionNotice, { policy, runId: "busy", compact: true }))).document;
  expect(compact.querySelector("details")).toBeNull();
  expect(compact.querySelector("section")?.textContent).toContain("Managed model unavailable.");
  expect(compact.querySelector("button")?.textContent).toContain("Reconnect this run");
  expect(compact.querySelector("section")?.textContent).not.toContain("Journalists do not need personal API keys");
});

it("omits healthy compact execution copy without hiding loading or errors", () => {
  const policy: ExecutionPolicy = {
    principal: { id: "owner", email: "owner@example.test", role: "owner" },
    reasons: [], editionReasons: [], mapReasons: [],
    canStart: true, canStartEdition: true, canStartMap: true,
    blocker: null, permissions: {},
  };
  expect(renderToStaticMarkup(createElement(ExecutionNotice, { policy, compact: true }))).toBe("");
  const loading = parseHTML(renderToStaticMarkup(createElement(ExecutionNotice, { policy: null, compact: true }))).document;
  expect(loading.querySelector('[role="status"]')?.textContent).toContain("Checking execution access");
  const failed = parseHTML(renderToStaticMarkup(createElement(ExecutionNotice, { policy, error: "Policy unavailable", compact: true }))).document;
  expect(failed.querySelector('[role="alert"]')?.textContent).toBe("Policy unavailable");
});

it("removes repeated shell hints and location heading without removing navigation or the skip link", async () => {
  const [shell, navigation, tabs] = await Promise.all([source("admin-shell.tsx"), source("admin-navigation.tsx"), source("locations/[locationId]/location-tabs.tsx")]);
  expect(shell).not.toContain("item.hint");
  expect(navigation).toContain('aria-label="Admin navigation"');
  expect(shell).toContain('href="#workspace-content"');
  expect(navigation).toContain('aria-current={item.current ? "page" : undefined}');
  expect(tabs).not.toContain("<h2>{name}</h2>");
  expect(tabs).toContain("Collects source items, ranks and writes stories");
});
it("uses the account's own profile status instead of repeating global readiness and operator instructions", async () => {
  const [shell, account] = await Promise.all([source("admin-shell.tsx"), source("account/settings.tsx")]);
  expect(shell).toContain('page !== "account"');
  expect(shell).toContain("Newsbee-managed providers");
  expect(account).toContain("No profile. Add your own API keys.");
  expect(account).not.toContain("Set NEWSBEE_OWNER_EMAIL on the server");
  expect(account).not.toContain("Ask your administrator to complete owner setup");
  expect(account).toContain("Configuration checks only; no provider calls.");
  expect(account).toContain("A personal profile uses only the keys you save here.");
  expect(account).not.toContain("Your profile uses server environment keys.");
  expect(account).toContain('setSource(owner ? value?.source ?? "environment" : "personal")');
  expect(account).not.toContain('placeholder={defaultKey ? "****"');
  expect(account).toContain("Revoke disables the entire profile");
});

it("offers the server credential selector only to the configured owner", () => {
  const editor = parseHTML(renderToStaticMarkup(createElement(AccountSettings, { owner: false }))).document;
  expect(editor.querySelector('option[value="environment"]')).toBeNull();
  expect(editor.querySelector(".panel")?.textContent).not.toContain("opt in");
  const owner = parseHTML(renderToStaticMarkup(createElement(AccountSettings, { owner: true }))).document;
  expect(owner.querySelector('option[value="environment"]')?.textContent).toBe("Use API keys from server environment");
});

it("explains Decision and Reasoning separately from operational Pause and Resume", async () => {
  const { document } = parseHTML(renderToStaticMarkup(createElement(ReviewKey)));
  expect([...document.querySelectorAll("dt")].map((term) => term.textContent)).toEqual(["Decision", "Reasoning"]);
  const text = (term: string) => [...document.querySelectorAll("dt")].find((dt) => dt.textContent === term)!.nextElementSibling!.textContent!;
  expect(text("Decision")).toContain("Your recorded verdict");
  expect(text("Decision")).toContain("Access restrictions still apply");
  expect(text("Decision")).toContain("without changing review or training labels");
  expect(text("Reasoning")).toContain("Changes nothing on its own");
  const [manager, runs] = await Promise.all([source("locations/[locationId]/source-map-manager.tsx"), source("source-map/source-runs.tsx")]);
  expect(runs).toContain('<th className="review-group">Decision</th><th className="review-group">Reasoning</th>');
  expect(runs).toContain("Your review: a recorded verdict");
  for (const layout of ["table", "row"] as const) {
    const markup = renderToStaticMarkup(createElement(ReviewCells, {
      source: { _id: "source", location_id: "north", source_id: "source", name: "Council",
        review: { decision: "accept", reason_code: "A1", reason: null, initial_status: "proposed" } },
      canLabel: false, layout, onSaved: vi.fn(),
    }));
    const controls = parseHTML(`<html><body>${layout === "table" ? `<table><tbody><tr>${markup}</tr></tbody></table>` : markup}</body></html>`).document;
    const cells = controls.querySelectorAll(".review-group");
    expect(cells).toHaveLength(2);
    expect(cells[0].tagName).toBe(layout === "table" ? "TD" : "DIV");
    expect(cells[0].textContent).toContain("Accept");
    expect(cells[1].textContent).toContain("A1");
    expect(controls.querySelector("select, textarea, button")).toBeNull();
  }
  for (const gone of ["<th>Actions</th>", "reading-group", ">Pin</button>", ">Activate</button>", "Clear and Accept again to read it."]) expect(manager).not.toContain(gone);
  expect(manager).toContain('source.status === "paused" ? "Resume" : "Pause"');
});

it("shows loading instead of false readiness zeros and carries the exact requested community into onboarding", () => {
  const directory = parseHTML(renderToStaticMarkup(createElement(LocationDirectory))).document;
  expect(directory.querySelector("#onboarding details")?.hasAttribute("open")).toBe(false);
  expect([...directory.querySelectorAll(".admin-readiness-summary strong")].map((node) => node.textContent)).toEqual(["Loading", "Loading", "Loading", "Loading"]);
  const requested = { id: "exact-neighborhood-seattle-wa", name: "Exact Neighborhood, Seattle, WA" };
  const requestedDirectory = parseHTML(renderToStaticMarkup(createElement(LocationDirectory, { requested }))).document;
  expect(requestedDirectory.querySelector("#onboarding details")?.hasAttribute("open")).toBe(true);
  expect(requestedDirectory.querySelector('#onboarding input[role="combobox"]')?.getAttribute("value")).toBe(requested.name);
  const onboarding = parseHTML(renderToStaticMarkup(createElement(LocationOnboarding, {
    busy: false, enrolled: [], requested, onAdd: async () => {},
  }))).document;
  expect(onboarding.querySelector('input[role="combobox"]')?.getAttribute("value")).toBe(requested.name);
  expect(onboarding.querySelector('button[type="submit"]')?.hasAttribute("disabled")).toBe(false);
  expect(onboarding.querySelector(".notice")?.textContent).toContain("exact saved location ID is selected");
});

it("separates the source inventory from run trace views and exposes live run details in the location workspace", async () => {
  const [runs, tabs, dashboard] = await Promise.all([
    source("source-map/source-runs.tsx"), source("locations/[locationId]/location-tabs.tsx"), source("dashboard.tsx"),
  ]);
  expect(runs).toContain('aria-label="Sources inventory"');
  expect(runs.indexOf('aria-label="Sources inventory"')).toBeGreaterThan(runs.indexOf('aria-label="Run details"'));
  expect(runs).not.toContain('view === "pages"');
  expect(tabs).toContain('{runId && <Dashboard locationId={locationId} runId={runId} kind="map" inspectorOnly />}');
  expect(dashboard).toContain('sourcePipelineProgress(run, jobs) : editionPipelineProgress(run, jobs)');
  expect(dashboard).toContain('Live log updates every 3 seconds');
});

it("keeps video creation in publishing channels and the other production steps in location workspaces", async () => {
  const [workflow, shell, tabList, channels, creator, directory, locationPage, videoPage, videoStudio, videoStoryPage] = await Promise.all([
    source("locations/[locationId]/location-tabs.tsx"),
    source("admin-navigation.tsx"),
    source("locations/[locationId]/tabs.ts"),
    source("publishing/channels.tsx"),
    source("publishing/channel-stories.tsx"),
    source("locations/location-directory.tsx"),
    source("locations/[locationId]/page.tsx"),
    source("video-studio/page.tsx"),
    source("video-studio/video-studio.tsx"),
    source("video-studio/[locationId]/[storyId]/page.tsx"),
  ]);
  expect(tabList).toContain('["sources", "Sources"]');
  expect(tabList).toContain('["collect-sources", "Collect sources"]');
  expect(tabList).toContain('["edition", "Collect stories"]');
  expect(tabList).toContain('["published", "Publish"]');
  expect(tabList).toContain('runs: "collect-sources"');
  expect(tabList).not.toContain('["videos", "Videos"]');
  for (const view of ["overview", "sources", "collect-sources", "edition", "published"]) expect(workflow).toContain(`tab === "${view}"`);
  expect(workflow).toContain('tab: "collect-sources"');
  expect(workflow).toContain("All sources");
  expect(workflow).toContain("Collect sources");
  expect(workflow).not.toContain("<h2>Source runs</h2>");
  expect(await source("source-map/source-review.tsx")).toContain('href={path(locationId, "runs", runId)}>Collection runs (read-only)</Link>');
  expect(await source("source-map/source-runs.tsx")).toContain('<LiveSourceRun key={runId} runId={runId} />');
  expect(workflow).toContain("ranks and writes stories");
  expect(workflow).not.toContain("VideoStudio");
  expect(workflow).not.toContain('tab === "videos"');
  expect(workflow).toContain('edition.status === "built" ? "Publish" : "Make live"');
  expect(workflow).toContain("<NeighbourStoryReview locationId={locationId} />");
  expect(workflow).toContain("<RemembranceReview locationId={locationId} />");
  expect(workflow).toContain('only={["reports"]}');
  expect(channels).not.toContain("LocationTabs");
  expect(channels).toContain("Advanced legacy maintenance");
  expect(channels).toContain('<ChannelStories key={`${channel.id}-${editionRefreshKey}`} channelId={channel.id} />');
  expect(channels).toContain("channel.canWrite && (!channel.supportExpiresAt || channel.supportExpiresAt > now)");
  expect(channels).not.toContain("VideoStudio");
  expect(creator).toContain("Channel stories");
  expect(creator).toContain('aria-label="Channel stories"');
  expect(creator).toContain('story.published ? "Published" : "Publish"');
  expect(creator).toContain('stories: [{ locationId: story.locationId, storyId: story.storyId, editionId: story.editionId }]');
  expect(creator).toContain('outputModes: ["reader"]');
  expect(creator).toContain("Start video editing");
  expect(creator).toContain("/video-studio/");
  expect(creator).not.toContain("Create edition");
  expect(creator).not.toContain("Edition outputs");
  expect(channels).not.toContain("AlertsList");
  expect(channels).not.toContain("Publishing workflow");
  expect(channels).toContain('destinations: [{ type: "reader", url: "" }, { type: "video", url: "" }]');
  expect(channels).not.toContain('Connect Google Drive</button>');
  expect(channels).not.toContain('toggleDestination(');
  expect(channels.slice(channels.indexOf('<form className="output-channel-form"'), channels.indexOf('</form>'))).not.toContain('destinationUrls(');
  expect(channels).toContain('type="search"');
  expect(channels).toContain('aria-label={`Remove ${name}`}');
  expect(channels).not.toContain("channel-location-options");
  expect(channels).not.toContain('type="url"');
  expect(shell).not.toContain('href: "/video-studio"');
  expect(shell).toContain('label: "Locations"');
  expect(directory).not.toContain("/source-map");
  expect(directory).not.toContain("Pipeline &amp; logs");
  expect(directory).toContain("Open workspace");
  expect(locationPage).toContain("MOVED_TABS[query.tab]");
  expect(locationPage).toContain('query.tab === "runs" && typeof query.run === "string"');
  expect(locationPage).toContain('run.kind === "map" ? "collect-sources" : "edition"');
  expect(tabList).toContain('runs: "collect-sources"');
  expect(locationPage).toContain('query.tab === "videos" || query.tab === "video"');
  expect(locationPage).toContain('redirect("/newsroom")');
  expect(videoPage).toContain('redirect("/newsroom?task=publication-release-history-title")');
  expect(videoStudio).toContain("?tab=published");
  expect(videoStoryPage).toContain('page="output-channels"');
});

it("presents a conflict-safe editorial workspace without duplicating guided generation controls", async () => {
  const [generation, editorial, evidence, trace] = await Promise.all([
    source("publishing/publication-generation.tsx"),
    source("publishing/publication-editorial-workspace.tsx"),
    source("components/story-evidence.tsx"),
    source("locations/[locationId]/item-trace.tsx"),
  ]);
  expect(generation.match(/<PublicationEditorialWorkspace\b/g)).toHaveLength(1);
  expect(generation).toContain('key={`${publicationId}:${draft._id}`} publicationId={publicationId} draftId={draft._id}');
  expect(generation).toContain("task={task} onDraftChange={updateSelectedDraft}");
  expect(editorial).toContain('id="editorial-workspace-title" tabIndex={-1} aria-description={draft.presentation.headline || draft.title}>Edition editor');
  expect(editorial).toContain('saveState.state === "conflict" ? "Conflict" : "Not saved"');
  expect(editorial).toContain("Retry my edit");
  expect(editorial).toContain("Generated evidence and flags");
  expect(editorial).toContain("Add story");
  expect(editorial).toContain("Original story sources for");
  expect(editorial).toContain("Private interview notes");
  expect(editorial).toContain("never enter preview, release JSON or default generation inputs");
  expect(editorial).toContain("Mark ready for approval");
  expect(editorial).toContain("It does not publish, distribute, email or write reader JSON.");
  expect(editorial).not.toContain("Choose ready communities");
  expect(editorial).not.toContain("Generation preferences");
  expect(evidence).toContain("Review flags");
  expect(trace).toContain("<StoryEvidence items=");
});
