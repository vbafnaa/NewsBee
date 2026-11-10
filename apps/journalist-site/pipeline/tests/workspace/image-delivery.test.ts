import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn(), readerData: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:https", () => ({ request: mocks.request }));
vi.mock("../../../../reader-site/src/lib/reader-data", () => ({ readerData: mocks.readerData }));

import { createImageDelivery, downloadStoryImage, isPublicImageAddress, validImageBytes } from "../../../../reader-site/src/lib/image-delivery";
import { publicHttpsGet } from "../../../../../shared/image-http";
import { GET } from "../../../../reader-site/src/pages/api/images/[location_id]";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const delivered = { bytes: png, contentType: "image/png", etag: '"test-image"' };
type PlannedResponse = { status?: number; headers?: Record<string, string>; chunks?: Buffer[] };
let plans: PlannedResponse[];

beforeEach(() => {
  plans = [];
  mocks.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  mocks.request.mockImplementation((_url, options, callback) => {
    const req = new EventEmitter() as EventEmitter & { end(): void };
    req.end = () => queueMicrotask(() => {
      const plan = plans.shift() ?? {};
      const res = Object.assign(new EventEmitter(), {
        statusCode: plan.status ?? 200,
        headers: plan.headers ?? { "content-type": "image/png" },
        destroyed: false,
        destroy() { this.destroyed = true; },
      });
      callback(res);
      if (res.destroyed) return;
      for (const chunk of plan.chunks ?? [png]) {
        res.emit("data", chunk);
        if (res.destroyed) return;
      }
      res.emit("end");
    });
    return req;
  });
  mocks.readerData.mockResolvedValue({
    locations: [{ id: "town-wa" }],
    editions: [{ id: "published", location_id: "town-wa", items: [{ image: "https://images.publisher.com/route.png" }] },
      { id: "other", location_id: "other-wa", items: [{ image: "https://images.publisher.com/private.png" }] }],
  });
});
afterEach(() => vi.clearAllMocks());

describe("safe image transport", () => {
  it("blocks private, reserved, mapped and transition addresses", () => {
    for (const address of ["127.0.0.1", "10.1.1.1", "172.20.0.1", "192.168.0.1", "169.254.169.254", "100.64.0.1",
      "0.0.0.0", "224.1.1.1", "198.18.0.1", "192.0.2.1", "::1", "::ffff:127.0.0.1", "fe80::1", "fc00::1", "2001:db8::1", "2002:7f00:1::", "2001::1"])
      expect(isPublicImageAddress(address), address).toBe(false);
    for (const address of ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111", "2001:4860:4860::8888"])
      expect(isPublicImageAddress(address), address).toBe(true);
  });

  it("validates all DNS answers before opening any connection", async () => {
    mocks.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }]);
    await expect(downloadStoryImage("https://images.publisher.com/photo.png")).rejects.toThrow("not public");
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("pins the checked address while keeping the TLS hostname and validates raster bytes", async () => {
    const image = await downloadStoryImage("https://images.publisher.com/photo.png");
    expect(image.bytes).toEqual(png);
    expect(image.contentType).toBe("image/png");
    const [url, options] = mocks.request.mock.calls[0];
    expect(url.hostname).toBe("images.publisher.com");
    expect(options.agent).toBe(false);
    const callback = vi.fn();
    options.lookup("images.publisher.com", { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, [{ address: "93.184.216.34", family: 4 }]);
    expect(image.etag).toMatch(/^"[a-f0-9]{64}"$/);
  });

  it("rejects an image-shaped error response instead of treating it as an available photo", async () => {
    plans = [{ status: 404, headers: { "content-type": "image/png" }, chunks: [png] }];
    await expect(downloadStoryImage("https://images.publisher.com/missing.png")).rejects.toThrow();
  });

  it("prefers checked public IPv4 when DNS lists IPv6 first", async () => {
    mocks.lookup.mockResolvedValue([{ address: "2606:4700:4700::1111", family: 6 }, { address: "93.184.216.34", family: 4 }]);
    await downloadStoryImage("https://images.publisher.com/photo.png");
    const callback = vi.fn();
    mocks.request.mock.calls[0][1].lookup("images.publisher.com", { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, [{ address: "93.184.216.34", family: 4 }]);
  });

  it("shares the public-host guard with HTML/robots metadata fetches", async () => {
    await expect(publicHttpsGet({ url: "https://127.0.0.1/robots.txt" })).rejects.toThrow("invalid");
    mocks.lookup.mockResolvedValueOnce([{ address: "10.0.0.1", family: 4 }]);
    await expect(publicHttpsGet({ url: "https://metadata.publisher.com/robots.txt" })).rejects.toThrow("not public");
    expect(mocks.request).not.toHaveBeenCalled();
    plans.push({ headers: { "content-type": "text/html" }, chunks: [Buffer.from("<title>A park</title>")] });
    const response = await publicHttpsGet({ url: "https://metadata.publisher.com/story", maxBytes: 1024 });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("text/html");
    expect(Buffer.from(response.body).toString()).toBe("<title>A park</title>");
  });

  it("rejects redirect destinations that resolve privately and limits redirect loops", async () => {
    plans.push({ status: 302, headers: { location: "https://internal.publisher.com/secret" } });
    mocks.lookup.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValueOnce([{ address: "10.1.1.1", family: 4 }]);
    await expect(downloadStoryImage("https://images.publisher.com/photo.png")).rejects.toThrow("not public");
    expect(mocks.request).toHaveBeenCalledTimes(1);
    mocks.request.mockClear();
    for (let i = 0; i < 5; i++) plans.push({ status: 302, headers: { location: "/again" } });
    await expect(downloadStoryImage("https://images.publisher.com/photo.png")).rejects.toThrow("unavailable");
    expect(mocks.request).toHaveBeenCalledTimes(4);
  });

  it("rejects SVG, HTML masquerading as PNG, advertised and streamed oversized responses", async () => {
    const invalidResponses: PlannedResponse[] = [
      { headers: { "content-type": "image/svg+xml" } },
      { chunks: [Buffer.from("<html>not an image</html>")] },
      { headers: { "content-type": "image/png", "content-length": String(7 * 1024 * 1024) } },
      { chunks: [Buffer.alloc(6 * 1024 * 1024), Buffer.alloc(1)] },
    ];
    for (const plan of invalidResponses) {
      plans.push(plan);
      await expect(downloadStoryImage("https://images.publisher.com/photo.png")).rejects.toThrow();
    }
    expect(validImageBytes(png, "image/jpeg")).toBe(false);
    expect(validImageBytes(Buffer.from("RIFFxxxxWEBP"), "image/webp")).toBe(true);
  });
});

describe("bounded delivery cache", () => {
  it("coalesces simultaneous requests, caches success, and retries failure", async () => {
    let complete!: (image: typeof delivered) => void;
    const load = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }))
      .mockResolvedValue(delivered);
    const deliver = createImageDelivery(load);
    const first = deliver("https://images.publisher.com/a.png");
    const second = deliver("https://images.publisher.com/a.png");
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    complete(delivered);
    expect(await first).toEqual(await second);
    await deliver("https://images.publisher.com/a.png");
    expect(load).toHaveBeenCalledTimes(1);
    const failedLoad = vi.fn().mockRejectedValueOnce(new Error("temporary outage")).mockResolvedValue(delivered);
    const retry = createImageDelivery(failedLoad);
    await expect(retry("https://images.publisher.com/b.png")).rejects.toThrow("temporary outage");
    expect(await retry("https://images.publisher.com/b.png")).toEqual(delivered);
    expect(failedLoad).toHaveBeenCalledTimes(2);
  });

  it("serves a previously loaded image during a short outage and expires it after a day", async () => {
    let clock = 0;
    const load = vi.fn().mockResolvedValueOnce(delivered).mockRejectedValue(new Error("offline"));
    const deliver = createImageDelivery(load, () => clock);
    await deliver("https://images.publisher.com/a.png");
    clock = 2 * 60 * 60 * 1000;
    expect(await deliver("https://images.publisher.com/a.png")).toEqual(delivered);
    clock = 25 * 60 * 60 * 1000;
    await expect(deliver("https://images.publisher.com/a.png")).rejects.toThrow("offline");
  });

  it("evicts least recently used bytes to stay within 24 MB", async () => {
    const load = vi.fn().mockResolvedValue({ ...delivered, bytes: new Uint8Array(6 * 1024 * 1024) });
    const deliver = createImageDelivery(load);
    for (let i = 0; i < 5; i++) await deliver(`https://images.publisher.com/${i}.png`);
    await deliver("https://images.publisher.com/4.png");
    expect(load).toHaveBeenCalledTimes(5);
    await deliver("https://images.publisher.com/0.png");
    expect(load).toHaveBeenCalledTimes(6);
  });

  it("queues photo grids above eight active downloads and drains them in order", async () => {
    const complete: Array<(image: typeof delivered) => void> = [];
    const load = vi.fn((_source: string, _signal?: AbortSignal) => new Promise<typeof delivered>((resolve) => complete.push(resolve)));
    const deliver = createImageDelivery(load);
    const requests = Array.from({ length: 12 }, (_, index) => deliver(`https://images.publisher.com/grid-${index}.png`));
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(8);
    for (const resolve of complete.slice(0, 4)) resolve(delivered);
    await Promise.all(requests.slice(0, 4));
    expect(load).toHaveBeenCalledTimes(12);
    expect(load.mock.calls.slice(8).map((call) => call[0])).toEqual(Array.from({ length: 4 }, (_, i) => `https://images.publisher.com/grid-${i + 8}.png`));
    for (const resolve of complete.slice(4)) resolve(delivered);
    expect(await Promise.all(requests)).toHaveLength(12);
  });
});

describe("published image route", () => {
  const get = (query: string, location = "town-wa", headers?: HeadersInit) => {
    const url = new URL(`https://newsbee.example/reader/api/images/${location}?${query}`);
    return GET({ params: { location_id: location }, url, request: new Request(url, { headers }) } as unknown as Parameters<typeof GET>[0]);
  };

  it("rejects arbitrary URLs, invalid indexes, removed locations and editions from another town", async () => {
    expect((await get("url=https://images.publisher.com/photo.png")).status).toBe(400);
    for (const query of ["edition=published&item=-1", "edition=published&item=1.2", "edition=published&item=00"])
      expect((await get(query)).status).toBe(400);
    for (const query of ["edition=other&item=0", "edition=missing&item=0", "edition=published&item=5"])
      expect((await get(query)).status).toBe(404);
    expect((await get("edition=published&item=0", "removed-wa")).status).toBe(404);
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("returns safe cached image responses and handles ETag conditionals", async () => {
    const response = await get("edition=published&item=0");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toContain("stale-while-revalidate");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(png));
    const cached = await get("edition=published&item=0", "town-wa", { "If-None-Match": response.headers.get("etag")! });
    expect(cached.status).toBe(304);
    expect(cached.headers.has("content-length")).toBe(false);
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
});
