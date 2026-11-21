import { BACKUP_STREAM_TYPE, type BackupEvent } from "./site-backup-transfer";
import type { BackupOptions } from "@/pipeline/storage/site-backup";
import { logger } from "@/pipeline/core/log";

export function backupStream(request: Request, run: (options: BackupOptions, emit: (event: BackupEvent) => void) => Promise<void>) {
  const controller = new AbortController();
  const signal = AbortSignal.any([request.signal, controller.signal]);
  const timeout = setTimeout(() => controller.abort(new Error(
    "Backup exceeded the server time limit. Import may be incomplete if replacement had already started; restore a known-good backup before using this stack.",
  )), 270_000);
  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(output) {
      function emit(event: BackupEvent) {
        if (!closed) output.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      }
      let message = "Starting backup transfer...";
      emit({ type: "progress", message });
      const heartbeat = setInterval(() => emit({ type: "progress", message }), 5_000);
      try {
        await run({ signal, onProgress: (next) => {
          message = next;
          emit({ type: "progress", message });
        } }, emit);
        signal.throwIfAborted();
      } catch (error) {
        logger("site-backup").error("transfer_failed", { error, stage: message });
        emit({ type: "error", detail: error instanceof Error ? error.message : "Backup transfer failed." });
        controller.abort(error);
      } finally {
        clearTimeout(timeout);
        clearInterval(heartbeat);
        if (!closed) { closed = true; output.close(); }
      }
    },
    cancel() {
      closed = true;
      controller.abort(new Error("Backup connection closed."));
      clearTimeout(timeout);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": `${BACKUP_STREAM_TYPE}; charset=utf-8`,
      "Cache-Control": "private, no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

export function* backupTextChunks(text: string) {
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 64 * 1024, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xD800 && last <= 0xDBFF) end -= 1;
    yield text.slice(start, end);
    start = end;
  }
}
