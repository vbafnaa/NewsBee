import { act, createElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { beforeEach, expect, it, vi } from "vitest";
import CampaignsPage from "@/app/admin/campaigns/page";
import { AdminNavigation, AdminSectionNavigation, type AdminPage } from "@/app/admin-navigation";
import NewsletterDelivery from "@/app/newsletter/newsletter-delivery";
import SystemPage from "@/app/health/page";
import SourceReview from "@/app/source-map/source-review";
import AccessManagement from "@/app/admin/access/access-management";
import GovernancePanel from "@/app/admin/publication-governance/governance-panel";
import NewsroomManagement from "@/app/admin/publications/newsroom-management";
import LocationDirectory from "@/app/locations/location-directory";
import CommunityIntakeReview from "@/app/inbox/community-intake-review";
import { CAMPAIGN_ATTRIBUTION_KEYS, type CampaignLead } from "@/pipeline/campaigns/leads";

const mocks = vi.hoisted(() => ({ list: vi.fn(), principal: vi.fn(), pathname: "/admin" }));
vi.mock("@/lib/portal-access", () => ({ requireOperatorPrincipal: mocks.principal }));
vi.mock("@/lib/admin-session", () => ({ currentAdmin: async () => "operator@example.test" }));
vi.mock("@/pipeline/storage/mongo", () => ({ getDatabase: vi.fn(async () => ({})) }));
vi.mock("@/pipeline/campaigns/leads", async (original) => ({
  ...await original<typeof import("@/pipeline/campaigns/leads")>(),
  listCampaignLeads: mocks.list,
}));
vi.mock("@/app/admin-shell", () => ({
  default: ({ children }: { children: ReactNode }) => createElement("main", null, children),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => mocks.pathname }));
vi.mock("next/link", () => ({
  default: (props: ComponentProps<"a">) => createElement("a", props),
}));
vi.mock("@/app/locations/[locationId]/source-map-manager", () => ({
  default: ({ editable = false }: { editable?: boolean }) => createElement("div", { "data-editable": String(editable) }),
}));
vi.mock("@/app/source-map/source-runs", () => ({
  default: ({ canEdit, editHref, runId }: { canEdit: boolean; editHref: string; runId: string }) =>
    createElement("section", { "data-editable": String(canEdit), "data-run": runId },
      createElement("a", { href: editHref }, "Review in the workspace")),
}));

const lead: CampaignLead = {
  email: "city.desk@example.test",
  campaign: "newsroom",
  context: "Community reporting and a long description of our newsroom",
  role: "Editor or publisher",
  interest: "Organizing sources and drafts",
  attribution: { utm_source: "community", utm_medium: "referral", utm_campaign: "pilot", utm_content: "invite", utm_term: "local" },
  createdAt: "2026-02-10T12:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pathname = "/admin";
  mocks.principal.mockResolvedValue({ email: "operator@example.test", role: "admin" });
  mocks.list.mockResolvedValue({ leads: [lead], total: 101, page: 2, pages: 3 });
});

it("keeps core campaign identity and context outside attribution disclosure and preserves GET navigation", async () => {
  const query = { campaign: "newsroom", role: lead.role, interest: lead.interest, utm_source: "community", from: "2026-02-01", to: "2026-02-28", page: "2" };
  const document = parseHTML(renderToStaticMarkup(await CampaignsPage({ searchParams: Promise.resolve(query) }))).document;
  const card = document.querySelector(".campaign-lead-card")!;
  const details = card.querySelector("details")!;
  expect(details.hasAttribute("open")).toBe(false);
  for (const key of CAMPAIGN_ATTRIBUTION_KEYS) expect(details.textContent).toContain(lead.attribution[key]);
  details.remove();
  for (const value of [lead.email, "Newsroom", lead.context, lead.role, lead.interest]) expect(card.textContent).toContain(value);
  expect(card.querySelector("time")?.getAttribute("dateTime")).toBe(lead.createdAt);
  expect(document.querySelector("table")).toBeNull();
  expect(document.querySelector("form")?.getAttribute("method")).toBe("get");
  for (const anchor of document.querySelectorAll(".campaign-pagination a")) {
    const params = new URL(anchor.getAttribute("href")!, "https://newsbee.test").searchParams;
    for (const [key, value] of Object.entries(query)) if (key !== "page") expect(params.get(key)).toBe(value);
  }
  const csv = new URL(document.querySelector('a[href^="/api/admin/campaigns/export"]')!.getAttribute("href")!, "https://newsbee.test");
  expect(csv.searchParams.has("page")).toBe(false);
  expect(csv.searchParams.get("utm_source")).toBe("community");
});

it("surfaces invalid campaign queries instead of showing empty success or offering an export", async () => {
  const document = parseHTML(renderToStaticMarkup(await CampaignsPage({ searchParams: Promise.resolve({ page: "0" }) }))).document;
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Invalid page");
  expect(document.querySelector(".campaign-results")).toBeNull();
  expect(document.querySelector('a[href^="/api/admin/campaigns/export"]')).toBeNull();
  expect(mocks.list).not.toHaveBeenCalled();
});

it.each([true, false])("groups daily navigation for owner=%s without duplicate legacy entries", (owner) => {
  const document = parseHTML(renderToStaticMarkup(createElement(AdminNavigation, { page: "health", owner }))).document;
  expect([...document.querySelectorAll("a")].map((link) => link.textContent)).toEqual([
    "Newsrooms workspace", "Locations", "Newsrooms", "People", "Inbox", "Marketing", "System",
    owner ? "Environment & API settings" : "Personal API keys",
  ]);
  expect(document.querySelector('a[aria-current="page"]')?.getAttribute("href")).toBe("/health");
  for (const path of ["/discovery", "/edition-map", "/source-map", "/newsletter", "/neighbour-stories", "/remembrance", "/clear-data"]) {
    expect(document.querySelector(`a[href="${path}"]`)).toBeNull();
  }
});

it.each([
  ["source-map", "/admin"], ["edition-map", "/admin/publications"], ["publication-governance", "/admin/publications"],
  ["neighbour-stories", "/inbox"], ["remembrance", "/inbox"], ["campaigns", "/admin/video-campaigns"],
  ["interest-usage", "/admin/video-campaigns"], ["newsletter", "/health"], ["drive-diagnostics", "/health"],
  ["site-backup", "/health"], ["clear-data", "/health"],
] satisfies [AdminPage, string][])("identifies deep-linked %s with its daily product area", (page, href) => {
  const document = parseHTML(renderToStaticMarkup(createElement(AdminNavigation, { page, owner: true }))).document;
  expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  expect(document.querySelector('[aria-current="page"]')?.getAttribute("href")).toBe(href);
});

it.each([true, false])("keeps System recovery owner-only and labels historical email truthfully for owner=%s", (owner) => {
  const document = parseHTML(renderToStaticMarkup(createElement(AdminSectionNavigation, { page: "clear-data", owner }))).document;
  expect(document.querySelector('a[href="/newsletter"]')?.textContent).toBe("Audience & delivery history (email unavailable)");
  expect(document.querySelector('a[href="/drive-diagnostics"]')?.textContent).toBe("Storage");
  expect(document.querySelector('a[href="/health"]')?.textContent).toContain("video diagnostics");
  expect(Boolean(document.querySelector('a[href="/site-backup"]'))).toBe(owner);
  expect(Boolean(document.querySelector('a[href="/clear-data"]'))).toBe(owner);
  if (owner) {
    expect(document.querySelector("details")?.hasAttribute("open")).toBe(true);
    expect(document.querySelector("details")?.textContent).toContain("replaces accounts and governance and revokes sessions");
  }
});

it("keeps Marketing read-only leads and external analytics distinct from private paid videos", () => {
  const document = parseHTML(renderToStaticMarkup(createElement(AdminSectionNavigation, { page: "campaigns", owner: false }))).document;
  expect(document.querySelector('a[href="/admin/video-campaigns"]')?.textContent).toBe("Video campaigns");
  expect(document.querySelector('a[aria-current="page"]')?.textContent).toBe("Campaign requests (read-only)");
  expect(document.querySelector('a[href="/interest-usage"]')?.textContent).toBe("Insights / Google Analytics (external)");
  expect(document.querySelector("button, form")).toBeNull();
  for (const owner of [true, false]) {
    const rooms = parseHTML(renderToStaticMarkup(createElement(AdminSectionNavigation, { page: "output-channels", owner }))).document;
    expect(Boolean(rooms.querySelector('a[href="/admin/publication-governance"]'))).toBe(owner);
    expect(rooms.querySelector('a[href="/edition-map"]')).toBeNull();
  }
});

it("makes Desktop Video reachable from System without presenting an email workflow", async () => {
  const tree = await SystemPage({ searchParams: Promise.resolve({ view: "video" }) });
  const document = parseHTML(renderToStaticMarkup(tree)).document;
  expect(document.querySelector('a[href="/health?view=video"]')?.getAttribute("aria-current")).toBe("page");
  expect(document.querySelector("main")?.textContent).not.toContain("Email sending");
  expect(document.querySelector("main")?.textContent).toContain("Loading video diagnostics");
});

it.each([true, false])("reads diagnostics without writes and keeps email unavailable in history mode, videoOnly=%s", async (videoOnly) => {
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal("window", window); vi.stubGlobal("document", document); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({
    active: 3, pending: 2, unsubscribed: 1, queued: 4, sent: 5, failed: 1, failures: [],
    publication: { subscriptions: { active: 7 }, campaigns: 2, deliveries: { accepted: 8 }, localOutbox: 0 },
    releaseVideo: { desktop: { state: "error", detail: "Desktop configuration unavailable" }, total: 9, recent: 2,
      statuses: { failed: 1 }, providers: { desktop: 9 }, funding: { personal: 9 }, auditEvents: 10 },
  }));
  vi.stubGlobal("fetch", fetch);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(NewsletterDelivery, { videoOnly })));
    expect(document.body.textContent).toContain("Desktop Video configuration error");
    expect(document.querySelector(".alert")?.textContent).toBe("Desktop configuration unavailable");
    expect(document.body.textContent).toContain("personal: 9");
    expect(document.querySelector("#newsletter-unavailable") !== null).toBe(!videoOnly);
    expect(document.querySelector("button, form")).toBeNull();
    if (videoOnly) {
      expect(document.body.textContent).not.toContain("Community and location editions");
    } else {
      expect(document.body.textContent).toContain("Nothing is sent or activated");
      expect(document.body.textContent).toContain("Email sending, retries and previews are unavailable");
      expect(document.body.textContent).toContain("Community and publication consent remain separate");
    }
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("/api/admin/newsletter");
    expect(fetch.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("keeps a single Locations destination active across onboarding fragments", async () => {
  const { window, document } = parseHTML("<html><body><div id=\"root\"></div></body></html>");
  const location = { hash: "#onboarding", origin: "https://newsbee.test" };
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(window, "location", { configurable: true, value: location });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(AdminNavigation, { page: "locations", owner: true })));
    const active = () => document.querySelectorAll('a[aria-current="page"]');
    expect(active().length).toBe(1);
    expect(active()[0].textContent).toBe("Locations");
    expect(active()[0].getAttribute("href")).toBe("/admin");
    expect(document.querySelectorAll(".sidebar-link.active")).toHaveLength(1);
    await act(async () => {
      location.hash = "";
      window.dispatchEvent(new window.Event("popstate"));
    });
    expect(active()[0].textContent).toBe("Locations");
    await act(async () => {
      location.hash = "#location-requests";
      window.dispatchEvent(new window.Event("hashchange"));
    });

    expect(active()[0].textContent).toBe("Locations");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("routes location settings to one global directory without duplicate Operations navigation", () => {
  mocks.pathname = "/locations/north";
  const document = parseHTML(renderToStaticMarkup(createElement(AdminNavigation, { page: "locations", owner: true }))).document;
  expect([...document.querySelectorAll("a")].filter((item) => item.getAttribute("href") === "/admin")).toHaveLength(1);
  expect(document.querySelector('a[href="/admin"]')?.textContent).toBe("Locations");
});

it("requires explicit archive confirmation and restores with the refreshed lifecycle revision", async () => {
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal("window", window); vi.stubGlobal("document", document); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const channel = { id: "north", name: "North News", enabled: true, archivedAt: null as number | null,
    selectedLocationIds: ["town"], lifecycleRevision: 4, destinations: [{ type: "reader" }], accessMode: "inspection" };
  const mutations: Array<{ method: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method) {
      mutations.push({ method: init.method, body: JSON.parse(init.body as string) });
      channel.archivedAt = init.method === "DELETE" ? 123 : null;
      channel.lifecycleRevision += 1;
    }
    return Response.json({ directory: [channel] });
  }));
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  const click = async (label: string) => {
    const button = [...document.querySelectorAll("button")].find((item) => item.textContent === label)!;
    expect(button).toBeDefined();
    await act(async () => button.click());
  };
  try {
    await act(async () => root.render(createElement(NewsroomManagement)));
    expect(document.querySelector('a[href="/newsroom/north"]')?.textContent).toBe("Inspect newsroom");
    expect(document.querySelector('a[href="/admin/access?publicationId=north"]')).not.toBeNull();
    await click("Archive newsroom");
    expect(mutations).toHaveLength(0);
    expect(document.querySelector('[aria-label="Confirm archive change for North News"]')?.textContent).toContain("without deleting editions");
    await click("Confirm archive");
    expect(mutations[0]).toEqual({ method: "DELETE", body: { id: "north", lifecycleRevision: 4 } });
    expect(document.querySelector('[aria-label="Current newsrooms"]')).toBeNull();
    const archive = document.querySelector('[aria-label="Archived newsrooms and legacy destinations"]')!.parentElement!;
    expect(archive.textContent).toContain("North News");
    expect(document.querySelector('a[href="/newsroom/north"]')?.textContent).toBe("Inspect retained newsroom");
    await click("Restore newsroom");
    expect(archive.hasAttribute("open")).toBe(true);
    expect(mutations).toHaveLength(1);
    await click("Confirm restore");
    expect(mutations[1]).toEqual({ method: "PATCH", body: { id: "north", lifecycleRevision: 5, action: "restore" } });
    expect(document.querySelector('[role="status"]')?.textContent).toContain("Published history retained");
    expect(document.querySelector('[aria-label="Current newsrooms"]')?.textContent).toContain("North News");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("keeps current and paused newsrooms primary while preserving archived maintenance handoffs", async () => {
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal("window", window); vi.stubGlobal("document", document); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const room = { enabled: true, archivedAt: null, selectedLocationIds: ["town"], lifecycleRevision: 4,
    destinations: [{ type: "reader" }], accessMode: "inspection" };
  const fetch = vi.fn(async () => Response.json({ directory: [
    { ...room, id: "reader-site", name: "Legacy Reader", enabled: false, archivedAt: 123 },
    { ...room, id: "north", name: "North News", accessMode: "direct" },
    { ...room, id: "paused", name: "Paused News", enabled: false },
  ] }));
  vi.stubGlobal("fetch", fetch);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(NewsroomManagement)));
    const current = document.querySelector('[aria-label="Current newsrooms"]')!;
    expect(current.querySelectorAll("h3")).toHaveLength(2);
    expect(current.textContent).toContain("Paused News");
    expect(current.textContent).not.toContain("Legacy Reader");
    expect(current.querySelector('a[href="/newsroom/north"]')?.textContent).toBe("Open newsroom");
    expect(current.querySelector('a[href="/newsroom/paused"]')?.textContent).toBe("Inspect newsroom");
    const archived = document.querySelector('[aria-label="Archived newsrooms and legacy destinations"]')!;
    expect(archived.parentElement?.hasAttribute("open")).toBe(false);
    expect(archived.querySelector('a[href="/newsroom/reader-site"]')?.textContent).toBe("Inspect retained newsroom");
    expect(archived.querySelector('a[href="/admin/access?publicationId=reader-site"]')).not.toBeNull();
    expect(archived.querySelector('a[href="/admin/publication-governance?publicationId=reader-site"]')).not.toBeNull();
    const maintenance = archived.querySelector("details")!;
    expect(maintenance.hasAttribute("open")).toBe(false);
    expect(maintenance.querySelector('a[href="/admin/publications/reader-site"]')?.textContent).toBe("Delivery & storage");
    expect(maintenance.textContent).toContain("Restore newsroom");
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("routes daily source management to the editor and keeps read-only inspection secondary", async () => {
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal("window", window); vi.stubGlobal("document", document); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(window, "location", { configurable: true, value: { search: "" } });
  const fetch = vi.fn(async (url: string) => {
    if (url === "/api/admin/overview") return Response.json({ work_queue: [], locations: ["ready", "preparing"].map((state) => ({
      location_id: state, location_name: `${state} location`, state: "WA",
      readiness: { state, active_source_count: 4, missing_prerequisites: [] },
    })) });
    if (url === "/api/admin/output-channels") return Response.json({ directory: [] });
    if (url === "/api/admin/current-runs") return Response.json({ runs: [] });
    if (url === "/api/admin/execution") return Response.json({ reasons: [], permissions: {}, blocker: null });
    throw new Error(`Unexpected fixture read: ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(LocationDirectory)));
    const rows = [...document.querySelectorAll(".location-directory-row")];
    expect(rows).toHaveLength(2);
    for (const [index, id] of ["ready", "preparing"].entries()) {
      const actions = rows[index].querySelector(".location-directory-actions")!;
      expect(actions.querySelector("a.button")?.getAttribute("href")).toBe(`/locations/${id}?tab=sources`);
      expect(actions.querySelector("a.button")?.textContent).toBe("Manage sources");
      const inspector = actions.querySelector(`a[href="/locations/${id}/source-map"]`)!;
      expect(inspector.textContent).toBe("Inspect source map (read-only)");
      expect(inspector.classList.contains("button")).toBe(false);
    }
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(fetch.mock.calls).toHaveLength(4);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("keeps source inspection read-only and carries the exact selected location/run into the workspace", () => {
  const props = { locationId: "north /1", runId: "run /3", signedIn: true, showLocationPicker: false };
  const document = parseHTML(renderToStaticMarkup(createElement(SourceReview, { ...props, tab: "runs" }))).document;
  expect(document.querySelector('[data-editable="false"]')?.getAttribute("data-run")).toBe(props.runId);
  const handoff = new URL(document.querySelector("section a")!.getAttribute("href")!, "https://newsbee.test");
  expect(handoff.pathname).toBe("/locations/north%20%2F1");
  expect(handoff.searchParams.get("tab")).toBe("collect-sources");
  expect(handoff.searchParams.get("run")).toBe(props.runId);
  for (const anchor of document.querySelectorAll(".tabs a")) {
    const params = new URL(anchor.getAttribute("href")!, "https://newsbee.test").searchParams;
    expect(params.get("location")).toBe(props.locationId);
    expect(params.get("run")).toBe(props.runId);
    expect(anchor.textContent).toContain("read-only");
  }
  const sources = parseHTML(renderToStaticMarkup(createElement(SourceReview, { ...props, tab: "sources" }))).document;
  expect(sources.querySelector('[data-editable="false"]')).not.toBeNull();
  expect(sources.querySelector('a.button')?.getAttribute("href")).toBe("/locations/north%20%2F1?tab=sources");
});

const reviewFixture = () => ({
  sections: [{ id: "news", label: "News" }, { id: "events", label: "Events" }],
  sources: [
    { _id: "north:one", location_id: "north", source_id: "one", name: "Council", url: "https://council.example.test", reader: "web", section: "news", status: "active", inside_area: true,
      review: { decision: "accept", reason_code: "A1", reason: null, initial_status: "proposed" },
      found_by: { method: "agent", detail: "Full provenance", how_found: "Public directory" }, found_by_label: "Agent", window_label: "35 days", score: 1,
      health: { runs: 2, items_found: 3, items_local: 2, items_published: 1, consecutive_failures: 1, empty_runs: 0, last_status: "failed", last_detail: "Full diagnostics ".repeat(30), last_run_at: null, last_new_item_day: null },
      gemini: { verdict: "accept", reason_code: "A1", reason: "Model reason", evidence: "Full model evidence", note: null },
    },
    { _id: "north:two", location_id: "north", source_id: "two", name: "Library", url: null, reader: "library", section: "events", status: "paused", inside_area: true,
      review: { decision: "reject", reason_code: "R6", reason: null, initial_status: "proposed" },
      found_by: { method: "fixed", detail: "Profile" }, found_by_label: "Fixed", window_label: null, score: 1,
      health: { runs: 0, items_found: 0, items_local: 0, items_published: 0, consecutive_failures: 0, empty_runs: 0, last_status: null, last_detail: null, last_run_at: null, last_new_item_day: null },
      access_review: { decision: "permission_required", collection_allowed: false, reason: "Publisher permission required", expires_on: "2099-12-31", evidence: ["Full access evidence"] },
    },
  ], discovery: [], systems: [],
});

it("keeps compact source review failures, pending text and warnings through details, filters and unrelated refreshes", async () => {
  const { default: SourceMapManager } = await vi.importActual<typeof import("@/app/locations/[locationId]/source-map-manager")>("@/app/locations/[locationId]/source-map-manager");
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const confirm = vi.fn(() => false);
  window.confirm = confirm;
  const snapshot = reviewFixture();
  const olderSnapshot = structuredClone(snapshot);
  let fail = true;
  let deferRefresh = false;
  let finishRefresh: ((response: Response) => void) | undefined;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("source-sheet")) return Response.json({ sources: [] });
    if (init?.method === "PATCH") {
      const { source_id, ...change } = JSON.parse(init.body as string);
      if (source_id === "two" || "status" in change) return Response.json({});
      if (fail) return Response.json({ detail: "Review history unavailable" }, { status: 503 });
      Object.assign(snapshot.sources[0].review, change);
      return Response.json({ status: "active", review: snapshot.sources[0].review });
    }
    if (deferRefresh) return new Promise<Response>((resolve) => { finishRefresh = resolve; });
    return Response.json(snapshot);
  });
  vi.stubGlobal("fetch", fetch);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(SourceMapManager, { locationId: "north", editable: true })));
    const row = document.getElementById("one")!;
    const details = row.querySelector("details")!;
    expect(details.hasAttribute("open")).toBe(false);
    expect(row.querySelector(".source-review-controls")?.closest("details")).toBeNull();
    expect(row.querySelector(".source-review-identity")?.textContent).toContain("Live: active");
    expect(row.querySelector(".source-review-identity")?.textContent).toContain("Review: Accept");
    expect(details.textContent).toContain(snapshot.sources[0].health.last_detail);
    expect(document.getElementById("two")?.querySelector(".source-review-identity")?.textContent).toContain("Publisher permission required");
    expect(document.querySelector(".source-network table")).toBeNull();
    const select = row.querySelector<HTMLSelectElement>('[aria-label="Reasoning for Council"]')!;
    const changeSelect = async (value: string) => act(async () => {
      // linkedom exposes selected options rather than a writable select.value.
      for (const option of select.querySelectorAll("option")) option.selected = false;
      select.querySelector<HTMLOptionElement>(`option[value="${value}"]`)!.selected = true;
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    await changeSelect("A6");
    const textarea = row.querySelector<HTMLTextAreaElement>("textarea")!;
    const props = Object.entries(textarea).find(([key]) => key.startsWith("__reactProps"))![1] as { onChange: (event: { target: { value: string } }) => void; onBlur: () => void };
    await act(async () => props.onChange({ target: { value: "Attempted reason with a long URL https://evidence.example.test/pending" } }));
    const currentProps = () => Object.entries(textarea).find(([key]) => key.startsWith("__reactProps"))![1] as typeof props;
    await act(async () => currentProps().onBlur());
    expect(row.querySelector('[role="alert"]')?.textContent).toContain("Review history unavailable");
    details.setAttribute("open", "");
    details.removeAttribute("open");
    expect(row.querySelector('[role="alert"]')?.closest("details")).toBeNull();
    const filter = document.querySelector<HTMLSelectElement>(".filters select")!;
    await act(async () => {
      for (const option of filter.querySelectorAll("option")) option.selected = false;
      filter.querySelector<HTMLOptionElement>('option[value="paused"]')!.selected = true;
      filter.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    expect(row.hidden).toBe(false);
    expect(row.querySelector("textarea")).toBe(textarea);
    expect(textarea.value).toContain("Attempted reason");
    const unload = new window.Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    // An operational change reloads an older server review, not the pending text.
    const resume = [...document.getElementById("two")!.querySelectorAll("button")].find((button) => button.textContent === "Resume")!;
    expect(resume.disabled).toBe(true);
    const pause = [...row.querySelectorAll("button")].find((button) => button.textContent === "Pause")!;
    deferRefresh = true;
    await act(async () => pause.click());
    expect(finishRefresh).toBeDefined();
    expect(textarea.value).toContain("Attempted reason");
    expect(select.value).toBe("A6");
    await changeSelect("A2");
    expect(confirm).toHaveBeenCalledOnce();
    expect(select.value).toBe("A6");
    fail = false;
    const retry = [...row.querySelectorAll("button")].find((button) => button.textContent === "Retry")!;
    await act(async () => retry.click());
    expect(snapshot.sources[0].review).toMatchObject({ decision: "accept", reason_code: "A6", reason: textarea.value });
    expect(row.querySelector('[role="alert"]')).toBeNull();
    // A read started before the successful retry cannot roll its result back.
    await act(async () => finishRefresh!(Response.json(olderSnapshot)));
    expect(textarea.value).toContain("Attempted reason");
    expect(select.value).toBe("A6");
    const persistedText = textarea.value;
    await act(async () => currentProps().onChange({ target: { value: `${persistedText} more` } }));
    expect(row.querySelector(".source-reason")?.textContent).not.toContain("Saved");
    await act(async () => currentProps().onChange({ target: { value: persistedText } }));
    await act(async () => currentProps().onBlur());
    expect(row.querySelector(".source-reason")?.textContent).not.toContain("Explanation not yet saved");
    expect(row.querySelector(".source-reason")?.textContent).toContain("Saved");
    // As before, a just-labelled row stays until the next status-filter change.
    expect(row.hidden).toBe(false);
    await act(async () => filter.dispatchEvent(new window.Event("change", { bubbles: true })));
    expect(row.hidden).toBe(true);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "PATCH").every(([, init]) => !JSON.parse(init!.body as string).decision)).toBe(true);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("renders the same complete source identity set read-only without activation or review controls", async () => {
  const { default: SourceMapManager } = await vi.importActual<typeof import("@/app/locations/[locationId]/source-map-manager")>("@/app/locations/[locationId]/source-map-manager");
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const snapshot = reviewFixture();
  const fetch = vi.fn(async (_url: string) => Response.json({
    ...snapshot, sources: snapshot.sources.map((source, index) => ({ ...source, link_only: index === 0 })),
  }));
  vi.stubGlobal("fetch", fetch);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(SourceMapManager, { locationId: "north" })));
    expect([...document.querySelectorAll(".source-review-row")].map((row) => row.id)).toEqual(["one", "two"]);
    expect(document.querySelector(".source-review-row select, .source-review-row button, .source-review-row textarea")).toBeNull();
    expect(document.querySelector(".source-review-controls")?.textContent).toContain("Decision: Accept");
    expect(document.getElementById("one")?.querySelector(".source-review-status")?.textContent).toContain("Live: Non-scrapable");
    expect(document.querySelector('a[href="/locations/north?tab=sources"]')).not.toBeNull();
    expect(fetch.mock.calls.every(([url]) => !url.includes("/api/admin/"))).toBe(true);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("keeps the run-table consumer valid and newer reasoning intact while an older decision saves or retries", async () => {
  const { ReviewCells } = await vi.importActual<typeof import("@/app/locations/[locationId]/source-map-manager")>("@/app/locations/[locationId]/source-map-manager");
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.confirm = vi.fn(() => false);
  const source = { _id: "one", source_id: "one", location_id: "north", name: "Council", status: "proposed", review: { decision: null, reason_code: null, reason: null, initial_status: "proposed" } };
  type Result = { status: string; review: import("@/app/locations/[locationId]/source-map-manager").Review };
  let finishDecision!: (value: Result) => void;
  const first = new Promise<Result>((resolve) => { finishDecision = resolve; });
  const send = vi.fn()
    .mockReturnValueOnce(first)
    .mockResolvedValueOnce({ status: "active", review: { ...source.review, decision: "accept", reason_code: "A6" } })
    .mockResolvedValueOnce({ status: "active", review: { ...source.review, decision: "accept", reason_code: "A6", reason: "Newer typed explanation" } });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement("table", null, createElement("tbody", null, createElement("tr", null,
      createElement(ReviewCells, { source, canLabel: true, onSaved: vi.fn(), send }))))));
    const change = async (label: string, value: string) => act(async () => {
      const select = document.querySelector<HTMLSelectElement>(`[aria-label="${label} for Council"]`)!;
      for (const option of select.querySelectorAll("option")) option.selected = false;
      select.querySelector<HTMLOptionElement>(`option[value="${value}"]`)!.selected = true;
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    await change("Decision", "accept");
    await change("Reasoning", "A6");
    expect(window.confirm).not.toHaveBeenCalled();
    const box = document.querySelector<HTMLTextAreaElement>("textarea")!;
    const props = () => Object.entries(box).find(([key]) => key.startsWith("__reactProps"))![1] as { onChange: (event: { target: { value: string } }) => void; onBlur: () => void };
    await act(async () => props().onChange({ target: { value: "Newer typed explanation" } }));
    await act(async () => finishDecision({ status: "active", review: { ...source.review, decision: "accept" } }));
    expect(box.value).toBe("Newer typed explanation");
    expect(document.querySelector<HTMLSelectElement>('[aria-label="Reasoning for Council"]')?.value).toBe("A6");
    expect(document.querySelector("tr")?.children).toHaveLength(2);
    expect([...document.querySelector("tr")!.children].every((cell) => cell.tagName === "TD")).toBe(true);
    await act(async () => props().onBlur());
    expect(send.mock.calls.map(([change]) => change)).toEqual([
      { decision: "accept" }, { reason_code: "A6" }, { reason_code: "A6", reason: "Newer typed explanation" },
    ]);
    expect(document.querySelector(".source-reason")?.textContent).not.toContain("Explanation not yet saved");
    expect(document.querySelector(".source-reason")?.textContent).toContain("Saved");
    send.mockRejectedValueOnce(new Error("Decision unavailable"))
      .mockRejectedValueOnce(new Error("Reason does not match the saved decision"))
      .mockResolvedValueOnce({ status: "rejected", review: { ...source.review, decision: "reject" } })
      .mockResolvedValueOnce({ status: "rejected", review: { ...source.review, decision: "reject", reason_code: "R9", reason: "Failed verdict explanation" } });
    await change("Decision", "reject");
    await change("Reasoning", "R9");
    const failedBox = document.querySelector<HTMLTextAreaElement>("textarea")!;
    const failedProps = () => Object.entries(failedBox).find(([key]) => key.startsWith("__reactProps"))![1] as ReturnType<typeof props>;
    await act(async () => failedProps().onChange({ target: { value: "Failed verdict explanation" } }));
    await act(async () => document.querySelector<HTMLButtonElement>(".source-decision button")!.click());
    expect(document.querySelector<HTMLSelectElement>('[aria-label="Reasoning for Council"]')?.value).toBe("R9");
    expect(failedBox.value).toBe("Failed verdict explanation");
    expect(document.querySelector(".source-reason [role=alert]")?.textContent).toContain("Reason does not match");
    await act(async () => document.querySelector<HTMLButtonElement>(".source-reason button")!.click());
    expect(send.mock.calls.at(-1)?.[0]).toEqual({ reason_code: "R9", reason: "Failed verdict explanation" });
    expect(document.querySelector("[role=alert]")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it.each(["owner", "admin"] as const)("keeps %s access controls collapsed, preserves pending assignments and exposes failed changes", async (role) => {
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const snapshot = {
    actor: { id: role, email: `${role}@example.test`, role },
    accounts: [
      { principalId: "owner", email: "owner@example.test", role: "owner", enabled: true, revision: 0, publicationIds: [] },
      { principalId: "admin", email: "admin@example.test", role: "admin", enabled: true, revision: 0, publicationIds: [], passwordStatus: "credentials_set" },
      { principalId: "editor", email: "editor@example.test", role: "editor", enabled: true, revision: 0, publicationIds: ["legacy"], passwordStatus: "invited" },
    ],
    publications: [
      { id: "north", name: "North News", enabled: true, archivedAt: null },
      { id: "legacy", name: "Legacy Reader", enabled: false, archivedAt: 123 },
      { id: "paused", name: "Paused News", enabled: false, archivedAt: null },
    ],
  };
  let conflict = true;
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      if (conflict) return Response.json({ detail: "Assignments changed concurrently. Reload and retry." }, { status: 409 });
      snapshot.accounts[2].revision += 1;
      const patch = JSON.parse(init.body as string);
      if (patch.publicationIds !== undefined) snapshot.accounts[2].publicationIds = patch.publicationIds;
      if (patch.enabled !== undefined) snapshot.accounts[2].enabled = patch.enabled;
      return Response.json({ account: snapshot.accounts[2] });
    }
    if (init?.method === "POST") return Response.json(JSON.parse(init.body as string).action === "password-reset"
      ? { recovery: { expiresAt: new Date(Date.now() + 3_600_000).toISOString(), resetUrl: "https://newsbee.test/reset-password#synthetic" } }
      : { invitation: { expiresAt: new Date(Date.now() + 3_600_000).toISOString(), signupUrl: "https://newsbee.test/signup#synthetic" } });
    return Response.json(snapshot);
  });
  vi.stubGlobal("fetch", fetch);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(AccessManagement, { publicationId: "north", email: "applicant@example.test" })));
    expect(document.querySelector<HTMLInputElement>("#access-email")?.defaultValue).toBe("applicant@example.test");
    expect(document.querySelector('a[href="/newsroom/north"]')?.textContent).toBe("North News");
    expect(document.body.textContent).toContain("Username/password not set");
    expect(document.body.textContent).not.toContain("Password setup required");
    if (role === "owner") {
      expect(document.body.textContent).toContain("Change to Journalist");
      expect(document.body.textContent).not.toContain("Change to Editor");
    }
    expect(fetch.mock.calls.every(([, init]) => !init?.method)).toBe(true);
    const cards = [...document.querySelectorAll(".access-account-card")];
    if (role === "admin") {
      expect(cards[0].querySelector("h3")?.textContent).toBe("editor@example.test");
      const roster = [...document.querySelectorAll("summary")].find((node) => node.textContent?.startsWith("Owner and Admins"))!.parentElement!;
      expect(roster.hasAttribute("open")).toBe(false);
      expect(roster.textContent).toContain("owner@example.test");
      expect(roster.textContent).toContain("admin@example.test");
    }
    const editor = cards.find((card) => card.querySelector("h3")?.textContent === "editor@example.test")!;
    const details = editor.querySelector("details")!;
    expect(details.hasAttribute("open")).toBe(false);
    expect(editor.querySelector("h3")?.closest("details")).toBeNull();
    expect(editor.textContent).toContain("Setup link issued (not yet completed)");
    expect(editor.textContent).toContain("Legacy Reader (archived)");
    expect(editor.textContent).not.toContain("Legacy Reader (paused)");
    expect(editor.textContent).toContain("Paused News (paused)");
    const archivedAssignments = details.querySelector("details")!;
    expect(archivedAssignments.hasAttribute("open")).toBe(false);
    expect(archivedAssignments.querySelector<HTMLInputElement>("input")?.checked).toBe(true);
    expect([...document.querySelectorAll(".access-account-actions")]).toHaveLength(role === "owner" ? 2 : 1);
    const checkbox = details.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox.checked).not.toBe(true);
    await act(async () => {
      details.setAttribute("open", "");
      checkbox.checked = true;
      checkbox.dispatchEvent(new window.Event("click", { bubbles: true }));
    });
    const save = [...details.querySelectorAll("button")].find((button) => button.textContent === "Save newsroom assignments")!;
    expect(save.disabled).toBe(false);
    details.removeAttribute("open");
    details.setAttribute("open", "");
    expect(details.querySelector("input")).toBe(checkbox);
    expect(checkbox.checked).toBe(true);
    await act(async () => save.click());
    expect(JSON.parse(fetch.mock.calls.find(([, init]) => init?.method === "PATCH")![1]!.body as string))
      .toMatchObject({ targetPrincipalId: "editor", expectedRevision: 0, publicationIds: ["legacy", "north"] });
    const alert = document.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("Assignments changed concurrently");
    expect(alert.closest("details")).toBeNull();
    expect(details.hasAttribute("open")).toBe(true);
    expect(checkbox.checked).toBe(true);
    expect(editor.querySelector("button.danger")?.textContent).toBe("Disable journalist");
    if (role === "admin") expect(editor.textContent).not.toContain("Promote to Admin");
    conflict = false;
    await act(async () => save.click());
    expect(editor.querySelector("details")).toBe(details);
    expect(details.hasAttribute("open")).toBe(true);
    expect(details.querySelector<HTMLInputElement>("input")?.checked).toBe(true);
    expect([...details.querySelectorAll("button")].find((button) => button.textContent === "Save newsroom assignments")?.disabled).toBe(true);
    await act(async () => [...details.querySelectorAll("button")].find((button) => button.textContent === "Create signup link")!.click());
    details.removeAttribute("open");
    const notice = editor.querySelector('[role="status"]')!;
    expect(notice.closest("details")).toBeNull();
    expect(notice.textContent).toContain("No email sent.");
    expect(editor.querySelector<HTMLInputElement>('input[aria-label="signup link"]')?.value).toBe("https://newsbee.test/signup#synthetic");
    const clipboard = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText: clipboard } });
    const copy = [...editor.querySelectorAll("button")].find((button) => button.textContent === "Copy link")!;
    await act(async () => copy.click());
    expect(clipboard).toHaveBeenCalledWith("https://newsbee.test/signup#synthetic");
    expect(editor.textContent).toContain("Link copied.");
    clipboard.mockRejectedValue(new Error("Permission denied"));
    await act(async () => copy.click());
    expect(editor.querySelector('[role="alert"]')?.textContent).toContain("Could not copy");
    expect(editor.textContent).not.toContain("Link copied.");
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    await act(async () => {
      const current = details.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
      current.checked = false;
      current.dispatchEvent(new window.Event("click", { bubbles: true }));
    });
    await act(async () => [...details.querySelectorAll("button")].find((button) => button.textContent === "Save newsroom assignments")!.click());
    expect(JSON.parse(fetch.mock.calls.findLast(([, init]) => init?.method === "PATCH")![1]!.body as string))
      .toMatchObject({ publicationIds: ["legacy"] });
    expect(editor.querySelector<HTMLInputElement>('input[aria-label="signup link"]')?.value).toBe("https://newsbee.test/signup#synthetic");
    if (role === "owner") {
      const admin = cards.find((card) => card.querySelector("h3")?.textContent === "admin@example.test")!;
      await act(async () => [...admin.querySelectorAll("button")].find((button) => button.textContent === "Create recovery link")!.click());
      expect(admin.querySelector<HTMLInputElement>('input[aria-label="recovery link"]')?.value).toBe("https://newsbee.test/reset-password#synthetic");
      expect(editor.querySelector<HTMLInputElement>('input[aria-label="signup link"]')?.value).toBe("https://newsbee.test/signup#synthetic");
    }
    window.confirm = vi.fn(() => true);
    await act(async () => [...editor.querySelectorAll("button")].find((button) => button.textContent === "Disable journalist")!.click());
    expect(JSON.parse(fetch.mock.calls.findLast(([, init]) => init?.method === "PATCH")![1]!.body as string))
      .toMatchObject({ targetPrincipalId: "editor", enabled: false });
    expect(editor.querySelector("fieldset")?.hasAttribute("disabled")).toBe(true);
    await act(async () => [...editor.querySelectorAll("button")].find((button) => button.textContent === "Re-enable journalist")!.click());
    expect(JSON.parse(fetch.mock.calls.findLast(([, init]) => init?.method === "PATCH")![1]!.body as string))
      .toMatchObject({ targetPrincipalId: "editor", enabled: true });
    expect(editor.querySelector("fieldset")?.hasAttribute("disabled")).toBe(false);
    await act(async () => root.render(null));
    const mutationCount = fetch.mock.calls.filter(([, init]) => init?.method).length;
    await act(async () => root.render(createElement(AccessManagement, { publicationId: "legacy" })));
    const archivedEditor = [...document.querySelectorAll(".access-account-card")]
      .find((card) => card.querySelector("h3")?.textContent === "editor@example.test")!;
    expect(archivedEditor.querySelector("details details")?.hasAttribute("open")).toBe(true);
    expect(fetch.mock.calls.filter(([, init]) => init?.method)).toHaveLength(mutationCount);
    await act(async () => root.render(createElement(AccessManagement, { publicationId: "foreign-newsroom" })));
    expect(document.querySelector('input[aria-label="signup link"]')).toBeNull();
    expect(document.querySelector('input[aria-label="recovery link"]')).toBeNull();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("requested newsroom is unavailable");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("keeps governance failures and unverified-entry warnings visible while optional forms stay mounted", async () => {
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const fetch = vi.fn(async (url: string) => {
    if (url.includes("/ownership")) return Response.json({ detail: "Ownership unavailable" }, { status: 503 });
    if (url.includes("/support")) return Response.json({ support: null });
    return Response.json({ records: [{
      id: "entry", kind: "access_policy", at: Date.now(), action: "account_created",
      actor: { principalId: "owner", email: "owner@example.test" }, entryIntegrity: false,
    }], nextCursor: null, restoreEvidence: [] });
  });

  vi.stubGlobal("fetch", fetch);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(GovernancePanel, { owner: true, publications: [{ id: "north", name: "North News" }] })));
    const disclosures = [...document.querySelectorAll("details")];
    expect(disclosures.map((node) => node.querySelector("summary")?.textContent)).toEqual(["Transfer ownership", "Audit history"]);
    expect(disclosures.every((node) => !node.hasAttribute("open"))).toBe(true);
    for (const alert of document.querySelectorAll('[role="alert"]')) expect(alert.closest("details")).toBeNull();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Ownership unavailable");
    expect([...document.querySelectorAll('[role="alert"]')].some((node) => node.textContent?.includes("could not be verified"))).toBe(true);
    const audit = disclosures[1];
    expect(audit.textContent).toContain("each entry only");
    const filter = audit.querySelector("input")!;
    filter.value = "pending-publication";
    audit.setAttribute("open", "");
    audit.removeAttribute("open");
    audit.setAttribute("open", "");
    expect(audit.querySelector("input")).toBe(filter);
    expect(filter.value).toBe("pending-publication");
    expect(fetch).toHaveBeenCalledTimes(3);
    fetch.mockResolvedValue(Response.json({ detail: "Audit unavailable" }, { status: 503 }));
    await act(async () => audit.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
    audit.removeAttribute("open");
    expect([...document.querySelectorAll('[role="alert"]')].find((node) => node.textContent === "Audit unavailable")?.closest("details")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("offers reviewed closed applicants a deliberate People handoff without treating review as approval", async () => {
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const applicant = {
    kind: "editor_interest", submitter_name: "Local reporter", submitter_email: "applicant+local@example.test",
    submitted_at: "2026-11-18T00:00:00Z", community_name: "North", experience: "Reporting",
    motivation: "Local stories", intent: "contribute",
  };
  const fetch = vi.fn(async () => Response.json({
    items: [
      { ...applicant, _id: "pending", status: "pending" },
      { ...applicant, _id: "reviewed", status: "closed", reviewed_by: "operator@example.test" },
    ], total: 2, page: 1, pages: 1,
  }));
  vi.stubGlobal("fetch", fetch);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(CommunityIntakeReview)));
    const links = document.querySelectorAll('a[href^="/admin/access?"]');
    expect(links).toHaveLength(1);
    expect(new URL(links[0].getAttribute("href")!, "https://newsbee.test").searchParams.get("email")).toBe(applicant.submitter_email);
    expect(links[0].parentElement?.textContent).toContain("Closed is not an approval or consent grant.");
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
