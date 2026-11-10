import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { afterEach, expect, it, vi } from "vitest";
import { ILLUSTRATIONS, illustrationAsset, illustrationScore, planIllustrations } from "../../../../../shared/editorial-illustrations";
import { defaultRunOptions, resolveRunOptions } from "../../core/run-options";
import { readerMediaMode } from "../../../../reader-site/src/lib/reader-media-mode";
import { NEIGHBORHOOD_ART, neighborhoodArt, neighborhoodArtAsset } from "../../../../../shared/neighborhood-illustrations";

afterEach(() => vi.unstubAllEnvs());
it("defaults new runs and old reader editions to curated illustrations without enabling services", () => {
  expect(defaultRunOptions({})).toMatchObject({ image_mode: "illustrated", paid: {} });
  expect(resolveRunOptions({ image_mode: "illustrated", paid: {} }, {}).image_mode).toBe("illustrated");
  vi.stubEnv("NEWSBEE_READER_MEDIA_MODE", "");
  expect(readerMediaMode()).toBe("illustrated");
  expect(readerMediaMode("photos")).toBe("photos");
  vi.stubEnv("NEWSBEE_READER_MEDIA_MODE", "none"); expect(readerMediaMode("illustrated")).toBe("none");
});
it("matches subjects rather than publisher names or unsupported story types", () => {
  expect(illustrationScore({ headline: "Mime workshop at Georgetown Studios", kind: "event" }, "performance")).toBeGreaterThan(0);
  expect(illustrationScore({ headline: "Bus lanes open", kind: "local_news" }, "transit")).toBeGreaterThan(0);
  expect(illustrationScore({ headline: "Pergola permit at NW 90th Street", kind: "building_permit" }, "permits")).toBeGreaterThan(0);
  expect(illustrationScore({ headline: "Basketball tournament", kind: "game_result" }, "sports")).toBe(0);
  expect(illustrationScore({ headline: "Light rail service changes", kind: "local_news" }, "transit")).toBe(0);
  expect(illustrationScore({ headline: "Downtown market", kind: "event" }, "books")).toBe(0);
  expect(illustrationScore({ headline: "Duo Comedy Showcase: improv open mic", blurb: "Music and art fill the neighborhood.", kind: "event" }, "music")).toBe(0);
  expect(illustrationScore({ headline: "The art of mime", kind: "event" }, "arts")).toBe(0);
  expect(illustrationScore({ headline: "Cancelled: council briefing", kind: "meeting_preview" }, "civic")).toBe(0);
  expect(illustrationScore({ headline: "Honoring Seattle volunteers", blurb: "The reception includes music.", kind: "event" }, "music")).toBe(0);
  expect(illustrationScore({ headline: "Parks for fall colors", blurb: "Visit the garden.", kind: "local_news" }, "community")).toBe(0);
});

it("illustrates a verified residential permit without assigning housing artwork from incidental neighborhood words", () => {
  expect(illustrationScore({ headline: "Building at 27TH AVE NE gets city permit", kind: "development", blurb: "The City of Seattle recorded a single family/duplex permit for replacement windows and doors." }, "civic-housing")).toBeGreaterThan(0);
  expect(illustrationScore({ headline: "Building permit for a cafe", kind: "development", blurb: "The commercial cafe is near single family homes." }, "civic-housing")).toBe(0);
  expect(illustrationScore({ headline: "Neighborhood update", kind: "local_news", blurb: "The City recorded a single family permit." }, "civic-housing")).toBe(0);
});
it.each(["public_record", "safety_incident", "court_case", "obituary", "housing_market", "home_sale", "reader_story"])("keeps %s free of decorative illustrations", kind => {
  expect(planIllustrations([{ headline: "Library board and community garden", kind }]).size).toBe(0);
});
it("withholds lighthearted art for sensitive stories even when the topic matches", () => {
  for (const headline of ["Arrest at a library", "Football player injured", "Death at a garden center", "Census update near the arts center"])
    expect(planIllustrations([{ headline, kind: "news_report" }]).size).toBe(0);
});
it.each(["Memorial service at the library", "A vigil for victims", "Funeral reception", "Community meeting after a stabbing"])("withholds the neutral event fallback for %s", headline => {
  expect(planIllustrations([{ headline, kind: "event" }]).size).toBe(0);
});
it("allocates a graphic to the strongest headline match only once and remains stable", () => {
  const stories = [{ headline: "Local update", blurb: "The library hosted a workshop.", rank: 0 },
    { headline: "Library opens a reading corner", rank: 2 }, { headline: "Another library event", rank: 3 },
    { headline: "Bus service expands", rank: 4 }];
  const plan = planIllustrations(stories);
  expect(plan.get(0)).toBeUndefined(); expect(plan.get(1)?.id).toBe("books"); expect(plan.get(2)).toBeUndefined();
  expect(plan.get(3)?.id).toBe("transit"); expect([...plan.values()].map(value => value.id)).toEqual([...planIllustrations(stories).values()].map(value => value.id));
});
it("provides only controlled local URLs", () => {
  expect(illustrationAsset("books", "/reader/")).toBe("/reader/illustrations/books-v1.webp");
  expect(illustrationAsset("books", "/reader", true)).toBe("/reader/illustrations/books-v1-960.webp");
  expect(() => illustrationAsset("../../private" as any)).toThrow("Unknown");
  expect(illustrationAsset("puppets", "/reader")).toBe("/reader/illustrations/puppets-v1.webp");
});
it("individualizes the two communities without applying their artwork to other places", () => {
  const books = [{ headline: "Library reading corner opens", kind: "local_news" }];
  const football = [{ headline: "Flag football tournament", kind: "game_result" }];
  expect(planIllustrations(books, "osm-r13915552-wa").get(0)?.asset_id).toBe("wedgwood-books");
  expect(planIllustrations(football, "moses-lake-wa").get(0)?.asset_id).toBe("moses-lake-football");
  expect(planIllustrations(books, "other-wa").get(0)?.asset_id).toBeUndefined();
  expect(planIllustrations(football, "osm-r13915552-wa").get(0)?.asset_id).toBeUndefined();
  expect(neighborhoodArt("osm-r13915552-wa")?.name).toBe("Wedgwood");
  expect(neighborhoodArt("moses-lake-wa")?.asset).toBe("moses-lake-welcome");
  expect(neighborhoodArt("not-moses-lake-wa")).toBeNull();
});
it("ships both distinct panoramic portraits and their neighborhood story variants", async () => {
  for (const profile of NEIGHBORHOOD_ART) {
    const file = fileURLToPath(new URL(`../../../../reader-site/public${neighborhoodArtAsset(profile)}`, import.meta.url));
    const { info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
    expect(info).toMatchObject({ width: 2172, height: 724 });
  }
  for (const id of ["wedgwood-books", "moses-lake-football"] as const) {
    const file = fileURLToPath(new URL(`../../../../reader-site/public${illustrationAsset(id)}`, import.meta.url));
    expect(await sharp(file).metadata()).toMatchObject({ width: 1536, height: 1024 });
  }
});
it("ships distinct, fully decodable originals and responsive WebP assets for every catalog entry", async () => {
  const hashes = new Set<string>();
  for (const art of ILLUSTRATIONS) {
    const file = fileURLToPath(new URL(`../../../../reader-site/public/illustrations/${art.id}-v1.webp`, import.meta.url));
    const bytes = await readFile(file);
    const { info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
    expect(info).toMatchObject({ width: 1536, height: 1024 });
    expect(bytes.byteLength).toBeLessThan(600000);
    hashes.add(createHash("sha256").update(bytes).digest("hex"));
    const smaller = await sharp(file.replace("-v1.webp", "-v1-960.webp")).metadata();
    expect(smaller).toMatchObject({ width: 960, height: 640 });
  }
  expect(hashes.size).toBe(ILLUSTRATIONS.length);
});

it("covers every event in an edition with repeated theater subjects without reusing a drawing", () => {
  const headlines = [
    "Mime and Physical Improv with Jay Hitt makes worlds from thin air",
    "45th Seattle International Comedy Competition makes every laugh count",
    "Evening Reception Honors Angela Brady, Acting SDOT Director",
    "Seattle Theatresports 2026 puts your ideas onstage",
    "Loose Cannons 2026 turns one audience suggestion into Seattle improv",
    "Seattle Theatresports 2026 puts audience ideas in the spotlight",
    "No Strings Attached brings improvised puppets to Pike Place",
    "Seattle Theatresports 2026 puts the crowd in the comedy battle",
    "Your Suggestions Take the Stage at Seattle Theatresports 2026",
    "Duo Comedy Showcase 2026: Seattle's two-person improv open mic",
    "Duo Comedy Showcase 2026 puts two-person improv centre stage",
  ];
  const plan = planIllustrations(headlines.map(headline => ({ headline, kind: "event" })));
  expect(plan.size).toBe(headlines.length);
  expect(new Set([...plan.values()].map(art => art.asset_id ?? art.id)).size).toBe(headlines.length);
  expect(plan.get(0)?.id).toBe("performance");
  expect(plan.get(6)?.id).toBe("puppets");
});

it("uses neutral event artwork for an unmatched event without inventing a subject for news", () => {
  expect(planIllustrations([{ headline: "Neighbors get together", kind: "event" }]).get(0)?.id).toBe("event-calendar");
  expect(planIllustrations([{ headline: "Local update", kind: "news_report" }]).size).toBe(0);
  expect(planIllustrations([{ headline: "Cancelled: neighborhood gathering", kind: "event" }]).size).toBe(0);
});

it("keeps the only park drawing available while covering a volunteer story with suitable alternative art", () => {
  const plan = planIllustrations([
    { headline: "Volunteers clean the park", kind: "local_news", rank: 1 },
    { headline: "The best parks for fall colors", kind: "local_news", rank: 2 },
  ]);
  expect(plan.get(0)?.id).toBe("volunteers");
  expect(plan.get(1)?.id).toBe("autumn-park");
});

it("keeps publication contracts and generation provenance in step with the shipped catalog", async () => {
  const schema = JSON.parse(await readFile(fileURLToPath(new URL("../../../../../shared/contracts/edition.schema.json", import.meta.url)), "utf8"));
  const provenance = JSON.parse(await readFile(fileURLToPath(new URL("../../../../../Docs/illustration-art-direction.json", import.meta.url)), "utf8"));
  expect(schema.$defs.EditionItem.properties.illustration_id.enum).toEqual(ILLUSTRATIONS.map(art => art.id));
  for (const art of ILLUSTRATIONS) expect(provenance.assets.find((asset: { id: string }) => asset.id === art.id)?.prompt).toBeTruthy();
});
