export const BACKUP_MAX_BYTES = 250 * 1024 * 1024;
export const BACKUP_CHUNK_BYTES = 1024 * 1024;
export const BACKUP_STREAM_TYPE = "application/x-ndjson";

export type BackupResult = { collections: number; documents: number; artifactFiles: number };
export type BackupEvent =
  | { type: "progress"; message: string }
  | { type: "chunk"; data: string }
  | { type: "complete"; result?: BackupResult }
  | { type: "error"; detail: string };

export async function backupResponseError(response: Response) {
  const body: unknown = await response.json().catch(() => null);
  if (body && typeof body === "object" && "detail" in body && typeof body.detail === "string") return body.detail;
  if (response.status === 413) return "The server rejected the upload size. Reload the page to use chunked backup uploads.";
  if (response.status === 401) return "Your session expired. Sign in again before retrying.";
  return `Backup request failed (HTTP ${response.status}).`;
}

export async function readBackupTransfer(
  response: Response,
  onProgress: (message: string) => void,
  onChunk?: (data: string) => void,
): Promise<BackupResult | undefined> {
  if (!response.ok) throw new Error(await backupResponseError(response));
  if (!response.headers.get("content-type")?.includes(BACKUP_STREAM_TYPE) || !response.body) {
    throw new Error("The server did not return a backup stream. Sign in again or reload the page.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let complete = false;
  let bytes = 0;
  let result: BackupResult | undefined;
  function consume(line: string) {
    if (complete) throw new Error("Unexpected data after the backup completed.");
    const event = JSON.parse(line) as BackupEvent;
    if (event.type === "error") throw new Error(event.detail);
    if (event.type === "progress") onProgress(event.message);
    else if (event.type === "chunk" && onChunk) {
      bytes += new TextEncoder().encode(event.data).byteLength;
      if (bytes > BACKUP_MAX_BYTES) throw new Error("The complete backup exceeds the 250 MB limit.");
      onChunk(event.data);
    } else if (event.type === "complete") {
      complete = true;
      result = event.result;
    } else throw new Error("Invalid backup transfer response.");
  }
  try {
    for (;;) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        consume(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
      if (pending.length > BACKUP_CHUNK_BYTES) throw new Error("Invalid backup transfer response.");
      if (done) break;
    }
    if (pending || !complete) throw new Error("The backup connection ended before completion. No complete backup was received.");
    return result;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
}
