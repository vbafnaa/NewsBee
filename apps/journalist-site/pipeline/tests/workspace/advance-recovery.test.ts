import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  callNextJob: vi.fn(),
  queueNextJob: vi.fn(),
  continueQueue: vi.fn(),
  maintain: vi.fn(),
  runOne: vi.fn(),
}));
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("../../../lib/pipeline-auth", () => ({ authorizedJobChain: () => true }));
vi.mock("../../../lib/job-chain", () => ({ callNextJob: mocks.callNextJob }));
vi.mock("../../../lib/pipeline-queue", () => ({ queueNextJob: mocks.queueNextJob }));
vi.mock("../../../lib/pipeline", () => ({ pipelineDeps: async () => ({ settings: { mode: "cloud" }, db: {} }) }));
vi.mock("../../orchestration/dispatch", () => ({ maintain: mocks.maintain, continueQueue: mocks.continueQueue }));
vi.mock("../../orchestration/orchestrator", () => ({ runOne: mocks.runOne }));
vi.mock("../../orchestration/scheduler", () => ({ recordSchedulerSafely: vi.fn() }));

import { POST } from "../../../app/api/pipeline/advance/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runOne.mockResolvedValue(true);
  mocks.maintain.mockResolvedValue(true);
  mocks.callNextJob.mockResolvedValue(undefined);
  mocks.queueNextJob.mockResolvedValue(undefined);
});

it("continues HTTP recovery over HTTP in cloud mode, reserving the queue for delayed retries", async () => {
  const url = "https://newsbee.example/api/pipeline/advance";
  const response = await POST(new Request(url, { method: "POST" }));
  expect(response.status).toBe(200);
  expect(mocks.after).toHaveBeenCalledOnce();
  const callback = mocks.after.mock.calls[0][0] as () => Promise<void>;
  mocks.continueQueue.mockImplementation(async (_deps, _executed, send: (delay?: number) => Promise<void>) => {
    await send();
    await send(5);
  });
  await callback();
  expect(mocks.callNextJob).toHaveBeenCalledExactlyOnceWith(url);
  expect(mocks.queueNextJob).toHaveBeenCalledExactlyOnceWith(5);
});
