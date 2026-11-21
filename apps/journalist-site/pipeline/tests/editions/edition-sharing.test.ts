import { describe, expect, it, vi } from "vitest";
import { editionShareUrl, shareEditionLink } from "../../../../reader-site/src/lib/edition-sharing";

const content = { title: "Wedgwood | Newsbee", url: "https://newsbee.test/reader?location=wedgwood-wa&edition=edition-older" };

describe("edition sharing", () => {
  it("pins the exact community and edition without transient reader state", () => {
    const url = new URL(editionShareUrl("https://newsbee.test/reader?story=other#events", "/reader/", "town:wa", "older edition"));
    expect(url.pathname).toBe("/reader");
    expect([...url.searchParams]).toEqual([["location", "town:wa"], ["edition", "older edition"]]);
    expect(url.hash).toBe("");
    expect(editionShareUrl("https://newsbee.test", "/", "town-wa", "edition-a")).toBe("https://newsbee.test/?location=town-wa&edition=edition-a");
  });

  it("uses native sharing when it succeeds", async () => {
    const share = vi.fn().mockResolvedValue(undefined), copy = vi.fn();
    expect(await shareEditionLink(content, { share, copy })).toBe("shared");
    expect(share).toHaveBeenCalledWith(content);
    expect(copy).not.toHaveBeenCalled();
  });

  it("treats native cancellation as cancellation without copying", async () => {
    const copy = vi.fn();
    expect(await shareEditionLink(content, { share: vi.fn().mockRejectedValue({ name: "AbortError" }), copy })).toBe("cancelled");
    expect(copy).not.toHaveBeenCalled();
  });

  it("copies when native sharing is unavailable or fails", async () => {
    for (const share of [undefined, vi.fn().mockRejectedValue(new Error("Unavailable"))]) {
      const copy = vi.fn().mockResolvedValue(undefined);
      expect(await shareEditionLink(content, { share, copy })).toBe("copied");
      expect(copy).toHaveBeenCalledWith(content.url);
    }
  });

  it("requests a manual fallback when both browser capabilities are unavailable or fail", async () => {
    expect(await shareEditionLink(content, {})).toBe("fallback");
    expect(await shareEditionLink(content, { share: vi.fn().mockRejectedValue(new Error("Denied")), copy: vi.fn().mockRejectedValue(new Error("Denied")) })).toBe("fallback");
  });
});
