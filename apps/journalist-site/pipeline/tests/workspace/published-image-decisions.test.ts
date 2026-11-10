import { expect, it } from "vitest";
import { parseEdition } from "../../../../reader-site/src/lib/reader-data";
import { eventVenuePhoto } from "../../../../../shared/event-venue-photos";

const location = "osm-w1551637823-wa";
const story = {
  headline: "Gathering at Carkeek Park", blurb: "A verified community event.",
  when_where: "Carkeek Park", event_date: "2026-11-04", kind: "event",
  source_url: "https://interfaithcommunitysanctuary.org/mc-events/roots-of-joy-earth-circle-carkeek-park-lower-meadow/?mc_id=4119",
};
const edition = (image: Record<string, unknown>) => ({
  id: "edition", location_id: location, location_name: "Ballard", window_start: "2026-11-02",
  window_end: "2026-11-08", published_at: 1793660000, headline: "Local edition", intro: "Verified news.",
  items: [{ ...story, ...image }],
});

it.each([
  {}, { image: null }, { image: "https://images.example/withheld.jpg", image_credit: "" },
  { image: "data:image/jpeg;base64,unsafe", image_credit: "Pat" },
])("preserves a published text-only decision even when a matching curated venue photo exists: %j", image => {
  expect(eventVenuePhoto(location, story, new Date("2026-11-02T12:00:00Z"))).not.toBeNull();
  const parsed = parseEdition(edition(image));
  expect(parsed?.items[0]).toMatchObject(story);
  expect(parsed?.items[0]).not.toHaveProperty("image");
});

it("preserves the pipeline's credited archived photo and asset identity", () => {
  const image = { ...eventVenuePhoto(location, story, new Date("2026-11-02T12:00:00Z"))!, image_asset_id: "a".repeat(64) };
  expect(parseEdition(edition(image))?.items[0]).toMatchObject(image);
});

it("keeps an existing credited source photo without requiring an archive migration", () => {
  const image = { image: "https://images.example/story.jpg", image_credit: "Pat", image_source_url: story.source_url };
  expect(parseEdition(edition(image))?.items[0]).toMatchObject(image);
});

it("preserves documentary-photo licenses and catalog references without publishing private permission evidence", () => {
  const image = { image: "https://photos.example/event.jpg", image_credit: "Pat", image_source_url: "https://organizer.example/event",
    image_date: "2026-10-30", image_license: "Used with permission", image_catalog_id: "a".repeat(64), image_catalog_revision: "b".repeat(64) };
  expect(parseEdition(edition(image))?.items[0]).toMatchObject(image);
  expect(parseEdition(edition(image))?.items[0]).not.toHaveProperty("image_license_url");
});
