import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@vercel/queue", () => ({
  send: vi.fn().mockResolvedValue({ messageId: "message-1" }),
  handleCallback: (callback: unknown) => callback,
}));
vi.mock("@/lib/pipeline", () => ({ pipelineDeps: vi.fn() }));
vi.mock("@/pipeline/orchestration/orchestrator", () => ({ runOne: vi.fn(), tick: vi.fn() }));
vi.mock("@/pipeline/orchestration/runs", () => ({ oldestActiveRun: vi.fn() }));
vi.mock("@/pipeline/orchestration/jobs", () => ({ nextJobWake: vi.fn() }));
vi.mock("@/pipeline/orchestration/diagnostics", () => ({ expireOverdueRuns: vi.fn().mockResolvedValue([]) }));

import { send } from "@vercel/queue";
import { POST as optionalTick } from "../../../app/api/pipeline/tick/route";
import { processNextJob } from "../../../lib/pipeline-queue-worker";
import { queueNextJob, PIPELINE_TOPIC } from "../../../lib/pipeline-queue";
import { pipelineDeps } from "../../../lib/pipeline";
import { runOne, tick } from "../../orchestration/orchestrator";
import { nextJobWake } from "../../orchestration/jobs";
import { oldestActiveRun } from "../../orchestration/runs";

describe("cloud pipeline queue handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pipelineDeps).mockResolvedValue({
      db: { collection: () => ({ updateOne: vi.fn().mockResolvedValue({}), findOne: vi.fn().mockResolvedValue(null) }) },
      settings: { mode: "cloud", runTimeoutSeconds: 3600 },
    } as never);
    vi.mocked(oldestActiveRun).mockResolvedValue({ _id: "run-1" } as never);
    vi.mocked(nextJobWake).mockResolvedValue({ available_at: Date.now() / 1000 - 1 } as never);
  });

  it("enqueues the first job without an HTTP self-call or CRON_SECRET", async () => {
    await queueNextJob();
    expect(send).toHaveBeenCalledWith(PIPELINE_TOPIC, { action: "advance" }, undefined);
  });

  it("lets the optional cloud tick recover pending work via the queue without self-fetching", async () => {
    const previous = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "test-cron";
    try {
      const result = await optionalTick(new Request("https://journalist.example/api/pipeline/tick", {
        method: "POST", headers: { Authorization: "Bearer test-cron" },
      }));
      expect(result.status).toBe(200);
      expect(await result.json()).toEqual({ worker_queued: true });
      expect(send).toHaveBeenCalledTimes(1);
      expect(tick).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = previous;
    }
  });

  it("enqueues a new delivery after each job, stopping when no jobs remain", async () => {
    vi.mocked(runOne).mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    vi.mocked(nextJobWake).mockResolvedValueOnce({ available_at: Date.now() / 1000 - 1 } as never)
      .mockResolvedValueOnce({ available_at: Date.now() / 1000 - 1 } as never)
      .mockResolvedValueOnce({ available_at: Date.now() / 1000 - 1 } as never)
      .mockResolvedValueOnce(null);
    await processNextJob();
    expect(send).toHaveBeenCalledTimes(1);
    await processNextJob();
    expect(send).toHaveBeenCalledTimes(2);
    await processNextJob();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("keeps a recovery delivery when a pending job is blocked by a busy worker", async () => {
    vi.mocked(runOne).mockResolvedValue(false);
    vi.mocked(nextJobWake).mockResolvedValueOnce({ available_at: Date.now() / 1000 - 1 } as never)
      .mockResolvedValueOnce({ available_at: Date.now() / 1000 + 330 } as never);
    await processNextJob();
    expect(runOne).toHaveBeenCalledOnce();
    expect(vi.mocked(send).mock.calls[0][2]?.delaySeconds).toBeGreaterThanOrEqual(330);
  });

  it("schedules backoff with the queue rather than sleeping in a function", async () => {
    vi.mocked(nextJobWake).mockResolvedValue({ available_at: Date.now() / 1000 + 45 } as never);
    await processNextJob();
    expect(runOne).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(PIPELINE_TOPIC, { action: "advance" }, { delaySeconds: expect.any(Number) });
    expect(vi.mocked(send).mock.calls[0][2]?.delaySeconds).toBeGreaterThanOrEqual(44);
  });

  it("retries a handoff if publishing the next delivery fails", async () => {
    vi.mocked(runOne).mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    vi.mocked(send).mockRejectedValueOnce(new Error("Queue unavailable"));
    await expect(processNextJob()).rejects.toThrow("Queue unavailable");
    await processNextJob();
    expect(runOne).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
