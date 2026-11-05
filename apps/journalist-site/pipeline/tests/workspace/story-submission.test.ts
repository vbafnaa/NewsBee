import { beforeEach, describe, expect, it, vi } from "vitest";
import { STORY_IMAGE_MAX_BYTES } from "../../../../../shared/reader-stories";
import { storySubmission } from "../../../../reader-site/src/lib/story-submission";
import { POST } from "../../../../reader-site/src/pages/api/locations/[location_id]/stories";

const storage = vi.hoisted(() => ({ directoryTown: vi.fn(), saveReaderStory: vi.fn() }));
vi.mock("../../../../reader-site/src/lib/reader-data", () => storage);
const origin = "https://newsbee.test";
const url = `${origin}/reader/api/locations/fixture-wa/stories`;
const input = {
  headline: "Neighbours grow a community garden", story: "Neighbours opened a community garden beside the town hall. Volunteers planted vegetables and flowers for local families.",
  topic: "people", submitter_name: "Pat Neighbour", submitter_email: "pat@example.test", credit: "anonymous", consent: true,
};
// A two-pixel-square PNG; the server must decode it, not trust its filename or MIME.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWMwmmZkNM2IAUIBABtmA+ldraWcAAAAAElFTkSuQmCC", "base64");
function photoForm(bytes = png, mime = "image/png") {
  const form = new FormData();
  for (const [key, value] of Object.entries(input)) form.set(key, key === "consent" ? "on" : String(value));
  form.set("image", new File([Uint8Array.from(bytes)], "photo.png", { type: mime }));
  form.set("image_caption", "Neighbours tending the garden");
  form.set("image_credit", "Pat, a neighbour");
  form.set("image_consent", "on");
  return form;
}
const request = (body: FormData | string, headers: Record<string, string> = {}) => new Request(url, { method: "POST", headers: { origin, ...headers }, body });
const post = (req: Request) => POST({ params: { location_id: "fixture-wa" }, request: req, url: new URL(url) } as Parameters<typeof POST>[0]);
beforeEach(() => {
  vi.clearAllMocks();
  storage.directoryTown.mockResolvedValue({ id: "fixture-wa", name: "Fixture, WA" });
  storage.saveReaderStory.mockResolvedValue("pending-id");
});

describe("neighbour photo submissions", () => {
  it("keeps JSON submissions without photos backwards compatible", async () => {
    expect((await post(request(JSON.stringify(input), { "Content-Type": "application/json" }))).status).toBe(200);
    expect(storage.saveReaderStory).toHaveBeenCalledWith(
      { id: "fixture-wa", name: "Fixture, WA" }, expect.objectContaining({ credit: "anonymous" }), null,
    );
  });
  it("saves a decoded, metadata-free JPEG and public caption/credit for editorial review", async () => {
    const response = await post(request(photoForm()));
    expect(await response.json()).toEqual({ status: "pending_review" });
    const image = storage.saveReaderStory.mock.calls[0][2];
    expect(image).toMatchObject({ mime_type: "image/jpeg", caption: "Neighbours tending the garden", credit: "Pat, a neighbour" });
    expect(Number.isNaN(Date.parse(image.permission_confirmed_at))).toBe(false);
    const bytes = Buffer.from(image.data, "base64");
    expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    expect(bytes.equals(png)).toBe(false);
    expect(bytes.includes(Buffer.from("Exif"))).toBe(false);
  });
  it.each(["image_consent", "image_credit", "image_caption"])("requires %s when a photo is attached", async (field) => {
    const form = photoForm(); form.delete(field);
    expect((await post(request(form))).status).toBe(422);
    expect(storage.saveReaderStory).not.toHaveBeenCalled();
  });
  it.each([
    ["fake JPEG", Buffer.from("not an image"), "image/jpeg"],
    ["SVG", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>'), "image/png"],
  ] as const)("rejects %s even with an allowed upload MIME", async (_label, bytes, mime) => {
    expect((await post(request(photoForm(bytes, mime)))).status).toBe(422);
    expect(storage.saveReaderStory).not.toHaveBeenCalled();
  });
  it("rejects oversized file bytes", async () => {
    expect((await post(request(photoForm(Buffer.alloc(STORY_IMAGE_MAX_BYTES + 1))))).status).toBe(413);
    expect(storage.saveReaderStory).not.toHaveBeenCalled();
  });
  it("bounds chunked bodies, not just Content-Length", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(STORY_IMAGE_MAX_BYTES)); controller.enqueue(new Uint8Array(70_000)); controller.close(); },
    });
    const req = new Request(url, { method: "POST", body, duplex: "half" } as RequestInit);
    await expect(storySubmission(req)).rejects.toMatchObject({ status: 413 });
  });
  it("rejects cross-origin submissions before processing image bytes", async () => {
    expect((await post(request(photoForm(), { origin: "https://other.test" }))).status).toBe(403);
    expect(storage.saveReaderStory).not.toHaveBeenCalled();
  });
});
