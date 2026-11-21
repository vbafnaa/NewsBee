import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ComponentProps } from "react";
import { parseHTML } from "linkedom";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { readFile } from "node:fs/promises";
import { recordReaderSignup } from "../../../../reader-site/src/lib/signup-storage";
import { searchTownDirectory } from "../../../../reader-site/src/lib/reader-data";
import { loadSettings } from "../../core/config";
import {
  locationReadinessCatalog,
  locationReadinessForIds,
  transitionLocationReadiness,
} from "../../communities/readiness";
import { overview } from "../../orchestration/overview";
import { healthSummary } from "../../orchestration/health";
import { COLLECTIONS } from "../../storage/mongo";
import { runSources, saveSourceReview, setSourceStatus, sourceMap, upsertCandidates, type SourceCandidate } from "../../sourcemap/store";
import { getLocation, updateSources } from "../../communities/locations";
import { locationEvidenceCandidates, repairLocationEvidence } from "../../communities/evidence";
import { COVERAGE_REQUESTS, publicationCoverageRequests, requestPublicationCoverage } from "../../communities/coverage-requests";
import { resolvePublicationContext } from "../../publications/access";
import { validateGenerationLocations } from "../../publications/generation";
import { OSM_ATTRIBUTION } from "../../../../../shared/geography";
import { discoveryOutcome } from "../../discovery/status";
import { OVERPASS_ENDPOINTS } from "../../connectors/overpass";
import LocationDirectory from "../../../app/locations/location-directory";
import SourceMapManager from "../../../app/locations/[locationId]/source-map-manager";

const ui = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/lib/admin-client", async (original) => ({ withPublication: (await original<typeof import("@/lib/admin-client")>()).withPublication, adminApi: ui.api, mapApi: ui.api }));
vi.mock("next/link", () => ({ default: (props: ComponentProps<"a">) => createElement("a", props) }));
vi.mock("@/app/location-onboarding", () => ({ default: () => null }));
vi.mock("@/app/locations/current-runs", () => ({ CurrentRuns: () => null }));
vi.mock("@/app/components/execution-policy", () => ({ ExecutionNotice: () => null, useExecutionPolicy: () => ({ policy: null, error: "" }) }));

const legacyOverpass = (attempts = OVERPASS_ENDPOINTS.map((endpoint) => `${endpoint}: Error: overpass is switched off for this run`)) =>
  `Error: Overpass unavailable; ${attempts.join("; ")}`;

let server: MongoMemoryServer;
let client: MongoClient;
let db: Db;

const principal = { id: "editor-1", email: "editor@example.test", role: "editor" as const };
const location = (id: string, name: string, coverage: "ready" | "partial" | "no_local_sources", gaps: string[] = []) => ({
  _id: id,
  id,
  name,
  state: "WA",
  systems: [{ fscskey: "fixture-system", name: "Fixture Library", website: "https://library.example.test",
    branches: [{ name: "Fixture branch", address: "1 Main St", city: "Fixture", state: "WA" }] }],
  government: null,
  community: {
    name, state: "WA", state_name: "Washington", parent_id: id, parent_name: name,
    latitude: 47.6, longitude: -122.3, aliases: [], coverage_terms: [name],
    library_branches: ["Fixture branch"], newsrooms: [],
  },
  source_map_at: 1_700_000_000,
  source_coverage: { status: coverage, area: "Town boundary", gaps, discovery_gaps: gaps, checked_at: "2026-11-11T00:00:00.000Z" },
});

async function seedSources(id: string) {
  const candidates: SourceCandidate[] = [
    { source_id: "source", name: "Fixture publisher", reader: "web", section: "news", source_kind: "news_report",
      params: { kind: "news_report" }, url: "https://publisher.example.test/news", status: "pinned", inside_area: true, found_by: { method: "editor", detail: "Validated publisher" } },
    { source_id: "library", name: "Fixture Library", reader: "library", section: "events", params: { fscskey: "fixture-system" },
      url: "https://library.example.test/events", status: "active", inside_area: true, found_by: { method: "library", detail: "Directory" } },
    { source_id: "meetings", name: "Fixture Council", reader: "meetings", section: "civic", params: {},
      url: "https://council.example.test", status: "active", inside_area: true, found_by: { method: "meetings", detail: "Validated meetings" } },
  ];
  await upsertCandidates(db, id, candidates);
}
beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await MongoClient.connect(server.getUri());
  db = client.db("location-readiness");
});
beforeEach(async () => { await db.dropDatabase(); });
afterAll(async () => { await client?.close(); await server?.stop(); });

describe("location-first reader demand and newsroom readiness", () => {
  it("classifies only trustworthy structured or exact historical disabled evidence", () => {
    const disabled = { method: "institutions", ok: false, detail: legacyOverpass() };
    expect(discoveryOutcome(disabled)).toBe("disabled");
    expect(discoveryOutcome({ ...disabled, detail: disabled.detail.replace("overpass.private.coffee", "overpass.kumi.systems") })).toBe("disabled");
    for (const replacement of [
      "Error: HTTP 429", "cooling down after service refusal", "Error: HTTP 503",
      "SyntaxError: Unexpected token", "Error: Invalid Overpass response: missing elements array", "Error: network outage",
      "Error: overpass is switched off for this run but the network also failed",
    ]) {
      expect(discoveryOutcome({ ...disabled, detail: disabled.detail.replace("Error: overpass is switched off for this run", replacement) })).toBe("failed");
    }
    for (const detail of [
      disabled.detail.replace("overpass-api.de", "unknown.example"),
      `${disabled.detail}; `, `${disabled.detail}; unknown`, "Overpass unavailable",
      "Error: overpass is switched off for this run", legacyOverpass([]),
      legacyOverpass(Array(5).fill(`${OVERPASS_ENDPOINTS[0]}: Error: overpass is switched off for this run`)),
    ]) expect(discoveryOutcome({ ...disabled, detail })).toBe("failed");
    expect(discoveryOutcome({ ...disabled, method: "schools" })).toBe("failed");
    expect(discoveryOutcome({ ...disabled, outcome: "failed" })).toBe("failed");
    expect(discoveryOutcome({ ...disabled, outcome: "succeeded" })).toBe("succeeded");
    expect(discoveryOutcome({ ...disabled, outcome: "disabled" })).toBe("failed");
    expect(discoveryOutcome({ ok: false, outcome: "disabled", reason: "overpass_off", detail: "New producer detail" })).toBe("disabled");
    for (const detail of ["LLM discovery is off (NEWSBEE_LLM_DISCOVERY)", "No ATTOM key set"]) {
      expect(discoveryOutcome({ ok: true, detail })).toBe("disabled");
      expect(discoveryOutcome({ ok: false, detail })).toBe("disabled");
    }
    expect(discoveryOutcome({ never_run: true })).toBe("not_attempted");
    expect(discoveryOutcome({ ok: true, detail: "No sources found" })).toBe("succeeded");
    expect(discoveryOutcome({ ok: false, detail: "Service unavailable or off?" })).toBe("failed");
  });

  it("keeps disabled and failed methods observable in Operations and Sources without rewriting history or changing readiness", async () => {
    const id = "discovery-wa";
    await db.collection(COLLECTIONS.locations).insertOne(location(id, "Discovery, WA", "partial"));
    await seedSources(id);
    const readiness = await locationReadinessForIds(db, [{ id, name: "Discovery, WA" }]);
    const rows = [
      { method: "institutions", label: "Historical Overpass", ok: false, detail: legacyOverpass() },
      { method: "schools", label: "Saved Overpass policy", ok: false, outcome: "disabled", reason: "overpass_off", detail: "ExternalServiceDisabledError: overpass is switched off for this run" },
      { method: "groups", label: "Provider failure", ok: false, detail: "Error: HTTP 503 from https://provider.example.test" },
      { method: "llm", label: "Model suggestions", ok: true, detail: "LLM discovery is off (NEWSBEE_LLM_DISCOVERY)" },
      { method: "homesales", label: "Home sales", ok: true, outcome: "disabled", reason: "attom_unconfigured", detail: "No ATTOM key set" },
      { method: "newsrooms", label: "Working discovery", ok: true, detail: "No nearby outlets" },
    ].map((row, index) => ({ ...row, _id: `${id}:${index}`, location_id: id, last_run_at: index === 5 ? 1 : Date.now() / 1000, found: 0, added: 0 }));
    await db.collection("discovery_state").insertMany(rows);
    const before = await db.collection("discovery_state").find({}).toArray();
    const data = await overview(db, loadSettings({ NEWSBEE_MODE: "local", NEWSBEE_MODEL_PROVIDERS: "ollama" }));
    const discovery = data.work_queue.filter((row) => row.id.startsWith(`alert:discovery:${id}`));
    expect(discovery).toHaveLength(5);
    for (const row of discovery) {
      expect(row.title).not.toContain("https://");
      expect(row.detail).not.toContain("https://");
      expect(row.diagnostics).toBeTruthy();
      expect(row.href).toBe(`/locations/${id}?tab=sources#discovery`);
      if (row.title.includes("Provider failure")) expect(row.detail).toContain("refresh the source map");
      else {
        expect(row.title).toContain("disabled / unavailable");
        expect(row.detail).toContain("Re-running does not enable a service");
        expect(row.detail).not.toContain("run it again");
      }
    }
    expect(data.alerts.some((alert) => alert.kind === "stale_map")).toBe(true);
    expect(await locationReadinessForIds(db, [{ id, name: "Discovery, WA" }])).toEqual(
      readiness.map((row) => ({ ...row, source_coverage: { ...row.source_coverage, checked_at: expect.any(String) } })),
    );
    expect(await db.collection("discovery_state").find({}).toArray()).toEqual(before);
    expect(await db.collection(COLLECTIONS.jobs).countDocuments()).toBe(0);
    expect(await db.collection("api_calls").countDocuments()).toBe(0);

    ui.api.mockImplementation(async (path: string) => {
      if (path === "overview") return data;
      if (path === "current-runs") return { runs: [] };
      if (path === `locations/${id}/source-map`) return { sections: [], sources: [], discovery: [...rows, { method: "athletics", label: "Never run", never_run: true }] };
      throw new Error(`Unexpected fixture read: ${path}`);
    });
    const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
    vi.stubGlobal("window", window);
    vi.stubGlobal("document", document);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Object.defineProperty(window, "location", { configurable: true, value: { search: "", origin: "https://newsbee.test" } });
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(document.getElementById("root")!);
    try {
      await act(async () => root.render(createElement(LocationDirectory)));
      const operations = document.querySelector(".admin-readiness-queue")!;
      const diagnostics = operations.querySelectorAll("details");
      expect(diagnostics.length).toBe(5);
      for (const detail of diagnostics) {
        expect(detail.hasAttribute("open")).toBe(false);
        expect(detail.querySelector("summary")?.textContent).toBe("Discovery diagnostics");
      }
      expect([...diagnostics].some((detail) => detail.textContent?.includes("HTTP 503"))).toBe(true);
      expect([...diagnostics].some((detail) => detail.textContent?.includes(OVERPASS_ENDPOINTS[0]))).toBe(true);
      for (const detail of diagnostics) detail.remove();
      expect(operations.textContent).not.toContain("https://");
      expect(operations.textContent).toContain("Re-running does not enable a service");

      await act(async () => root.render(createElement(SourceMapManager, { locationId: id })));
      const table = document.querySelector("#discovery")!;
      expect(table.querySelectorAll(".tone-warning").length).toBe(4);
      expect(table.querySelectorAll(".tone-failed").length).toBe(1);
      expect(table.querySelectorAll(".tone-ok").length).toBe(1);
      expect(table.textContent).toContain("Never");
      expect(table.textContent).toContain("Not attempted");
      expect(table.textContent).toContain("HTTP 503");
      for (const detail of table.querySelectorAll("details")) {
        expect(detail.hasAttribute("open")).toBe(false);
        detail.remove();
      }
      expect(table.textContent).not.toContain("https://");
      expect(table.textContent).toContain("Overpass (OpenStreetMap) was switched off for this run");
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
      ui.api.mockReset();
    }
  });

  it("repairs actual boundary and canonical branches with revision history, without waiving source prerequisites", async () => {
    const profile = location("evidence-wa", "Evidence, WA", "partial");
    const geography = {
      id: profile.id, name: "Evidence", label: profile.name, state: "WA", state_name: "Washington",
      kind: "neighbourhood", parent_name: "Seattle", parent_kind: "city" as const, latitude: 47.6, longitude: -122.3,
      area: { method: "approximate_radius" as const, radius_km: 2 }, provider: "photon" as const,
      osm_type: "R" as const, osm_id: 123, website: null, attribution: OSM_ATTRIBUTION,
    };
    await db.collection(COLLECTIONS.locations).insertOne({ ...profile, community: { ...profile.community, geography }, systems: [] });
    await db.collection(COLLECTIONS.libraryOutlets).insertMany([
      { _id: "system:real", type: "system", fscskey: "real", name: "Real Library", edition: "FY2022" },
      { _id: "inside", type: "outlet", fscskey: "real", name: "Real Branch", address: "1 Main St", state: "WA", latitude: 47.6, longitude: -122.3 },
      { _id: "outside", type: "outlet", fscskey: "real", name: "Outside Branch", address: "2 Main St", state: "WA", latitude: 48, longitude: -123 },
    ]);
    const actor = { ...principal, role: "admin" as const };
    const base = { revision: 0, reason: "Verified municipal boundary source", provenance_url: "https://city.example.test/boundary" };
    await expect(repairLocationEvidence(db, profile.id, { ...base, boundary: { type: "Point", coordinates: [-122.3, 47.6] } }, actor)).rejects.toThrow("Polygon");
    await expect(repairLocationEvidence(db, profile.id, { ...base, outlet_ids: ["inside"] }, actor)).rejects.toThrow("outside the actual boundary");
    const shape = { type: "Polygon", coordinates: [[[-122.4, 47.5], [-122.2, 47.5], [-122.2, 47.7], [-122.4, 47.7], [-122.4, 47.5]]] };
    await expect(repairLocationEvidence(db, profile.id, { ...base, boundary: shape }, principal)).rejects.toThrow("operator");
    const repaired = await repairLocationEvidence(db, profile.id, { ...base, boundary: shape }, actor);
    expect(repaired.evidence_revision).toBe(1);
    expect((await locationEvidenceCandidates(db, repaired)).systems[0].branches.map((branch) => branch.directory_outlet_id)).toEqual(["inside"]);
    await expect(repairLocationEvidence(db, profile.id, { ...base, outlet_ids: ["inside"] }, actor)).rejects.toThrow("changed");
    await expect(repairLocationEvidence(db, profile.id, { ...base, revision: 1, outlet_ids: ["outside", "made-up"] }, actor)).rejects.toThrow("outside");
    const associated = await repairLocationEvidence(db, profile.id, { ...base, revision: 1, outlet_ids: ["inside"] }, actor);
    expect(associated.systems[0]).toMatchObject({ fscskey: "real", branches: [{ name: "Real Branch", directory_outlet_id: "inside" }] });
    const saved = await db.collection(COLLECTIONS.locations).findOne({ _id: profile.id });
    expect(saved?.evidence_events).toHaveLength(2);
    expect(saved?.evidence_events[0]).toMatchObject({ by: actor.id, revision: 1, provenance_url: base.provenance_url });
    await updateSources(db, profile.id, { real: "https://library.example.test" }, null);
    const afterSettings = await db.collection(COLLECTIONS.locations).findOne({ _id: profile.id });
    expect(afterSettings?.evidence_events).toEqual(saved?.evidence_events);
    expect(afterSettings?.boundary_provenance).toEqual(saved?.boundary_provenance);
    const [row] = await locationReadinessForIds(db, [{ id: profile.id, name: profile.name }]);
    expect(row.can_mark_ready).toBe(false);
    expect(row.missing_prerequisites.join(" ")).not.toContain("No library branches");
    expect(row.missing_prerequisites.join(" ")).toContain("usable source");
  });

  it("dedupes contextual coverage requests in the operations queue without granting coverage or reader consent", async () => {
    await db.collection(COLLECTIONS.outputChannels).insertMany([
      { _id: "empty", owner_id: principal.id, name: "Empty newsroom", allowed_location_ids: [], publication_scope_version: 1 },
      { _id: "blocked", owner_id: principal.id, name: "Blocked newsroom", allowed_location_ids: ["requested-wa"], publication_scope_version: 1 },
    ]);
    const context = (await resolvePublicationContext(db, principal.id, "empty"))!;
    const first = await requestPublicationCoverage(db, context, null);
    expect(first.request?.status).toBe("requested");
    expect(await Promise.all([requestPublicationCoverage(db, context, null), requestPublicationCoverage(db, context, null)]))
      .toEqual([first, first]);
    await expect(requestPublicationCoverage(db, context, "foreign-wa")).rejects.toThrow("never expand");
    const blocked = (await resolvePublicationContext(db, principal.id, "blocked"))!;
    await requestPublicationCoverage(db, blocked, "requested-wa");
    expect(await db.collection(COVERAGE_REQUESTS).countDocuments()).toBe(2);
    expect(await db.collection("reader_interest_signups").countDocuments()).toBe(0);
    expect((await publicationCoverageRequests(db, blocked)).locations[0]).toMatchObject({ ready: false, request: { status: "requested" } });
    expect((await db.collection(COLLECTIONS.outputChannels).findOne({ _id: "empty" }))?.allowed_location_ids).toEqual([]);
    const data = await overview(db, loadSettings({ NEWSBEE_MODE: "local", NEWSBEE_MODEL_PROVIDERS: "ollama" }));
    expect(data.work_queue.some((row) => row.title === "Empty newsroom: coverage requested")).toBe(true);
    expect(data.work_queue.some((row) => row.location_id === "requested-wa")).toBe(true);
  });

  it("groups host alerts with individual source links and does not call disabled discovery retryable", async () => {
    await db.collection(COLLECTIONS.locations).insertOne(location("host-wa", "Host, WA", "partial"));
    await seedSources("host-wa");
    const publisher = (await sourceMap(db).findOne({ _id: "host-wa:source" }))!;
    const health = { ...publisher.health, last_status: "blocked", last_detail: "Site access rules", consecutive_failures: 3, last_run_at: Date.now() / 1000 };
    await sourceMap(db).updateOne({ _id: "host-wa:source" }, { $set: { health } });
    const original = (await sourceMap(db).findOne({ _id: "host-wa:source" }))!;
    await sourceMap(db).insertOne({ ...original, _id: "host-wa:second", source_id: "second", name: "Second feed", url: "https://publisher.example.test/second" });
    await db.collection("discovery_state").insertOne({ _id: "host-wa:homesales", location_id: "host-wa", method: "homesales",
      label: "Home sales", ok: false, detail: "No ATTOM key set", last_run_at: Date.now() / 1000 });
    const data = await overview(db, loadSettings({ NEWSBEE_MODE: "local", NEWSBEE_MODEL_PROVIDERS: "ollama" }));
    const hostRows = data.work_queue.filter((row) => row.id.startsWith("host:"));
    expect(hostRows).toHaveLength(1);
    expect(hostRows[0].affected_sources).toHaveLength(2);
    expect(hostRows[0].affected_sources?.map((row) => row.href)).toEqual(expect.arrayContaining([
      "/locations/host-wa?tab=sources#source", "/locations/host-wa?tab=sources#second",
    ]));
    expect(data.work_queue.find((row) => row.id.includes("discovery:host-wa"))).toMatchObject({
      title: expect.stringContaining("disabled / unavailable"),
      detail: expect.stringContaining("Re-running does not enable a service"),
      diagnostics: "No ATTOM key set",
    });
  });
  it("keeps readiness states inside the current Reader Option A theme", async () => {
    const landing = await readFile(
      new URL("../../../../reader-site/src/components/Landing.astro", import.meta.url),
      "utf8",
    );
    expect(landing).toContain('/fonts/reader-fonts.css');
    expect(landing).toContain('--font-display: "Inter", sans-serif');
    expect(landing).toContain('--font-body: "Roboto", sans-serif');
    expect(landing).toContain('class="readiness-pill"');
    expect(landing).toContain("Request coverage and keep me posted");
    expect(landing).toContain("@media (max-width: 760px)");
    expect(landing).toContain("neighborhood-art");
    expect(landing).toContain("Browse stories and editions");
  });

  it("keeps requests privacy-safe and never infers readiness from signups", async () => {
    await db.collection("census_places").insertMany([
      { _id: "requested-wa", name: "Requested", name_lower: "requested", state: "WA" },
      { _id: "partial-wa", name: "Partial", name_lower: "partial", state: "WA" },
      { _id: "ready-wa", name: "Ready", name_lower: "ready", state: "WA" },
    ]);
    await db.collection(COLLECTIONS.locations).insertMany([
      location("partial-wa", "Partial, WA", "partial", ["Confirm the city meeting source."]),
      location("ready-wa", "Ready, WA", "ready"),
    ]);
    await Promise.all([seedSources("partial-wa"), seedSources("ready-wa")]);
    await Promise.all([
      recordReaderSignup(db, { id: "requested-wa", name: "Requested, WA" }, "one@example.test", true),
      recordReaderSignup(db, { id: "requested-wa", name: "Requested, WA" }, "two@example.test", true),
      recordReaderSignup(db, { id: "ready-wa", name: "Ready, WA" }, "three@example.test", true),
    ]);

    const catalog = await locationReadinessCatalog(db);
    expect(catalog.find((row) => row.location_id === "requested-wa")).toMatchObject({
      state: "requested", demand: 2, onboarded: false, ready: false,
    });
    expect(catalog.find((row) => row.location_id === "partial-wa")).toMatchObject({
      state: "preparing", can_mark_ready: true, ready: false,
    });
    expect(catalog.find((row) => row.location_id === "ready-wa")).toMatchObject({
      state: "preparing", can_mark_ready: true, ready: false,
    });
    expect(JSON.stringify(catalog)).not.toContain("@example.test");

    expect((await searchTownDirectory("Requested", db))[0]).toMatchObject({ id: "requested-wa", preparation_state: "requested" });
    expect((await searchTownDirectory("Ready", db))[0]).toMatchObject({ id: "ready-wa", preparation_state: "preparing" });
  });

  it("runs the three-location mock, audits the ready transition, and returns a stable queue without requester emails", async () => {
    await db.collection("census_places").insertMany([
      { _id: "requested-wa", name: "Requested", name_lower: "requested", state: "WA" },
      { _id: "partial-wa", name: "Partial", name_lower: "partial", state: "WA" },
      { _id: "ready-wa", name: "Ready", name_lower: "ready", state: "WA" },
    ]);
    await db.collection(COLLECTIONS.locations).insertMany([
      location("partial-wa", "Partial, WA", "partial", ["Confirm the city meeting source."]),
      location("ready-wa", "Ready, WA", "ready"),
    ]);
    await Promise.all([seedSources("partial-wa"), seedSources("ready-wa")]);
    for (const email of ["one@example.test", "two@example.test", "three@example.test"]) {
      await recordReaderSignup(db, { id: "requested-wa", name: "Requested, WA" }, email, true);
    }
    await db.collection(COLLECTIONS.runs).insertOne({
      _id: "partial-run",
      location_id: "partial-wa",
      location_name: "Partial, WA",
      status: "awaiting_finish",
      draft_id: "partial-draft",
      created_at: Date.now() / 1000,
      completed_at: null,
      sources: [],
      published: null,
    });
    await db.collection(COLLECTIONS.editionEntries).insertOne({
      edition_id: "partial-draft",
      story_id: "held-1",
      disposition: "held",
      result: { validation_errors: ["Needs a verified source."] },
    });

    expect((await locationReadinessForIds(db, [{ id: "partial-wa", name: "Partial, WA" }]))[0])
      .toMatchObject({ state: "preparing", can_mark_ready: true, missing_prerequisites: [] });
    const transitioned = await transitionLocationReadiness(db, "ready-wa", "ready", principal, "Source coverage reviewed.");
    expect(transitioned).toMatchObject({ state: "ready", ready: true });
    expect((await searchTownDirectory("Ready", db))[0]).toMatchObject({ preparation_state: "ready" });

    const saved = await db.collection(COLLECTIONS.locations).findOne({ _id: "ready-wa" });
    expect(saved?.preparation).toMatchObject({
      state: "ready",
      updated_by: principal.id,
      updated_by_email: principal.email,
      reason: "Source coverage reviewed.",
    });
    expect(saved?.preparation_events).toHaveLength(1);

    const data = await overview(db, loadSettings({ NEWSBEE_MODE: "local", NEWSBEE_MODEL_PROVIDERS: "ollama" }));
    expect(data.work_queue.map((item) => item.id)).toEqual([
      "readiness:requested-wa",
      "readiness:partial-wa",
      "held:partial-wa",
      "alert:stale-map:ready-wa",
    ]);
    expect(data.work_queue.find((item) => item.id === "readiness:requested-wa")).toMatchObject({
      demand: 3,
      state: "requested",
      href: "/admin?requested_location=requested-wa&requested_name=Requested%2C%20WA#onboarding",
    });
    expect(data.locations.find((row) => row.location_id === "ready-wa")).toMatchObject({ state: "WA", readiness: { state: "ready" } });
    expect(JSON.stringify(data)).not.toContain("one@example.test");
    const health = await healthSummary(db, null, { runTimeoutSeconds: null, modelProviders: [] });
    expect(health.totals.locations).toBe(2);
    expect(health.locations.find((row) => row.location_id === "partial-wa")).toMatchObject({
      stage: "awaiting_finish",
      candidate_count: 0,
    });

    const locationIndexes = await db.collection(COLLECTIONS.locations).indexInformation();
    const signupIndexes = await db.collection("reader_interest_signups").indexInformation();
    expect(locationIndexes).toHaveProperty("location_preparation_state_updated");
    expect(signupIndexes).toHaveProperty("location_interest_demand");
  });

  it("admits usable source-map links with approximate geography, no libraries or map-run timestamp across exact/catalog, coverage and generation", async () => {
    const id = "osm-r13915552-wa";
    const profile = location(id, "Wedgwood, WA", "partial", ["Incomplete category coverage."]);
    await db.collection(COLLECTIONS.locations).insertOne({
      ...profile, systems: [], source_map_at: null,
      community: { ...profile.community, geography: {
        id, name: "Wedgwood", label: profile.name, state: "WA", state_name: "Washington",
        kind: "neighbourhood", parent_name: "Seattle", parent_kind: "city",
        latitude: 47.6, longitude: -122.3,
        area: { method: "approximate_bbox", bbox: [-122.4, 47.5, -122.2, 47.7] },
        provider: "photon", osm_type: "R", osm_id: 13915552, website: null, attribution: OSM_ATTRIBUTION,
      } },
    });
    await seedSources(id);
    await sourceMap(db).deleteMany({ location_id: id, source_id: { $in: ["library", "meetings"] } });
    const candidates = [{ id, name: profile.name }];
    expect((await locationReadinessForIds(db, candidates))[0]).toMatchObject({
      ready: false, can_mark_ready: true, active_source_count: 1, missing_prerequisites: [],
      source_coverage: { status: "partial" }, source_map_at: null,
    });
    const ready = await transitionLocationReadiness(db, id, "ready", principal);
    expect(ready).toMatchObject({ ready: true, active_source_count: 1 });
    expect(ready.source_coverage?.gaps.join(" ")).toContain("No library branches");
    expect(ready.source_coverage?.gaps.join(" ")).toContain("meeting source");
    expect((await locationReadinessCatalog(db))[0]).toEqual({
      ...ready, source_coverage: { ...ready.source_coverage, checked_at: expect.any(String) },
    });
    await db.collection(COLLECTIONS.outputChannels).insertOne({
      _id: "newsroom", owner_id: principal.id, name: "Newsroom", enabled: true,
      allowed_location_ids: [id], selected_location_ids: [id], publication_scope_version: 1,
    });
    const context = (await resolvePublicationContext(db, principal.id, "newsroom"))!;
    expect((await publicationCoverageRequests(db, context)).locations[0]).toMatchObject({ location_id: id, ready: true });
    expect((await validateGenerationLocations(db, context, [id])).map((row) => row.id)).toEqual([id]);
    await expect(validateGenerationLocations(db, context, ["other-location"])).rejects.toThrow("must belong");
    await transitionLocationReadiness(db, id, "blocked", principal, "Operator source-access investigation");
    expect((await locationReadinessForIds(db, candidates))[0]).toMatchObject({ state: "blocked", ready: false });
    expect((await publicationCoverageRequests(db, context)).locations[0]).toMatchObject({ state: "blocked", ready: false });
    await expect(validateGenerationLocations(db, context, [id])).rejects.toThrow("is blocked");
  });

  it("requires current eligible evidence, not cached coverage or historical releases, but does not require each category", async () => {
    await db.collection(COLLECTIONS.locations).insertOne(location("current-wa", "Current, WA", "no_local_sources", [
      "No supported RSS/Atom link was published on https://community.example.test.",
    ]));
    await seedSources("current-wa");
    const candidates = [{ id: "current-wa", name: "Current, WA" }];
    await transitionLocationReadiness(db, "current-wa", "ready", principal);
    await db.collection("editions").insertOne({ location_id: "current-wa", status: "published", id: "historical-edition" });
    expect((await locationReadinessForIds(db, candidates))[0]).toMatchObject({ ready: true, active_source_count: 3 });
    expect((await getLocation(db, "current-wa")).source_coverage).toMatchObject({ status: "ready", gaps: [] });
    await saveSourceReview(db, "current-wa", "source", { decision: "accept" }, principal.email);
    await sourceMap(db).updateOne({ _id: "current-wa:source" }, { $unset: { source_kind: "", params: "" } });
    expect((await locationReadinessForIds(db, candidates))[0]).toMatchObject({ ready: true });
    const before = await sourceMap(db).findOne({ _id: "current-wa:source" });
    await setSourceStatus(db, "current-wa", "source", "paused");
    const [partial] = await locationReadinessForIds(db, candidates);
    expect(partial).toMatchObject({ ready: true, active_source_count: 2, published: true });
    expect(partial.source_coverage?.gaps.join(" ")).toContain("validated publisher");
    expect((await getLocation(db, "current-wa")).source_coverage?.status).toBe("partial");
    await sourceMap(db).updateMany({ location_id: "current-wa" }, { $set: { status: "paused" } });
    const [current] = await locationReadinessForIds(db, candidates);
    expect(current).toMatchObject({ ready: false, state: "preparing", active_source_count: 0, published: true });
    expect((await locationReadinessCatalog(db))[0]).toEqual({
      ...current, source_coverage: { ...current.source_coverage, checked_at: expect.any(String) },
    });
    expect((await getLocation(db, "current-wa")).source_coverage?.status).toBe("no_local_sources");
    expect((await sourceMap(db).findOne({ _id: "current-wa:source" }))?.review).toEqual(before?.review);
    await db.collection(COLLECTIONS.locations).updateOne({ _id: "current-wa" }, { $unset: { preparation: "" } });
    expect((await locationReadinessForIds(db, candidates))[0]).toMatchObject({ ready: false, compatibility_ready: false });
    expect(await db.collection("editions").countDocuments({ id: "historical-edition", status: "published" })).toBe(1);
  });

  it("does not count link-only publishers or alternate endpoints of reviewed sources as current evidence", async () => {
    await db.collection(COLLECTIONS.locations).insertOne(location("access-wa", "Access, WA", "ready"));
    await seedSources("access-wa");
    await sourceMap(db).deleteMany({ location_id: "access-wa", source_id: { $in: ["library", "meetings"] } });
    const candidates = [{ id: "access-wa", name: "Access, WA" }];
    await sourceMap(db).updateOne({ _id: "access-wa:source" }, { $set: { link_only: true } });
    expect((await locationReadinessForIds(db, candidates))[0]).toMatchObject({ can_mark_ready: false, active_source_count: 0 });
    await sourceMap(db).updateOne({ _id: "access-wa:source" }, { $set: { link_only: false } });
    await sourceMap(db).insertOne({
      ...(await sourceMap(db).findOne({ _id: "access-wa:source" }))!,
      _id: "access-wa:policy", source_id: "policy", status: "paused",
      access_review: { inventory_ids: ["fixture"], decision: "permission_required", collection_allowed: false,
        reason: "Permission required", evidence: ["https://publisher.example.test/terms"], checked_on: "2000-01-01", expires_on: "2099-12-31",
        images_allowed: false, allowed_urls: [], collection_params: {}, collection_reader: "web" },
    });
    expect((await locationReadinessForIds(db, candidates))[0]).toMatchObject({ can_mark_ready: false, active_source_count: 0 });
    expect((await sourceMap(db).findOne({ _id: "access-wa:source" }))?.access_review).toBeUndefined();
  });

  it("keeps reviewed maps tied to their exact location ID and explains empty-map recovery without rerunning or copying", async () => {
    const id = "ballard-seattle-wa";
    await db.collection(COLLECTIONS.locations).insertMany([
      location(id, "Ballard, WA", "ready"),
      location("legacy-ballard-wa", "Ballard, WA", "ready"),
    ]);
    await seedSources("legacy-ballard-wa");
    await saveSourceReview(db, "legacy-ballard-wa", "source", { decision: "accept" }, principal.email);
    const reviewed = (await sourceMap(db).findOne({ _id: "legacy-ballard-wa:source" }))!;
    await runSources(db, "isolated-ballard").insertOne({ ...reviewed, _id: `${id}:source`, location_id: id });
    const before = await sourceMap(db).find({}).toArray();
    const [current] = await locationReadinessForIds(db, [{ id, name: "Ballard, WA" }]);
    expect(current).toMatchObject({ ready: false, can_mark_ready: false, active_source_count: 0, source_coverage: { status: "no_local_sources" } });
    await expect(transitionLocationReadiness(db, id, "ready", principal)).rejects.toThrow(/at least one (?:active|usable) source/);
    ui.api.mockResolvedValue({ sections: [], sources: [], discovery: [] });
    const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
    vi.stubGlobal("window", window); vi.stubGlobal("document", document);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(document.getElementById("root")!);
    try {
      await act(async () => root.render(createElement(SourceMapManager, { locationId: id })));
      const panel = document.querySelector(".source-network")!;
      expect(panel.textContent).toContain(`Location ID: ${id}`);
      expect(panel.textContent).toContain("No saved sources are available for this location ID");
      expect(panel.textContent).toContain("before starting another run");
      expect(panel.querySelector(`a[href="/locations/${id}/source-map?tab=runs"]`)).not.toBeNull();
      expect(panel.querySelector(`a[href="/locations/${id}?tab=settings#location-evidence"]`)).not.toBeNull();
      expect(ui.api).toHaveBeenCalledTimes(1);
      expect(ui.api).toHaveBeenCalledWith(`locations/${id}/source-map`);
      ui.api.mockImplementation(async (path: string) => {
        if (path === "overview") return { work_queue: [], locations: [{
          location_id: "legacy-ballard-wa", location_name: "Ballard, WA", state: "WA", readiness: null,
        }] };
        if (path === "current-runs") return { runs: [] };
        if (path === "output-channels") return { directory: [{
          id: "reader-site", name: "Legacy Reader", enabled: true, archivedAt: null, selectedLocationIds: ["legacy-ballard-wa"],
        }] };
        throw new Error(`Unexpected fixture read: ${path}`);
      });
      Object.defineProperty(window, "location", { configurable: true, value: { search: "" } });
      await act(async () => root.render(createElement(LocationDirectory)));
      const coverageLink = document.querySelector('a[href="/admin/publications/reader-site"]');
      expect(coverageLink?.textContent).toContain("Manage community coverage");
      expect(document.querySelector('a[href="/admin/access?publicationId=reader-site"]')?.textContent).toBe("Assign journalists");
      expect(await sourceMap(db).find({}).toArray()).toEqual(before);
      expect(await sourceMap(db).countDocuments({ location_id: id })).toBe(0);
      expect(await db.collection(COLLECTIONS.jobs).countDocuments()).toBe(0);
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals(); ui.api.mockReset();
    }
  });

  it("audits reasoned suspension and resumption without retracting history or bypassing lost evidence", async () => {
    await db.collection(COLLECTIONS.locations).insertOne(location("suspend-wa", "Suspend, WA", "ready"));
    await seedSources("suspend-wa");
    await transitionLocationReadiness(db, "suspend-wa", "ready", principal);
    await expect(transitionLocationReadiness(db, "suspend-wa", "blocked", principal)).rejects.toThrow("blocking reason");
    expect(await transitionLocationReadiness(db, "suspend-wa", "blocked", principal, "Checking access rights")).toMatchObject({ state: "blocked", ready: false });
    await expect(transitionLocationReadiness(db, "suspend-wa", "ready", principal)).rejects.toThrow("resume reason");
    await sourceMap(db).updateMany({ location_id: "suspend-wa" }, { $set: { status: "paused" } });
    await expect(transitionLocationReadiness(db, "suspend-wa", "ready", principal, "Reviewed")).rejects.toThrow("usable source");
    expect(await transitionLocationReadiness(db, "suspend-wa", "preparing", principal, "Repair source coverage")).toMatchObject({ state: "preparing", ready: false });
    expect((await db.collection(COLLECTIONS.locations).findOne({ _id: "suspend-wa" }))?.preparation_events.map((event: { to: string }) => event.to)).toEqual(["ready", "blocked", "preparing"]);
  });
});
