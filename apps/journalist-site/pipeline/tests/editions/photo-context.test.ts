import { expect, it } from "vitest";
import { photoCredit, allowsContextPhoto } from "../../../../../shared/photo-presentation";
import { normalizeStoryImage } from "../../../../../shared/story-image";
import { contextPlace } from "../../images/places";
import { reviewAreaPhoto, type CommonsPage } from "../../images/commons";
import { collapse } from "../../editions/stories";
import type { CollectedEvent } from "../../connectors/types";
import { photoStoryMismatch } from "../../../../../shared/photo-story-match";
import { parseEdition } from "../../../../reader-site/src/lib/reader-data";

it("keeps the credit short while retaining provenance in the photo", () => {
  expect(photoCredit({ image_role: "venue", image_credit: "Joe Mabel", image_place: "Carkeek Park" })).toBe("Photo: Joe Mabel, Carkeek Park");
  expect(photoCredit({ image_role: "venue", image_credit: "Joe Mabel", image_caption: "View from Carkeek Park; location context for the upcoming gathering." })).toBe("Photo: Joe Mabel, Carkeek Park");
  expect(photoCredit({ image_role: "stock", image_credit: "Bennett Li11" })).toBe("Stock Photo");
  const media = normalizeStoryImage({ image: "https://upload.wikimedia.org/photo.jpg", image_credit: "Jane", image_role: "area", image_place: "NW 90th Street", image_caption: "Area context", image_date: "2026-10-01", image_license: "CC BY-SA 4.0", image_license_url: "https://creativecommons.org/licenses/by-sa/4.0/" });
  expect(media).toMatchObject({ image_place: "NW 90th Street", image_role: "area", image_date: "2026-10-01", image_license: "CC BY-SA 4.0" });
});

it("uses a permit's street and city, with exact street tokens and a recent capture date", () => {
  const page: CommonsPage = { title: "File:NW 90th Street Seattle 2026.jpg", imageinfo: [{ mime: "image/jpeg", thumburl: "https://upload.wikimedia.org/street.jpg", descriptionurl: "https://commons.wikimedia.org/wiki/File:NW_90th_Street_Seattle_2026.jpg", thumbwidth: 1280, thumbheight: 853, extmetadata: {
    ImageDescription: { value: "A streetscape on NW 90th Street in Seattle" }, DateTimeOriginal: { value: "2026-10-01" }, Artist: { value: "Jane" }, LicenseShortName: { value: "CC BY-SA 4.0" }, LicenseUrl: { value: "https://creativecommons.org/licenses/by-sa/4.0/" },
  } }] };
  const now = new Date("2026-11-02T12:00:00Z");
  expect(reviewAreaPhoto(page, "NW 90th St", "Seattle", now)).toMatchObject({ accepted: true, image: { image_role: "area", image_place: "NW 90th St" } });
  expect(reviewAreaPhoto(page, "NW 91st Street", "Seattle", now).accepted).toBe(false);
  expect(reviewAreaPhoto(page, "NW 90th Street", "Portland", now).accepted).toBe(false);
  page.title = "File:Seattle - Mount Zion from 20th Avenue.jpg";
  page.imageinfo![0].extmetadata!.ImageDescription.value = "20th Avenue in Seattle. S is the direction the camera faced.";
  expect(reviewAreaPhoto(page, "20th Avenue S", "Seattle", now).reason).toBe("street_or_city_mismatch");
  page.imageinfo![0].extmetadata!.ImageDescription.value = "20th Avenue South in Seattle";
  expect(reviewAreaPhoto(page, "20th Avenue S", "Seattle", now).accepted).toBe(true);
  expect(reviewAreaPhoto(page, "20th Avenue N", "Seattle", now).accepted).toBe(false);
  page.title = "File:NW 90th Street Seattle 2026.jpg";
  page.imageinfo![0].extmetadata!.ImageDescription.value = "A streetscape on NW 90th Street in Seattle";
  page.imageinfo![0].extmetadata!.DateTimeOriginal.value = "2007-10-01";
  expect(reviewAreaPhoto(page, "NW 90th Street", "Seattle", now).reason).toBe("capture_date_not_recent");
});

it("offers streetscape context to permits and preserves record exclusions", () => {
  const story = collapse([{ source_id: "city:permits", facts: { source_event_id: "permit", kind: "development", title: "Pergola permit", venue: "800 block of NW 90TH ST", source_url: "https://data.seattle.gov/permits", event_date: "2026-10-27" } as CollectedEvent }])[0];
  expect(contextPlace(story)).toMatchObject({ role: "area", name: "NW 90th Street" });
  expect(allowsContextPhoto("development", "area")).toBe(true);
  for (const kind of ["public_record", "safety_incident", "court_case", "home_sale"]) {
    expect(allowsContextPhoto(kind, "area")).toBe(false);
    story.kind = kind; expect(contextPlace(story)).toBeNull();
  }
  expect(allowsContextPhoto("development", "stock")).toBe(false);
});

it.each([
  ["Mime class", "The class meets at Arts School’s Georgetown Studios.", "Arts School, 1428 Post Alley", "Gum Wall", ["Arts School", "Gum Wall"]],
  ["Branch workshop", "The workshop takes place at Northeast Branch Library.", "Central Library", "Central Library", []],
  ["Museum workshop", "Location: River Museum, Seattle", "Hill Museum", "Hill Museum", []],
])("rejects conflicting venues for %s even when the organizer or structured venue matches", (_title, description, venue, place, aliases) => {
  const story = { kind: "event", description: description as string, venues: [venue as string] };
  expect(photoStoryMismatch(story, { image_role: "venue", image_place: place as string }, aliases as string[])).toBe("photo_venue_conflict");
});

it("accepts the actual class venue, distinct events at one organizer and an explicitly named park", () => {
  expect(photoStoryMismatch({ kind: "event", description: "A class at Arts School’s Georgetown Studios.", venues: ["Arts School"] },
    { image_role: "venue", image_place: "Georgetown Studios" })).toBeNull();
  expect(photoStoryMismatch({ kind: "event", description: "A class at Georgetown Studios and a show at Market Theater." },
    { image_role: "venue", image_place: "Market Theater" })).toBeNull();
  expect(photoStoryMismatch({ kind: "event", description: "Neighbors meet at Carkeek Park in Seattle." },
    { image_role: "venue", image_place: "Carkeek Park" })).toBeNull();
});

it("checks the actual street rather than borrowing the story's street as a photo alias", () => {
  const story = { kind: "building_permit", venues: ["800 block of NW 90TH ST"] };
  expect(photoStoryMismatch(story, { image_role: "area", image_place: "NW 90th Street" })).toBeNull();
  expect(photoStoryMismatch(story, { image_role: "area", image_place: "NW 91st Street" }, ["NW 90th Street"]))
    .toBe("photo_place_not_supported_by_story");
});

it("withholds unsupported context, while keeping actual source photos and explicit stock roles distinct", () => {
  expect(photoStoryMismatch({ kind: "event", headline: "Mime class" }, { image_role: "venue", image_place: "Gum Wall" }))
    .toBe("photo_place_not_supported_by_story");
  expect(photoStoryMismatch({ kind: "event" }, { image_role: "venue" })).toBe("photo_place_missing");
  expect(photoStoryMismatch({ kind: "local_news" }, { image_role: "stock" })).toBe("photo_role_not_allowed_for_story");
  expect(photoStoryMismatch({ kind: "event" }, { image_role: "stock" })).toBeNull();
  expect(photoStoryMismatch({ kind: "safety_incident" }, {})).toBeNull();
});

it("filters incorrect venue tagging from old reader payloads without removing or rewriting stories", () => {
  const story = { story_id: "mime", headline: "Mime workshop", blurb: "The class meets at Georgetown Studios.",
    when_where: "Where: Market Theater by the Gum Wall", kind: "event", event_date: "2026-11-12", source_url: "https://organizer.example/event" };
  const image = { image: "https://photos.example/gum-wall.jpg", image_source_url: "https://photos.example/file", image_credit: "Pat",
    image_role: "venue", image_place: "Gum Wall", image_date: "2026-10-01", image_caption: "Location context", image_license: "CC0",
    image_license_url: "https://creativecommons.org/publicdomain/zero/1.0/" };
  const edition = { id: "edition", location_id: "town", location_name: "Town", window_start: "2026-11-03", window_end: "2026-11-09",
    published_at: 1, headline: "News", intro: "", items: [{ ...story, ...image }] };
  expect(parseEdition(edition)?.items).toEqual([story]);
});
