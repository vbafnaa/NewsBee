import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { Story, collapse, type SourceEvent } from "../../editions/stories";
import { EvidenceReader, EVIDENCE_LIMITS, evidenceFor, evidenceText, rankingDescription, selectPassages } from "../../editions/evidence";
import { extractDetails, groundDetails, itemTexts, saveText } from "../../editions/details";
import { authorNextStory, rankSection, type DraftDoc, type AuthoringDeps } from "../../editions/authoring";
import { defaultRunOptions, withRunContext } from "../../core/run-options";
import { loadSettings } from "../../core/config";
import type { HttpTransport } from "../../core/http";
import { COLLECTIONS } from "../../storage/mongo";
import { collectedItems } from "../../editions/assemble";
import * as storyReviews from "../../editions/story-reviews";
import { FakeModel } from "../support/fake-model";
import { ModelRateLimitError } from "../../model/runtime";
import { mainText, supportingLinks } from "../../connectors/web/page";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "93.184.216.34" }]) }));
vi.mock("../../editions/edition-map", () => ({ writeEditionMap: vi.fn().mockResolvedValue(undefined) }));
let server: MongoMemoryServer, client: MongoClient, db: Db, serial = 0;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
beforeAll(async () => { server = await MongoMemoryServer.create(); client = await MongoClient.connect(server.getUri()); db = client.db("source-evidence"); });
afterAll(async () => { await client?.close(); await server?.stop(); });
beforeEach(async () => { await db.dropDatabase(); vi.clearAllMocks(); });
const url = () => `https://evidence-${++serial}.example.test/news`;
function story(source = url(), description = "Garden plans will be considered.") {
  const item = new Story(`s-${serial}`, "Garden plans", description, "local_news");
  item.occurrences.push({ source_id: "web:garden", source_event_id: item.id, event_date: "2026-10-29", schedule_text: "October 29", venue: "Cedar Park", room: null, source_url: source });
  return item;
}
const opening = "The council approved a playground at Cedar Park.";
const action = "Residents can comment until November 8.";
const html = `<article><p>${opening}</p><p>${Array.from({ length: 20 }, (_, index) => `Stage ${index}: The project includes new paths and planting around the playground.`).join(" ")}</p><p>${action}</p></article>`;
function transport(body = html, headers = { "content-type": "text/html" }): HttpTransport {
  return vi.fn(async (request) => ({
    url: request.url, status: 200, headers, body: new TextEncoder().encode(request.url.endsWith("/robots.txt") ? "User-agent: *\nAllow: /" : body),
  }));
}
it("keeps actionable later sentences and decimal numbers within the exact bound", () => {
  const source = `${opening} ${"This paragraph explains the project history in considerable detail. ".repeat(100)} The registration fee is $10.50 per month. ${action}`;
  const passages = selectPassages(source, 250);
  expect(passages.join(" ")).toContain("$10.50 per month.");
  expect(passages.join(" ")).toContain(action);
  expect(passages.join("\n").length).toBeLessThanOrEqual(250);
  expect(selectPassages("Local development.")).toEqual(["Local development."]);
});
it("fetches feed story bodies without a model and records source passages and hashes", async () => {
  const item = story(), get = transport();
  await new EvidenceReader(db, get, log, false).enrich([item]);
  expect(evidenceFor(item)).toMatchObject({ text_quality: "substantial", extraction: "not_requested", sources: [{ status: "fetched", url: item.first.source_url, final_url: item.first.source_url }] });
  expect(evidenceFor(item)!.sources[0].content_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(evidenceText(evidenceFor(item))).toContain(action);
  expect(rankingDescription(item)).toContain(action);
  expect(rankingDescription(item)?.slice(0, 280)).toContain(action);
});
it("reuses rights-checked fresh text but refetches stale or unverified cache entries", async () => {
  const item = story(), get = transport();
  await saveText(db, item.first.source_url, "Unverified cached text that must not be sent to a writer. ".repeat(5));
  await new EvidenceReader(db, get, log, false).enrich([item]);
  expect(evidenceFor(item)!.sources[0].status).toBe("fetched");
  const again = transport();
  await new EvidenceReader(db, again, log, false).enrich([item]);
  expect(evidenceFor(item)!.sources[0].status).toBe("cached");
  expect(again).not.toHaveBeenCalled();
  await itemTexts(db).updateOne({ _id: item.first.source_url }, { $set: { fetched_at: new Date(Date.now() - 2 * 86400_000) } });
  await new EvidenceReader(db, again, log, false).enrich([item]);
  expect(evidenceFor(item)!.sources[0].status).toBe("fetched");
});
it.each(["noai", "nosnippet"])("does not use page text with %s restrictions", async (restriction) => {
  const item = story();
  await new EvidenceReader(db, transport(html, { "content-type": "text/html", "x-robots-tag": restriction }), log, false).enrich([item]);
  expect(evidenceFor(item)!.sources[0]).toMatchObject({ status: "blocked", passages: [] });
  expect(await itemTexts(db).countDocuments()).toBe(0);
});
it("does not fetch link-only sources, even when text was previously cached", async () => {
  const item = story(), get = transport(); item.facts.link_only = true;
  await saveText(db, item.first.source_url, opening.repeat(5), { canonical_url: item.first.source_url, reuse_allowed: true });
  await new EvidenceReader(db, get, log, false).enrich([item]);
  expect(get).not.toHaveBeenCalled();
  expect(evidenceText(evidenceFor(item))).toBe("");
  expect(evidenceFor(item)!.sources[0].status).toBe("blocked");
});
it("surfaces request failures and unsupported responses instead of claiming evidence was found", async () => {
  const failed = story();
  await new EvidenceReader(db, async () => { throw new Error("offline fixture"); }, log, false).enrich([failed]);
  expect(evidenceFor(failed)!.sources[0]).toMatchObject({ status: "failed", reason: "offline fixture" });
  expect(log.warn).toHaveBeenCalled();
  const json = story();
  await new EvidenceReader(db, transport('{"data":"not an article"}', { "content-type": "application/json" }), log, false).enrich([json]);
  expect(evidenceFor(json)!.sources[0].status).toBe("unsupported");
});
it("enforces host and section admission caps, but cached sources do not spend page budget", async () => {
  const base = new URL(url()).origin;
  const sameHost = Array.from({ length: 7 }, (_, index) => story(`${base}/news/${index}`));
  const get = transport();
  await new EvidenceReader(db, get, log, false).enrich(sameHost);
  expect(sameHost.filter((item) => evidenceFor(item)!.sources[0].status === "fetched")).toHaveLength(EVIDENCE_LIMITS.perHost);
  expect(evidenceFor(sameHost[6])!.sources[0].status).toBe("budget");
  const many = Array.from({ length: 25 }, () => story());
  await new EvidenceReader(db, transport(), log, false).enrich(many);
  expect(many.filter((item) => evidenceFor(item)!.sources[0].status === "fetched")).toHaveLength(EVIDENCE_LIMITS.pages);
});
it("deduplicates requests and follows only one explicit same-origin supporting document", async () => {
  const source = url(), item = story(source), duplicate = story(source);
  const get = transport(html.replace("</article>", '<a href="/agenda">Agenda</a><a href="https://elsewhere.test/report">Staff report</a></article>'));
  await new EvidenceReader(db, get, log, false).enrich([item, duplicate]);
  expect(evidenceFor(item)!.sources).toHaveLength(2);
  expect(evidenceFor(item)!.sources[1].url).toBe(new URL("/agenda", source).toString());
  expect(vi.mocked(get).mock.calls.filter(([request]) => !request.url.endsWith("robots.txt"))).toHaveLength(2);
  const cachedGet = transport();
  await new EvidenceReader(db, cachedGet, log, false).enrich([item]);
  expect(evidenceFor(item)!.sources).toHaveLength(2);
  expect(cachedGet).not.toHaveBeenCalled();
  expect(supportingLinks('<a href="/staff.pdf">Staff report</a><a href="/else">Agenda</a>', source)).toEqual([new URL("/staff.pdf", source).toString()]);
  expect(supportingLinks('<nav><a href="/agenda">Agenda</a></nav><article><p>No supporting link here.</p></article>', source)).toEqual([]);
});
it("never requests a private address or a prohibited redirect target", async () => {
  const privateItem = story("https://127.0.0.1/news"), get = transport();
  await new EvidenceReader(db, get, log, false).enrich([privateItem]);
  expect(get).not.toHaveBeenCalled();
  expect(evidenceFor(privateItem)!.sources[0].reason).toContain("non-public");
  const redirected = story();
  const redirect: HttpTransport = vi.fn(async (request) => request.url.endsWith("/robots.txt")
    ? { url: request.url, status: 200, headers: {}, body: new Uint8Array() }
    : { url: request.url, status: 302, headers: { location: "https://127.0.0.1/private" }, body: new Uint8Array() });
  await new EvidenceReader(db, redirect, log, false).enrich([redirected]);
  expect(vi.mocked(redirect).mock.calls.every(([request]) => !request.url.includes("127.0.0.1"))).toBe(true);
});
it("enforces the actual host budget across redirects from different sources", async () => {
  const target = new URL(url()).origin;
  const get: HttpTransport = vi.fn(async (request) => request.url.endsWith("/robots.txt")
    ? { url: request.url, status: 200, headers: {}, body: new Uint8Array() }
    : new URL(request.url).origin === target
      ? { url: request.url, status: 200, headers: { "content-type": "text/html" }, body: new TextEncoder().encode(html) }
      : { url: request.url, status: 302, headers: { location: `${target}/article` }, body: new Uint8Array() });
  const items = Array.from({ length: 5 }, () => story());
  await new EvidenceReader(db, get, log, false).enrich(items);
  expect(vi.mocked(get).mock.calls.filter(([request]) => new URL(request.url).origin === target && !request.url.endsWith("/robots.txt"))).toHaveLength(4);
  expect(evidenceFor(items[4])!.sources[0].status).toBe("budget");
});
it("accepts only extracted facts anchored to exact supporting passages", () => {
  const data = groundDetails({
    what: [opening, "The project will boost property values."], numbers: ["$10.50"], when: "November 8", next_step: action,
    why: "Residents will be healthier.", quote: { text: "This was never said.", by: "Alex Doe" },
    support: [
      { field: "what", value: opening, quote: opening },
      { field: "what", value: "The project will boost property values.", quote: opening },
      { field: "when", value: "November 8", quote: action },
      { field: "next_step", value: action, quote: action },
      { field: "numbers", value: "$10.50", quote: "The registration fee is $10.50 per month." },
    ],
  }, `${opening} ${action} The registration fee is $10.50 per month.`);
  expect(data.what).toEqual([opening]); expect(data.when).toBe("November 8"); expect(data.numbers).toEqual(["$10.50"]);
  expect(data.next_step).toBe(action); expect(data.why).toBeNull(); expect(data.quote).toBeNull();
  const quote = { text: "The park opens next week.", by: "Alex Doe" };
  expect(groundDetails({ quote }, 'Alex Doe said, "The park opens next week."').quote).toEqual(quote);
  expect(groundDetails({ quote }, 'Alex Doe is an author. The park opens next week.').quote).toBeNull();
});
it("rejects malformed, unsupported-schema and truncated extraction rather than caching empty success", async () => {
  await expect(extractDetails(new FakeModel(() => "not JSON"), { title: "Test" }, opening, "Fixture")).rejects.toThrow();
  await expect(extractDetails(new FakeModel(() => ({})), { title: "Test" }, opening, "Fixture")).rejects.toThrow("supporting passages");
  const model = new FakeModel(() => ({}));
  vi.spyOn(model, "generateStructured").mockResolvedValue({ response: "{}", done: false, done_reason: "length" });
  await expect(extractDetails(model, { title: "Test" }, opening, "Fixture")).rejects.toThrow("did not finish");
});
it("preserves short deadline/list paragraphs and reads structured article bodies without rendered content", () => {
  expect(mainText(`<article><p>${opening}</p><p>${action}</p><ul><li>Cost: $10.50.</li></ul></article>`)).toContain(action);
  expect(mainText(`<article><p>${opening}</p><p>${action}</p><ul><li>Cost: $10.50.</li></ul></article>`)).toContain("Cost: $10.50.");
  const text = `${opening} ${action}`;
  expect(mainText(`<script type="application/ld+json">${JSON.stringify({ "@type": "NewsArticle", articleBody: text })}</script>`)).toBe(text);
});
it("records time-budget exhaustion without starting another request", async () => {
  const get = transport(), reader = new EvidenceReader(db, get, log, false), item = story();
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + EVIDENCE_LIMITS.milliseconds + 1);
  try { await reader.enrich([item]); } finally { clock.mockRestore(); }
  expect(get).not.toHaveBeenCalled();
  expect(evidenceFor(item)!.sources[0].status).toBe("budget");
});
function pdf(pages = 1) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_, index) => `${4 + 2 * index} 0 R`).join(" ")}] >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (let index = 0; index < pages; index++) {
    const stream = `BT /F1 12 Tf 50 750 Td (${opening}) Tj 0 -18 Td (${action}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * index} 0 R >>`, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  let document = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(document.length); document += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = document.length;
  document += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(document);
}
it("reads bounded real text PDFs and surfaces over-page-limit documents", async () => {
  const readPdf = (pages: number): HttpTransport => async (request) => ({
    url: request.url, status: 200, headers: { "content-type": "application/pdf" },
    body: request.url.endsWith("/robots.txt") ? new TextEncoder().encode("User-agent: *\nAllow: /") : pdf(pages),
  });
  const item = story(`${url()}.pdf`);
  await new EvidenceReader(db, readPdf(1), log, false).enrich([item]);
  expect(evidenceText(evidenceFor(item))).toContain(action);
  const tooLarge = story(`${url()}.pdf`);
  await new EvidenceReader(db, readPdf(13), log, false).enrich([tooLarge]);
  expect(evidenceFor(tooLarge)!.sources[0]).toMatchObject({ status: "failed", reason: "Meeting PDF exceeds page limit" });
});

async function seed(transport: HttpTransport, lightModel?: FakeModel) {
  const source = url();
  const events: SourceEvent[] = [{ source_id: "web:garden", facts: {
    source_event_id: "garden", title: "Garden plans", description: "Garden plans will be considered.", event_date: "2026-10-29",
    schedule_text: "October 29", venue: "Cedar Park", room: null, source_url: source, kind: "local_news", tier: "local",
  } }];
  const id = collapse(events)[0].id;
  const draft: DraftDoc = {
    id: "run", run_id: "run", location_id: "fixture-wa", location_name: "Fixture, WA", today: "2026-10-29", window_start: "2026-10-29",
    window_end: "2026-11-04", status: "ranking", created_at: 1, model: "fake", provider: "fake", validation_policy: "test",
    events, source_results: [], candidates: [], pool_sections: [{ id: "news", label: "News", stories: [id], considered: 1 }],
    section_rankings: {}, tokens: {}, funnel: {}, ranking: {}, event_count: 1, story_count: 1, started_at_ms: Date.now(),
  };
  await db.collection<DraftDoc>(COLLECTIONS.editions).insertOne(draft);
  await collectedItems(db).insertOne({ _id: "item", run_id: "run", location_id: "fixture-wa", source_id: "web:garden", source_name: "Garden", title: "Garden plans", url: source, event_date: "2026-10-29", status: "pooled", reason: null, step: "ranking", facts: events[0].facts, story_id: id, section: "news", created_at: Date.now() / 1000 });
  const model = new FakeModel(({ prompt }) => {
    if (prompt.startsWith("Independently fact-check")) {
      const data = JSON.parse(prompt.split("Review data:\n")[1]);
      return { claims: data.claims.map((claim: { id: string; text: string }) => {
        const source = data.sources.find((source: { text: string }) => source.text.includes(claim.text)) ?? data.sources.find((source: { text: string }) => source.text.includes(opening))!;
        return { id: claim.id, verdict: "supported", reason: "The fixture record explicitly states these facts.", evidence: [{ source_id: source.id, quote: source.text.includes(claim.text) ? claim.text : opening }] };
      }) };
    }
    if (prompt.includes("Candidates:\n")) {
      const candidates = JSON.parse(prompt.split("Candidates:\n")[1]) as Array<{ id: string }>;
      return prompt.startsWith("You are the editor") ? { order: candidates.map((item) => item.id) } : { ratings: candidates.map((item) => ({ id: item.id, category: "other", civic: 2, appeal: 1, special: 1 })) };
    }
    return { headline: "Garden plans at Cedar Park", summary: `${opening} ${action}` };
  });
  const deps: AuthoringDeps = { db, settings: loadSettings({ NEWSBEE_MODE: "local" }), model, lightModel, transport, log };
  return { deps, id, model };
}
it("ranks with gathered evidence, persists it, and writes from it even without a light model", async () => {
  const { deps, model } = await seed(transport());
  await rankSection(deps, "run", "news");
  expect(model.calls.find((call) => call.prompt.startsWith("Rate each"))!.prompt).toContain(action);
  const stored = await db.collection<DraftDoc>(COLLECTIONS.editions).findOne({ id: "run" });
  expect(stored?.events[0].facts.evidence).toMatchObject({ sources: [{ status: "fetched" }] });
  const outcome = await authorNextStory(deps, "run");
  expect(outcome.result?.disposition).toBe("checks_passed");
  expect(outcome.result?.draft.summary).toContain(action);
  expect(model.calls.at(-1)!.prompt).toContain(action);
  expect((await collectedItems(db).findOne({ _id: "item" }))?.evidence).toMatchObject({ extraction: "model_unavailable" });
});
it("reports unavailable editor signals while keeping ranking usable", async () => {
  const { deps } = await seed(transport());
  const rates = vi.spyOn(storyReviews, "sourceAcceptRates").mockRejectedValueOnce(new Error("fixture reviews unavailable"));
  try {
    await rankSection(deps, "run", "news");
    expect(log.warn).toHaveBeenCalledWith("source_accept_rates_failed", { run_id: "run", error: "Error: fixture reviews unavailable" });
    expect((await collectedItems(db).findOne({ _id: "item" }))?.pre_rank?.score).toBeTypeOf("number");
  } finally { rates.mockRestore(); }
});
it("fetches useful text even when the daily extraction budget is exhausted", async () => {
  const light = new FakeModel(() => { throw new Error("Must not call extraction"); });
  const { deps } = await seed(transport(), light); deps.settings.modelDailyCalls = 0;
  await rankSection(deps, "run", "news");
  const outcome = await authorNextStory(deps, "run");
  expect(outcome.result?.disposition).toBe("checks_passed");
  expect(light.calls).toHaveLength(0);
  expect((await collectedItems(db).findOne({ _id: "item" }))?.evidence?.extraction).toBe("budget_exhausted");
});
it("preserves provider backoff rather than turning extraction quota errors into editorial success", async () => {
  const light = new FakeModel(() => { throw new ModelRateLimitError("fixture quota", 10); });
  const { deps } = await seed(transport(), light);
  await rankSection(deps, "run", "news");
  await expect(authorNextStory(deps, "run")).rejects.toThrow(ModelRateLimitError);
  expect(await db.collection(COLLECTIONS.editionEntries).countDocuments()).toBe(0);
});
it("withholds newly discovered sensitive raw text from the writer and records its floor", async () => {
  const secret = "Juvenile suspect Jane Sample was arrested after a police investigation.";
  const { deps, model } = await seed(transport(`<article><p>${secret}</p><p>${opening}</p></article>`));
  await rankSection(deps, "run", "news");
  const before = model.calls.length;
  const outcome = await authorNextStory(deps, "run");
  expect(outcome.result?.floor).toMatchObject({ withholdNames: true, blockAddresses: true });
  for (const call of model.calls.slice(before)) expect(call.prompt).not.toContain("Jane Sample");
});
it("records extraction failures explicitly while allowing grounded raw-text writing", async () => {
  const { deps } = await seed(transport(), new FakeModel(() => "broken JSON"));
  await rankSection(deps, "run", "news");
  expect((await authorNextStory(deps, "run")).result?.disposition).toBe("checks_passed");
  const packet = (await collectedItems(db).findOne({ _id: "item" }))?.evidence;
  expect(packet?.extraction).toBe("failed");
  expect(packet?.extraction_error).toBeTruthy();
  expect(await db.collection("story_details").countDocuments()).toBe(0);
});
it("keeps per-fact provenance and re-extracts when the evidence input changes", async () => {
  const light = new FakeModel(() => ({
    people: [], organisations: [], places: [], when: null, numbers: [], what: [opening], why: null, quote: null, next_step: action, section: "news",
    support: [{ field: "what", value: opening, quote: opening }, { field: "next_step", value: action, quote: action }],
  }));
  const { deps } = await seed(transport(), light);
  await rankSection(deps, "run", "news");
  await authorNextStory(deps, "run");
  expect(light.calls).toHaveLength(1);
  const packet = (await collectedItems(db).findOne({ _id: "item" }))?.evidence;
  expect(packet?.facts?.find((fact) => fact.field === "next_step")).toMatchObject({ value: action, quote: action, source_urls: [expect.stringContaining("https://evidence-")] });
  await db.collection(COLLECTIONS.editionEntries).deleteMany({});
  await db.collection(COLLECTIONS.editions).updateOne({ id: "run" }, { $set: { status: "drafting" } });
  await authorNextStory(deps, "run");
  expect(light.calls).toHaveLength(1);
  await db.collection(COLLECTIONS.editionEntries).deleteMany({});
  await db.collection(COLLECTIONS.editions).updateOne({ id: "run" }, { $set: { status: "drafting", "events.0.facts.description": "The garden plans now include an updated timetable." } });
  await authorNextStory(deps, "run");
  expect(light.calls).toHaveLength(2);
});


it("refetches relaxed-run cache text before strict ranking or writing", async () => {
  const item = story(), get = transport();
  await withRunContext({ db, runId: "relaxed", locationId: "fixture-wa", options: { ...defaultRunOptions({}), access: "relaxed" } }, () =>
    saveText(db, item.first.source_url, "Restricted cached article text. ".repeat(10), { canonical_url: item.first.source_url, reuse_allowed: true }));
  await withRunContext({ db, runId: "strict", locationId: "fixture-wa", options: defaultRunOptions({}) }, () =>
    new EvidenceReader(db, get, log, false).enrich([item]));
  expect(get).toHaveBeenCalled();
  expect(evidenceFor(item)!.sources[0].status).toBe("fetched");
  expect(rankingDescription(item)).not.toContain("Restricted cached article");
  expect(evidenceText(evidenceFor(item))).toContain(action);
});

it("discards unsupported numbers after source collection and uses only a separately verified exact-source brief", async () => {
  const { deps, model } = await seed(transport());
  await rankSection(deps, "run", "news");
  vi.spyOn(model, "generateStructured").mockResolvedValue({ response: JSON.stringify({ headline: "Garden plans at Cedar Park", summary: "The council approved 999 playgrounds." }), done: true });
  const result = await authorNextStory(deps, "run");
  expect(result.result).toMatchObject({ disposition: "checks_passed", source_brief: true, attempts: 2, verification: { method: "exact_source_brief" }, rejected_final: { errors: expect.arrayContaining(["summary:unsupported_number:999"]) } });
  expect(result.result?.draft.summary).not.toContain("999");
  const cached = await db.collection(COLLECTIONS.storyCache).findOne({});
  expect(cached?.result).toMatchObject({ source_brief: true, verification: { method: "exact_source_brief" } });
  expect(cached?.result.draft.summary).not.toContain("999");
});

it("does not approve invented facts when quality selection is relaxed", async () => {
  const { deps, model } = await seed(transport());
  await rankSection(deps, "run", "news");
  vi.spyOn(model, "generateStructured").mockResolvedValue({ response: JSON.stringify({ headline: "Garden plans at Cedar Park", summary: "The council approved 999 playgrounds." }), done: true });
  const result = await withRunContext({ db, runId: "run", locationId: "fixture-wa", options: { ...defaultRunOptions({}), guardrails_off: ["quality"] } }, () => authorNextStory(deps, "run"));
  expect(result.result).toMatchObject({ disposition: "checks_passed", source_brief: true, rejected_final: { errors: expect.arrayContaining(["summary:unsupported_number:999"]) } });
  expect(result.result?.draft.summary).not.toContain("999");
});

it("keeps the exact writing evidence for edition-front checks, not just the original feed snippet", async () => {
  const { deps } = await seed(transport());
  await rankSection(deps, "run", "news");
  const result = await authorNextStory(deps, "run");
  expect(result.result?.writing_source.description).toContain(action);
  expect(result.result?.story.description).not.toContain(action);
});

it("holds conflicting merged source times before making a writer call", async () => {
  const { deps, model } = await seed(transport());
  await rankSection(deps, "run", "news");
  await db.collection(COLLECTIONS.editions).updateOne({ id: "run" }, { $set: { "events.0.facts.merge_conflicts": ["conflicting_source_times"] } });
  const calls = model.calls.length;
  const outcome = await authorNextStory(deps, "run");
  expect(outcome.result).toMatchObject({ disposition: "held", validation_errors: ["conflicting_source_times"] });
  expect(model.calls).toHaveLength(calls);
});
it("carries every merged report and fetched supporting source into attribution", async () => {
  const { deps } = await seed(transport());
  await rankSection(deps, "run", "news");
  const draft = await db.collection<DraftDoc>(COLLECTIONS.editions).findOne({ id: "run" });
  const original = draft!.events[0];
  const copy = { source_id: "web:secondary", facts: { ...original.facts, source_event_id: "secondary", source_name: "Community News", source_url: "https://community.example/report" } };
  await db.collection(COLLECTIONS.editions).updateOne({ id: "run" }, { $set: { events: [original, copy] } });
  const outcome = await authorNextStory(deps, "run");
  expect(outcome.result?.sources).toEqual(expect.arrayContaining([
    { name: "Community News", url: "https://community.example/report" },
    expect.objectContaining({ url: original.facts.source_url }),
  ]));
});
it("does not promote unsupported factual claims in exploration mode", async () => {
  const { deps } = await seed(transport());
  await rankSection(deps, "run", "news");
  deps.model = new FakeModel(() => ({ headline: "Garden plans at Cedar Park", summary: "The garden will cost 987654 dollars." }));
  const outcome = await withRunContext({ db, runId: "run", locationId: "fixture-wa", options: { ...defaultRunOptions({}), guardrails: "exploration" } }, () => authorNextStory(deps, "run"));
  expect(outcome.result).toMatchObject({ disposition: "checks_passed", source_brief: true, rejected_final: { errors: expect.arrayContaining(["summary:unsupported_number:987654"]) } });
  expect(outcome.result?.draft.summary).not.toContain("987654");
});
