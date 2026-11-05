/**
 * The folder the reader site reads and the pipeline publishes to: a Google Drive folder id
 * in cloud mode, or the folder of that name inside the local Drive stand-in.
 * Every location with a published edition appears there; there are no output channels.
 */
export const DEFAULT_READER_DRIVE_FOLDER_ID = "1S2uePphOd_25yandeFtQJ6iZvSz2ydYw";

const FOLDER_ID = /^[A-Za-z0-9_-]{10,200}$/;

export function readerDriveFolderId(env: Record<string, string | undefined> = process.env) {
  const configured = env.NEWSBEE_READER_DRIVE_FOLDER_ID?.trim();
  if (!configured) return DEFAULT_READER_DRIVE_FOLDER_ID;
  if (!FOLDER_ID.test(configured)) throw new Error("NEWSBEE_READER_DRIVE_FOLDER_ID is not a valid Drive folder id");
  return configured;
}
