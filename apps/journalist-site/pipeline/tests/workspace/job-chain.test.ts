import { afterEach, expect, it, vi } from "vitest";
import { callNextJob } from "../../../lib/job-chain";
import { authorizedJobChain } from "../../../lib/pipeline-auth";

const secret = "fixture-only-job-secret";
const origin = "https://newsbee.example";
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("refreshes an expired hand-off token without weakening the receiving guard", async () => {
  vi.stubEnv("AUTH_SECRET", secret); vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-02T04:00:00Z"));
  const tokens: string[] = [];
  const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
    const request = new Request(url, init);
    tokens.push(request.headers.get("x-newsbee-job-token")!);
    if (tokens.length === 1) vi.setSystemTime(Date.now() + 121_000);
    return authorizedJobChain(request, secret) ? Response.json({ executed: true })
      : Response.json({ detail: "Unauthorized" }, { status: 401 });
  });
  vi.stubGlobal("fetch", fetcher);
  await callNextJob(`${origin}/api/admin/runs/fixture/finish`);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(tokens[0]).not.toBe(tokens[1]);
  expect(fetcher.mock.calls.every(([url]) => url.toString() === `${origin}/api/pipeline/advance`)).toBe(true);
});

it("keeps a genuine secret mismatch bounded and visible", async () => {
  vi.stubEnv("AUTH_SECRET", secret);
  const fetcher = vi.fn(async () => Response.json({ detail: "Unauthorized" }, { status: 401 }));
  vi.stubGlobal("fetch", fetcher);
  await expect(callNextJob(origin)).rejects.toThrow(/AUTH_SECRET/);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("does not retry successful requests or unrelated failures", async () => {
  vi.stubEnv("AUTH_SECRET", secret);
  const fetcher = vi.fn(async () => Response.json({ executed: true }));
  vi.stubGlobal("fetch", fetcher);
  await callNextJob(origin); expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockImplementation(async () => new Response("worker unavailable", { status: 500 }));
  await expect(callNextJob(origin)).rejects.toThrow(/returned 500/);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("requires the server secret before sending any request", async () => {
  vi.stubEnv("AUTH_SECRET", ""); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  await expect(callNextJob(origin)).rejects.toThrow(/AUTH_SECRET is required/);
  expect(fetcher).not.toHaveBeenCalled();
});
