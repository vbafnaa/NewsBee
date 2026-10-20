import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const callbacks = vi.hoisted(() => [] as Array<() => Promise<void>>);
vi.mock("next/server", () => ({ after: (callback: () => Promise<void>) => { callbacks.push(callback); } }));
vi.mock("@/lib/pipeline", () => ({ pipelineDeps: vi.fn() }));
vi.mock("@/pipeline/orchestration/orchestrator", () => ({ runOne: vi.fn() }));
vi.mock("@/pipeline/orchestration/runs", () => ({ oldestActiveRun: vi.fn() }));
vi.mock("@/pipeline/orchestration/jobs", () => ({ nextPendingJob: vi.fn() }));
vi.mock("@/pipeline/orchestration/diagnostics", () => ({ expireOverdueRuns: vi.fn().mockResolvedValue([]) }));

import { POST } from "../../../app/api/pipeline/advance/route";
import { callNextJob } from "../../../lib/job-chain";
import { authorizedJobChain, jobChainToken } from "../../../lib/pipeline-auth";
import { pipelineDeps } from "../../../lib/pipeline";
import { runOne } from "../../orchestration/orchestrator";
import { nextPendingJob } from "../../orchestration/jobs";
import { oldestActiveRun } from "../../orchestration/runs";

const url = "https://journalist.example/api/pipeline/advance";
const request = (token?: string) => new Request(url, { method: "POST", headers: token ? { "x-newsbee-job-token": token } : {} });

describe("portal job chain", () => {
  const originalSecret = process.env.AUTH_SECRET;
  const originalCron = process.env.CRON_SECRET;

  beforeEach(() => {
    callbacks.length = 0;
    process.env.AUTH_SECRET = "test-auth-secret";
    delete process.env.CRON_SECRET;
    vi.mocked(pipelineDeps).mockResolvedValue({ db: { collection: () => ({ updateOne: vi.fn().mockResolvedValue({}) }) }, settings: { runTimeoutSeconds: 3600 } } as never);
    vi.mocked(oldestActiveRun).mockResolvedValue({ _id: "run-1" } as never);
    vi.mocked(nextPendingJob).mockResolvedValue({ available_at: Date.now() / 1000 - 1 } as never);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    if (originalSecret === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = originalSecret;
    if (originalCron === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalCron;
  });

  it("rejects missing, altered and expired worker tokens", async () => {
    expect((await POST(request())).status).toBe(401);
    const token = jobChainToken(process.env.AUTH_SECRET!);
    expect(authorizedJobChain(request(token))).toBe(true);
    expect(authorizedJobChain(request(`${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`))).toBe(false);
    expect(authorizedJobChain(request(jobChainToken(process.env.AUTH_SECRET!, Date.now() - 121_000)))).toBe(false);
  });

  it("starts the first task without CRON_SECRET and hands off after each completed task", async () => {
    vi.mocked(runOne).mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    vi.stubGlobal("fetch", vi.fn((target: URL, init: RequestInit) => POST(request(new Headers(init.headers).get("x-newsbee-job-token") ?? undefined))));
    await callNextJob(url);
    expect(runOne).toHaveBeenCalledTimes(1);
    expect(callbacks).toHaveLength(1);
    await callbacks.shift()!();
    expect(runOne).toHaveBeenCalledTimes(2);
    await callbacks.shift()!();
    expect(runOne).toHaveBeenCalledTimes(3);
    expect(callbacks).toHaveLength(0);
    expect(vi.mocked(fetch).mock.calls.every(([target]) => String(target) === url)).toBe(true);
  });

  it("waits for a deferred job without running it early", async () => {
    vi.useFakeTimers();
    const readyAt = Date.now() / 1000 + 10;
    vi.mocked(nextPendingJob).mockResolvedValue({ available_at: readyAt } as never);
    vi.mocked(runOne).mockResolvedValue(true);
    vi.stubGlobal("fetch", vi.fn((target: URL, init: RequestInit) => POST(request(new Headers(init.headers).get("x-newsbee-job-token") ?? undefined))));
    const result = await POST(request(jobChainToken(process.env.AUTH_SECRET!)));
    expect(result.status).toBe(200);
    expect((await result.json()).waiting_seconds).toBeGreaterThan(0);
    expect(runOne).not.toHaveBeenCalled();
    expect(callbacks).toHaveLength(1);
    const wake = callbacks.shift()!();
    await vi.advanceTimersByTimeAsync(10_100);
    await wake;
    expect(runOne).toHaveBeenCalledTimes(1);
  });
});
