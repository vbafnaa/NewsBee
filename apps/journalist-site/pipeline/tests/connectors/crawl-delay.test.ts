import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscoveryBlockedError, Fetcher, MAX_CRAWL_DELAY } from "../../connectors/fetcher";
import type { HttpTransport } from "../../core/http";

const html = "<html><body><p>Lakeside notices</p></body></html>";
/** A site whose robots.txt asks for `delay` seconds between pages; every request's time is kept. */
function site(delay: number) {
  const at: Array<{ url: string; at: number }> = [];
  const transport: HttpTransport = async (request) => {
    at.push({ url: request.url, at: Date.now() });
    const robots = new URL(request.url).pathname === "/robots.txt";
    return { url: request.url, status: 200, headers: { "content-type": robots ? "text/plain" : "text/html" }, body: new TextEncoder().encode(robots ? `User-agent: *\nCrawl-delay: ${delay}\nDisallow:\n` : html) };
  };
  return { transport, at };
}

afterEach(() => { vi.useRealTimers(); });

describe("crawl delay", () => {
  it("waits up to 10 seconds between a site's pages, as the playbook says", async () => {
    expect(MAX_CRAWL_DELAY).toBe(10);
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    const { transport, at } = site(10);
    const fetcher = new Fetcher(transport);
    const reading = (async () => {
      await fetcher.getText("https://ten.example.org/a", 1024 * 1024, "text/html");
      await fetcher.getText("https://ten.example.org/b", 1024 * 1024, "text/html");
    })();
    await vi.advanceTimersByTimeAsync(25_000);
    await reading;
    // robots.txt, then each page 10 seconds after the last request.
    expect(at.map((item) => new URL(item.url).pathname)).toEqual(["/robots.txt", "/a", "/b"]);
    expect(at[1].at - at[0].at).toBeGreaterThanOrEqual(10_000);
    expect(at[2].at - at[1].at).toBeGreaterThanOrEqual(10_000);
  });

  it("skips a site asking for longer than 10 seconds", async () => {
    const { transport } = site(12);
    await expect(new Fetcher(transport).getText("https://twelve.example.org/a", 1024 * 1024, "text/html")).rejects.toThrow(/crawl-delay of 12s is longer than 10s/);
  });

  it("refuses a page whose wait wouldn't fit in the job's time, instead of stalling it", async () => {
    const { transport, at } = site(10);
    const fetcher = new Fetcher(transport);
    fetcher.deadline = Date.now() + 3_000;
    const started = Date.now();
    const error = await fetcher.getText("https://slow.example.org/a", 1024 * 1024, "text/html").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DiscoveryBlockedError);
    expect(String((error as Error).message)).toMatch(/waiting 10s for slow\.example\.org's turn \(crawl delay 10s\) wouldn't fit in this job's time/);
    // It didn't wait, and never asked for the page.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(at.map((item) => new URL(item.url).pathname)).toEqual(["/robots.txt"]);
  });
});
