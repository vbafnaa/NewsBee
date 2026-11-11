import { describe, expect, it } from "vitest";
import { formatLiveLog, type LiveDetail } from "../../../app/source-map/source-run-live-log";

const run: LiveDetail = {
  run: { status: "mapping", created_at: 1000, completed_at: null, error: null, trigger: { kind: "manual", by: "editor" } },
  jobs: [], health: {},
};

describe("Collect sources live text log", () => {
  it("reports a queued run even before the worker starts", () => {
    const text = formatLiveLog(run, {}, {});
    expect(text).toContain("Triggered manual by editor");
    expect(text).toContain("Waiting for source collection jobs to be scheduled");
  });

  it("shows scheduled and executing jobs, worker events and the reason dispatch failed", () => {
    const detail: LiveDetail = { ...run, jobs: [{ id: "job-1", kind: "agent_round", status: "running", attempts: 1,
      created_at: 1001, started_at: 1002, completed_at: null, error: null, log_error: null, log_file: "mongo:job-1" },
      { id: "job-2", kind: "discover", status: "pending", attempts: 1, created_at: 1001, available_at: 1005,
        started_at: 1002, completed_at: null, error: "Worker lease expired", log_error: null, log_file: null,
        dispatch_error: "Worker unavailable", dispatch_error_at: 1004, dispatched_at: 1003 }] };
    const text = formatLiveLog(detail, { "job-1": '{"time":"1970-01-01T00:16:43.000Z","level":"info","component":"agent","event":"search_started","query":"local news","run_id":"secret-id"}\n' }, {});
    expect(text).toContain("agent round: queued");
    expect(text).toContain("agent round: executing (attempt 1)");
    expect(text).toContain("agent · search_started — query: local news");
    expect(text).toContain("dispatch failed — Worker unavailable");
    expect(text).toContain("Worker lease expired");
    expect(text).not.toContain("secret-id");
  });

  it("names each discovery method throughout its lifecycle and supports older jobs without labels", () => {
    const detail: LiveDetail = { ...run, jobs: [
      { id: "government", kind: "discover", discovery_label: "City and county websites", status: "completed", attempts: 1,
        created_at: 1001, started_at: 1002, completed_at: 1003, error: null, log_error: null, log_file: null },
      { id: "schools", kind: "discover", discovery_label: "School districts, boards and PTAs", status: "pending", attempts: 0,
        created_at: 1001, started_at: null, completed_at: null, error: null, log_error: null, log_file: null },
      { id: "older", kind: "discover", status: "pending", attempts: 0,
        created_at: 1001, started_at: null, completed_at: null, error: null, log_error: null, log_file: null },
    ] };
    const text = formatLiveLog(detail, {}, {});
    expect(text).toContain("Discover City and county websites: queued.");
    expect(text).toContain("Discover City and county websites: attempt started (attempt 1).");
    expect(text).toContain("Discover City and county websites: completed.");
    expect(text).toContain("Discover School districts, boards and PTAs: queued.");
    expect(text).toContain("discover: queued.");
  });

  it("reports why a run could not start or failed, including logs that expired", () => {
    const detail: LiveDetail = { run: { ...run.run, status: "failed", completed_at: 1005, error: "Timed out",
      execution_blocked: { at: 1001, reason: "No credential sponsor" } },
    jobs: [{ id: "job-1", kind: "discover", status: "failed", attempts: 1, created_at: 1002, started_at: 1003,
      completed_at: 1004, error: "Reader refused", log_error: "Store unavailable", log_file: "old-file" }],
    health: { diagnostics: { issues: [{ severity: "failed", message: "Worker did not respond" }] } } };
    const text = formatLiveLog(detail, {}, { "job-1": "This log has expired" });
    for (const reason of ["No credential sponsor", "Reader refused", "Store unavailable", "Worker did not respond", "Timed out", "This log has expired"])
      expect(text).toContain(reason);
    expect(text.indexOf("could not start")).toBeLessThan(text.indexOf("Run failed"));
  });
});
