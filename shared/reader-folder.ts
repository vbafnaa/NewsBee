/**
 * The folder the reader site reads and the pipeline publishes to: a Google Drive folder id
 * in cloud mode, or the folder of that name inside the local Drive stand-in.
 * Existing output-channel configuration takes precedence over the environment fallback.
 */
export const DEFAULT_READER_DRIVE_FOLDER_ID = "1S2uePphOd_25yandeFtQJ6iZvSz2ydYw";

const FOLDER_ID = /^[A-Za-z0-9_-]{10,200}$/;
const MONGO_CHANNEL_ID = /^mongo:[a-f0-9]{32}$/;

export function mongoChannelFolderId(channelId: string) {
  if (!/^[a-f0-9]{32}$/.test(channelId)) throw new Error("Invalid publishing channel ID");
  return `mongo:${channelId}`;
}

export function isMongoChannelFolderId(folderId: string) {
  return MONGO_CHANNEL_ID.test(folderId);
}

export function readerDriveFolderId(env: Record<string, string | undefined> = process.env) {
  const configured = env.NEWSBEE_READER_DRIVE_FOLDER_ID?.trim();
  if (!configured) return DEFAULT_READER_DRIVE_FOLDER_ID;
  if (!FOLDER_ID.test(configured)) throw new Error("NEWSBEE_READER_DRIVE_FOLDER_ID is not a valid Drive folder id");
  return configured;
}

export type ReaderChannel = { _id: string; enabled?: unknown; drive_folder_id?: unknown };

export async function resolveReaderDriveFolderId(
  findChannel: (id: string) => Promise<ReaderChannel | null>,
  env: Record<string, string | undefined> = process.env,
) {
  const channelId = env.NEWSBEE_OUTPUT_CHANNEL_ID ?? "reader-site";
  const channel = await findChannel(channelId);
  if (!channel) return readerDriveFolderId(env);
  if (typeof channel.enabled !== "boolean" ||
    typeof channel.drive_folder_id !== "string" ||
    !FOLDER_ID.test(channel.drive_folder_id) && !isMongoChannelFolderId(channel.drive_folder_id)) {
    throw new Error(`Reader output channel ${channelId} configuration is malformed`);
  }
  if (!channel.enabled) throw new Error(`Reader output channel ${channelId} is disabled`);
  return channel.drive_folder_id;
}
