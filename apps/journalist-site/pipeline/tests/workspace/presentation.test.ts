import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { expect, it } from "vitest";
import { ExecutionNotice, RunExecutionSummary, type ExecutionPolicy } from "../../../app/components/execution-policy";
import { ReviewKey } from "../../../app/locations/[locationId]/source-map-manager";

const source = (path: string) => readFile(new URL(`../../../app/${path}`, import.meta.url), "utf8");

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

it("shows who started the run and whose keys it uses, with no run purpose", () => {
  const { document } = parseHTML(renderToStaticMarkup(createElement(RunExecutionSummary, { run: {
    execution: { sponsorId: "editor", initiatedBy: "editor", credentialVersion: 3, source: "personal", planHash: "plan" },
    trigger: { by: "editor@example.test" },
  } })));
  const summary = document.querySelector('[aria-label="Whose keys this run uses"]')!;
  expect(summary.closest("details")).toBeNull();
  expect(summary.textContent).toContain("editor@example.test");
  expect(summary.textContent).toContain("their own API keys");
  for (const gone of ["Final", "Training", "Test", "Admin"]) expect(summary.textContent).not.toContain(gone);
});

it("keeps execution blockers and reconnect guidance visible", () => {
  const policy: ExecutionPolicy = {
    principal: { id: "editor", email: "editor@example.test", role: "editor" },
    reasons: ["Add personal model keys."], editionReasons: [], mapReasons: [],
    canStart: false, canStartEdition: false, canStartMap: false,
    blocker: { id: "busy", locationId: "other", locationName: "Other desk", status: "awaiting_finish", paused: null },
    permissions: { busy: { canSpend: false, canRestart: false, restartReason: null, canReconnect: true, canClaim: false, reason: "API settings changed.", paused: null } },
  };
  const { document } = parseHTML(renderToStaticMarkup(createElement(ExecutionNotice, { policy, runId: "busy" })));
  expect(document.querySelector("details")).toBeNull();
  const notice = document.querySelector('[aria-label="Execution access"]')?.textContent ?? "";
  expect(notice).toContain("Your runs require your own API keys");
  expect(notice).not.toContain("Admin");
  expect(document.querySelector('a[href="/locations/other?tab=edition&run=busy"]')?.textContent).toBe("Other desk");
  expect(document.querySelector("button")?.textContent).toContain("Reconnect this run");
});

it("removes repeated shell hints and location heading without removing navigation or the skip link", async () => {
  const [shell, tabs] = await Promise.all([source("admin-shell.tsx"), source("locations/[locationId]/location-tabs.tsx")]);
  expect(shell).not.toContain("item.hint");
  expect(shell).toContain('aria-label="Workspace navigation"');
  expect(shell).toContain('href="#workspace-content"');
  expect(shell).toContain('aria-current={active(item.id) ? "page" : undefined}');
  expect(tabs).not.toContain("<h2>{name}</h2>");
  expect(tabs).toContain("Collects source items, ranks and writes stories");
});
it("uses the account's own profile status instead of repeating global readiness and operator instructions", async () => {
  const [shell, account] = await Promise.all([source("admin-shell.tsx"), source("account/settings.tsx")]);
  expect(shell).toContain('principal && page !== "account"');
  expect(shell).toContain('isConfiguredOwner(principal) ? " · Owner deployment fallback" : " · No deployment fallback"');
  expect(account).toContain("No personal profile. Add your own API keys");
  expect(account).not.toContain("Set NEWSBEE_OWNER_EMAIL on the server");
  expect(account).toContain("Ask your administrator to complete owner setup");
  expect(account).toContain("Configuration checks only; no provider calls.");
  expect(account).toContain("Deployment API credentials are owner-only; clearing a key disables that service");
  expect(account).not.toContain('placeholder={defaultKey ? "****"');
  expect(account).toContain("Revoke disables the entire profile");
});

it("explains Decision and Reasoning apart, groups their columns, and has no separate Pin or Pause buttons", async () => {
  const { document } = parseHTML(renderToStaticMarkup(createElement(ReviewKey)));
  expect([...document.querySelectorAll("dt")].map((term) => term.textContent)).toEqual(["Decision", "Reasoning"]);
  const text = (term: string) => [...document.querySelectorAll("dt")].find((dt) => dt.textContent === term)!.nextElementSibling!.textContent!;
  expect(text("Decision")).toContain("what runs read");
  expect(text("Decision")).toContain("paused ones resume");
  expect(text("Reasoning")).toContain("Changes nothing on its own");
  const [manager, runs] = await Promise.all([source("locations/[locationId]/source-map-manager.tsx"), source("source-map/source-runs.tsx")]);
  for (const table of [manager, runs]) {
    expect(table).toContain('<th className="review-group">Decision</th><th className="review-group">Reasoning</th>');
    expect(table).toContain("Your review: a recorded verdict");
  }
  for (const gone of ["<th>Actions</th>", "reading-group", ">Pin</button>", ">Pause</button>", ">Activate</button>"]) expect(manager).not.toContain(gone);
  expect(manager).toContain("Clear and Accept again to read it.");
});

it("separates the source inventory from run trace views and exposes live run details in the location workspace", async () => {
  const [runs, tabs, dashboard] = await Promise.all([
    source("source-map/source-runs.tsx"), source("locations/[locationId]/location-tabs.tsx"), source("dashboard.tsx"),
  ]);
  expect(runs).toContain('aria-label="Sources inventory"');
  expect(runs.indexOf('aria-label="Sources inventory"')).toBeGreaterThan(runs.indexOf('aria-label="Run details"'));
  expect(runs).not.toContain('view === "pages"');
  expect(tabs).toContain('<Dashboard locationId={locationId} kind="map" inspectorOnly />');
  expect(dashboard).toContain('sourcePipelineProgress(run, jobs) : editionPipelineProgress(run, jobs)');
  expect(dashboard).toContain('Live log updates every 3 seconds');
});

it("keeps video creation in publishing channels and the other production steps in location workspaces", async () => {
  const [workflow, shell, tabList, channels, creator, directory, locationPage, videoPage, videoStudio, videoStoryPage] = await Promise.all([
    source("locations/[locationId]/location-tabs.tsx"),
    source("admin-shell.tsx"),
    source("locations/[locationId]/tabs.ts"),
    source("publishing/channels.tsx"),
    source("publishing/channel-edition-creator.tsx"),
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
  expect(workflow).toContain("Source runs");
  expect(workflow).toContain("ranks and writes stories");
  expect(workflow).not.toContain("VideoStudio");
  expect(workflow).not.toContain('tab === "videos"');
  expect(workflow).toContain('edition.status === "built" ? "Publish" : "Make live"');
  expect(workflow).toContain("<NeighbourStoryReview locationId={locationId} />");
  expect(workflow).toContain("<RemembranceReview locationId={locationId} />");
  expect(workflow).toContain('only={["reports"]}');
  expect(channels).not.toContain("LocationTabs");
  expect(channels).toContain("<ChannelEditionCreator key={`${channel.id}-${editionRefreshKey}`} channelId={channel.id} owner={owner} />");
  expect(channels).not.toContain("VideoStudio");
  expect(creator).toContain("Create a channel edition");
  expect(creator).toContain("Edition outputs");
  expect(creator).toContain("Reader mode");
  expect(creator).toContain("Generate video for this story");
  expect(creator).toContain("Open video & YouTube workflow");
  expect(creator).toContain("Create edition");
  expect(channels).not.toContain("AlertsList");
  expect(channels).not.toContain("Publishing workflow");
  expect(channels).toContain('destinations: [{ type: "reader", url: "" }]');
  expect(channels).toContain('className="channel-destinations"');
  expect(channels).toContain('type="search"');
  expect(channels).toContain('aria-label={`Remove ${name}`}');
  expect(channels).not.toContain("channel-location-options");
  expect(channels).toContain("URL (optional)");
  expect(shell).not.toContain('href: "/video-studio"');
  expect(shell).toContain('label: "Overview"');
  expect(directory).not.toContain("/source-map");
  expect(directory).not.toContain("Pipeline &amp; logs");
  expect(directory).toContain("Open workspace");
  expect(locationPage).toContain("MOVED_TABS[query.tab]");
  expect(locationPage).toContain('query.tab === "runs" && typeof query.run === "string"');
  expect(locationPage).toContain('run.kind === "map" ? "collect-sources" : "edition"');
  expect(tabList).toContain('runs: "collect-sources"');
  expect(locationPage).toContain('query.tab === "videos" || query.tab === "video"');
  expect(locationPage).toContain('redirect(`/publishing?location=${encodeURIComponent(locationId)}`)');
  expect(videoPage).toContain("/publishing?location=");
  expect(videoStudio).toContain("?tab=published");
  expect(videoStoryPage).toContain('page="output-channels"');
});
