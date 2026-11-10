import { expect, it } from "vitest";
import { eventVenuePhoto } from "../../../../../shared/event-venue-photos";
import { normalizeStoryImage } from "../../../../../shared/story-image";

const location = "osm-w1551637823-wa";
const source_url = "https://interfaithcommunitysanctuary.org/mc-events/roots-of-joy-earth-circle-carkeek-park-lower-meadow/?mc_id=4119";
const now = new Date("2026-11-02T12:00:00Z");

it("uses a recent photo of the reviewed event venue with date, role and license together", () => {
  const photo = eventVenuePhoto(location, { kind: "event", source_url }, now)!;
  expect(photo).toMatchObject({ image_role: "venue", image_date: "2025-11-30", image_credit: "Joe Mabel", image_license: "CC BY-SA 4.0" });
  expect(normalizeStoryImage(photo)).toEqual(photo);
});

it("never supplies context photos for records, unrelated places or unreviewed URLs", () => {
  for (const kind of ["public_record", "safety_incident", "development", "housing_market", "court_case", "local_news", undefined])
    expect(eventVenuePhoto(location, { kind, source_url }, now)).toBeNull();
  expect(eventVenuePhoto("moses-lake-wa", { kind: "event", source_url }, now)).toBeNull();
  expect(eventVenuePhoto(location, { kind: "event", source_url: source_url + "1" }, now)).toBeNull();
});

it("expires old photos and rejects future captures rather than using upload timestamps", () => {
  expect(eventVenuePhoto(location, { kind: "event", source_url }, new Date("2026-12-01"))).toBeNull();
  expect(eventVenuePhoto(location, { kind: "event", source_url }, new Date("2025-11-01"))).toBeNull();
});

it("rejects venue photos with missing license/provenance fields", () => {
  const photo = eventVenuePhoto(location, { kind: "event", source_url }, now)!;
  expect(normalizeStoryImage({ ...photo, image_license_url: "javascript:bad" })).toBeNull();
  expect(normalizeStoryImage({ ...photo, image_date: undefined })).toBeNull();
});
