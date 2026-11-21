import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { publicationLinks, loadPublicationContributionContext } from "../../../../reader-site/src/lib/publication-view";

const reader = vi.hoisted(() => ({ loadReaderPublication: vi.fn() }));
vi.mock("../../../../reader-site/src/lib/reader-data", () => reader);
const navigation = vi.hoisted(() => ({ redirect: vi.fn() }));
vi.mock("next/navigation", () => navigation);

const source = (path: string) =>
  readFile(new URL(`../../../../reader-site/src/${path}`, import.meta.url), "utf8");

it("keeps publication newsletter consent separate behind a stable publication target", async () => {
  const links = publicationLinks("publication-id");
  expect(links.newsletter).toContain("/subscribe?publication=publication-id");
  expect(links.locationSignup("ballard-wa")).toContain("/subscribe?location=ballard-wa");

  const [locationPage, publicationHome, subscribePage] = await Promise.all([
    source("pages/locations/[locationId].astro"),
    source("components/publication/PublicationHome.astro"),
    source("pages/subscribe.astro"),
  ]);
  expect(locationPage).toContain("Read full edition");
  expect(locationPage).toContain("Edition archive");
  expect(locationPage).not.toContain("href={links.newsletter}");
  expect(locationPage).toContain("nb-button nb-button-primary");
  expect(publicationHome).toContain("links.newsletter");
  expect(publicationHome).not.toContain("<SubscribeBox");
  expect(subscribePage).toContain("<PublicationEmailSignup");
  expect(subscribePage).toContain("separate from community editions");
  expect(subscribePage).toContain("publicationArchive(publicationId)");
});

it("makes the public root open Reader without authentication or provider access", async () => {
  const { default: Home } = await import("../../../app/page");
  Home();
  expect(navigation.redirect).toHaveBeenCalledWith("/reader");
});

it("uses the shared Reader shell, share behavior, and current sponsor tokens", async () => {
  const [shell, archive, home, article, sponsor] = await Promise.all([
    source("components/publication/PublicationShell.astro"),
    source("pages/publications/[publicationId]/archive.astro"),
    source("components/publication/PublicationHome.astro"),
    source("components/publication/PublicationArticlePage.astro"),
    source("components/edition/SponsorPlacement.astro"),
  ]);
  for (const page of [shell, archive]) {
    expect(page).toContain("SiteHeader");
    expect(page).toContain("SiteFooter");
  }
  for (const page of [archive, home, article]) expect(page).toContain("ShareLink");
  expect(home).toContain("SponsorPlacement");
  expect(sponsor).toContain("var(--color-line)");
  expect(sponsor).toContain("var(--radius-xl)");
  expect(sponsor).not.toContain("var(--color-border)");
  expect(sponsor).not.toContain("var(--radius-card)");
});

it("keeps the publication newsletter action clear of the mobile wordmark", async () => {
  const header = await source("components/edition/SiteHeader.astro");
  expect(header).toContain("@media (max-width: 32rem)");
  expect(header).toContain(".bar { grid-template-columns: minmax(0, 1fr) auto; }");
});

it("keeps newsletter delivery manual and the deployment free of cron configuration", async () => {
  const [delivery, guide, deployment] = await Promise.all([
    readFile(new URL("../../../app/newsletter/newsletter-delivery.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../../../../Docs/newsletter-delivery.md", import.meta.url), "utf8"),
    readFile(new URL("../../../../../vercel.json", import.meta.url), "utf8"),
  ]);
  for (const source of [delivery, guide]) {
    expect(source).not.toContain("The checked-in schedule runs daily");
    expect(source).not.toContain("Scheduled dispatch runs daily");
    expect(source).not.toContain("Configure CRON_SECRET");
    expect(source).not.toContain("external scheduler");
    expect(source).not.toContain("Vercel Cron");
  }
  expect(delivery).toContain("Delivery is manual");
  expect(guide).toMatch(/authenticated\s+`\/reader\/api\/newsletter\/dispatch` endpoint/);
  expect(JSON.parse(deployment)).not.toHaveProperty("crons");
});

it("preserves exact release destinations without redefining global discovery", () => {
  const links = publicationLinks("publication-id", "release-1");
  expect(links.publication).toBe(`${links.home}/publications/publication-id`);
  expect(links.page).toBe(`${links.publication}/releases/release-1`);
  expect(links.story("story-2")).toBe(`${links.page}?story=story-2`);
  expect(links.section("all")).toBe(`${links.page}?section=all`);
  expect(links.newsletter).toContain("publication=publication-id&release=release-1");
  expect(links.archive).toBe(`${links.publication}/archive`);
  expect(links.contribute("share")).toBe(`${links.home}/share?publication=publication-id&release=release-1`);
});

it("requires a deliberate eligible community and ignores external return URLs", async () => {
  const locations = [{ id: "north-wa", name: "North, WA" }, { id: "south-wa", name: "South, WA" }];
  reader.loadReaderPublication.mockResolvedValue({
    release: { release_id: "release-1", publication: { display_name: "Independent Weekly" }, locations },
    entry: { withdrawn: false },
  });
  const params = new URLSearchParams({ publication: "publication-id", release: "release-1", return: "https://evil.example" });
  const choice = (await loadPublicationContributionContext(params))!;
  expect(choice.locationId).toBeNull();
  expect(choice.locations).toEqual(locations);
  expect(choice.links.page).toContain("/publications/publication-id/releases/release-1");
  for (const location of locations) {
    const link = choice.links.contribute("suggest", location.id);
    expect(link).toContain(`publication=publication-id&release=release-1&location=${location.id}`);
    expect(link).not.toContain("evil.example");
  }
  params.set("location", "south-wa");
  expect(await loadPublicationContributionContext(params)).toMatchObject({ locationId: "south-wa", invalidLocation: false });
  params.set("location", "outside-wa");
  expect(await loadPublicationContributionContext(params)).toMatchObject({ locationId: null, invalidLocation: true });
  reader.loadReaderPublication.mockResolvedValueOnce({
    release: { release_id: "release-1", publication: { display_name: "Independent Weekly" }, locations },
    entry: { withdrawn: true },
  });
  expect(await loadPublicationContributionContext(params)).toBeNull();
});
