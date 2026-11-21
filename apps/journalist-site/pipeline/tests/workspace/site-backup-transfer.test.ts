import { describe, expect, it, vi } from "vitest";
import { backupStream, backupTextChunks } from "../../../lib/site-backup-response";
import { BACKUP_STREAM_TYPE, readBackupTransfer } from "../../../lib/site-backup-transfer";

const request = () => new Request("https://workspace.example.test/api/admin/site-backup");
const response = (text: string) => new Response(text, { headers: { "Content-Type": BACKUP_STREAM_TYPE } });

describe("backup transfer protocol", () => {
  it("streams a complete archive larger than the hosted payload limit without corrupting Unicode", async () => {
    const text = JSON.stringify({ text: `${"a".repeat(65_526)}\uD83D\uDC1D${"archive ".repeat(700_000)}` });
    const parts: string[] = [];
    const progress = vi.fn();
    const stream = backupStream(request(), async (options, emit) => {
      options.onProgress?.("Exporting artifacts...");
      for (const data of backupTextChunks(text)) emit({ type: "chunk", data });
      emit({ type: "complete" });
    });
    await readBackupTransfer(stream, progress, (data) => { parts.push(data); });
    expect(await new Blob(parts).text()).toBe(text);
    expect(progress).toHaveBeenCalledWith("Exporting artifacts...");
    expect(parts.length).toBeGreaterThan(1);
  });

  it("rejects truncated or failed streams rather than downloading a partial archive", async () => {
    await expect(readBackupTransfer(response('{"type":"chunk","data":"partial"}\n'), vi.fn(), vi.fn()))
      .rejects.toThrow("ended before completion");
    await expect(readBackupTransfer(response('{"type":"error","detail":"Drive timed out"}\n'), vi.fn()))
      .rejects.toThrow("Drive timed out");
    await expect(readBackupTransfer(response('{"type":"complete"'), vi.fn())).rejects.toThrow("ended before completion");
  });

  it("reports hosting and sign-in failures that are not JSON", async () => {
    await expect(readBackupTransfer(new Response("FUNCTION_PAYLOAD_TOO_LARGE", { status: 413 }), vi.fn()))
      .rejects.toThrow("chunked backup uploads");
    await expect(readBackupTransfer(new Response("<html>sign in</html>"), vi.fn())).rejects.toThrow("Sign in again");
  });

  it("returns replacement counts only on an explicit successful completion", async () => {
    const result = { collections: 2, documents: 10, artifactFiles: 3 };
    const stream = backupStream(request(), async (_options, emit) => { emit({ type: "complete", result }); });
    await expect(readBackupTransfer(stream, vi.fn())).resolves.toEqual(result);
  });

  it("stops a disconnected transfer and propagates its abort signal", async () => {
    let transferSignal: AbortSignal | undefined;
    const stream = backupStream(request(), async (options) => {
      transferSignal = options.signal;
      await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
    });
    const reader = stream.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(transferSignal?.aborted).toBe(true);
  });
});
