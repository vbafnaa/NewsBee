import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readerData } from "../../../../reader-site/src/lib/reader-data";

const location = { id: "seattle-wa", name: "Seattle, WA" };
const edition = {
  id: "edition-seattle-wa", location_id: location.id, location_name: location.name,
  window_start: "2026-10-12", window_end: "2026-10-19", published_at: 1792435200,
  headline: "Seattle this week", intro: "Community news.", items: [],
};
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  vi.stubEnv("NEWSBEE_MODE", "cloud");
  vi.stubGlobal("newsbeeReaderData", {
    accessToken: { value: "reader-access-token", expiresAt: Date.now() + 3_600_000 },
  });
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("lists all Shared-drive pages and reads the directory and editions", async () => {
  fetchMock.mockImplementation(async (input) => {
    const url = new URL(String(input));
    expect(url.searchParams.get("supportsAllDrives")).toBe("true");
    if (url.pathname === "/drive/v3/files") {
      expect(url.searchParams.get("includeItemsFromAllDrives")).toBe("true");
      expect(url.searchParams.get("q")).toBe("'channel-folder-123' in parents and trashed = false");
      return url.searchParams.get("pageToken") === "next-page"
        ? Response.json({ files: [{ id: "edition-file-123", name: "edition.json" }] })
        : Response.json({
          files: [{ id: "directory-file-123", name: "locations.json" }], nextPageToken: "next-page",
        });
    }
    expect(url.searchParams.get("alt")).toBe("media");
    if (url.pathname.endsWith("/directory-file-123")) return Response.json({ locations: [location] });
    expect(url.pathname).toBe("/drive/v3/files/edition-file-123");
    return Response.json(edition);
  });
  await expect(readerData("channel-folder-123")).resolves.toMatchObject({
    locations: [location], editions: [edition],
  });
  expect(fetchMock).toHaveBeenCalledTimes(4);
  for (const [, init] of fetchMock.mock.calls) {
    expect(init?.headers).toEqual({ Authorization: "Bearer reader-access-token" });
  }
});

it.each(["list", "read"])("surfaces Shared-drive permission errors during %s", async (operation) => {
  if (operation === "read") {
    fetchMock.mockResolvedValueOnce(Response.json({
      files: [{ id: "directory-file-123", name: "locations.json" }],
    }));
  }
  fetchMock.mockResolvedValueOnce(new Response("Forbidden", { status: 403 }));
  await expect(readerData("channel-folder-123")).rejects.toThrow("Google Drive request failed (403)");
});
