import { expect, it, vi } from "vitest";
import { communityPhoto } from "../../../../../shared/community-photos";
import { GET } from "../../../../reader-site/src/pages/api/community-images/[location_id]";

const mocks = vi.hoisted(() => ({ load: vi.fn(async (_source: string) => ({ bytes: new Uint8Array([255, 216, 255]), contentType: "image/jpeg", etag: '"photo"' })) }));
vi.mock("../../../../reader-site/src/lib/image-delivery", () => ({ deliverStoryImage: mocks.load }));
const request = (id: string, headers = {}) => ({ params: { location_id: id },
  request: new Request(`https://newsbee.example/reader/api/community-images/${id}?url=https://localhost/private`, { headers }) }) as Parameters<typeof GET>[0];

it("keeps each community's file photo with its exact location, date, photographer and license", () => {
  for (const id of ["osm-n150975261-wa", "osm-r13915552-wa", "osm-w1551637823-wa", "moses-lake-wa"]) {
    const photo = communityPhoto(id)!;
    expect(photo.image).toMatch(/^https:\/\/thumb.wikimedia.org\//);
    expect(photo.license_url).toMatch(/^https:\/\/creativecommons.org\/licenses\//);
    expect(photo.credit.length).toBeGreaterThan(2); expect(photo.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  }
  for (const id of [undefined, "ballard-wa", "constructor", "__proto__", "https://localhost"]) expect(communityPhoto(id)).toBeNull();
});

it("ignores incoming URL parameters and only delivers reviewed images, with conditional caching", async () => {
  mocks.load.mockClear();
  expect((await GET(request("unreviewed"))).status).toBe(404);
  expect(mocks.load).not.toHaveBeenCalled();
  const id = "osm-n150975261-wa";
  const response = await GET(request(id));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/jpeg");
  expect(mocks.load).toHaveBeenLastCalledWith(communityPhoto(id)!.image);
  expect((await GET(request(id, { "if-none-match": '"photo"' }))).status).toBe(304);
  mocks.load.mockRejectedValueOnce(new Error("Unavailable"));
  const failed = await GET(request(id));
  expect(failed.status).toBe(502); expect(failed.headers.get("cache-control")).toBe("no-store");
});
