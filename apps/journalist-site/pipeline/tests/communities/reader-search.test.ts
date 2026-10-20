import { beforeEach, expect, it, vi } from "vitest";
import { GET } from "../../../../reader-site/src/pages/api/locations/search";

const directory = vi.hoisted(() => ({
  discoverReaderCommunities: vi.fn(),
  searchTownDirectory: vi.fn(),
}));
vi.mock("../../../../reader-site/src/lib/reader-data", () => directory);

beforeEach(() => {
  vi.resetAllMocks();
});

function search(query: string, discover?: string) {
  const url = new URL("http://localhost/api/locations/search");
  url.searchParams.set("q", query);
  if (discover) url.searchParams.set("discover", discover);
  return GET({ url } as Parameters<typeof GET>[0]);
}

it("keeps autocomplete local and only queries the provider on an explicit request", async () => {
  const places = [{ id: "osm-n150973716-wa", name: "Wallingford, Seattle, WA" }];
  directory.searchTownDirectory.mockResolvedValue(places);
  directory.discoverReaderCommunities.mockResolvedValue(places);
  expect(await (await search("Wallingford")).json()).toEqual({ query: "Wallingford", results: places });
  await search("Wallingford", "false");
  expect(directory.discoverReaderCommunities).not.toHaveBeenCalled();
  expect(directory.searchTownDirectory).toHaveBeenCalledTimes(2);
  const response = await search("Wallingford", "true");
  expect(await response.json()).toEqual({ query: "Wallingford", results: places });
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(directory.discoverReaderCommunities).toHaveBeenCalledWith("Wallingford");
  expect(directory.searchTownDirectory).toHaveBeenCalledTimes(2);
});

it("rejects oversized discovery queries before contacting the provider", async () => {
  expect((await search("a".repeat(81), "true")).status).toBe(422);
  expect(directory.discoverReaderCommunities).not.toHaveBeenCalled();
});

it("surfaces discovery failures rather than returning empty success results", async () => {
  directory.discoverReaderCommunities.mockRejectedValue(new Error("Provider unavailable"));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const response = await search("Wallingford", "true");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ detail: "Location search unavailable" });
    expect(log).toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});
