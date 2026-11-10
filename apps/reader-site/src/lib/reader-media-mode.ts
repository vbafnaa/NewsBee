export type ReaderMediaMode = "illustrated" | "photos" | "none";

export function readerMediaMode(editionMode?: ReaderMediaMode): ReaderMediaMode {
  const value = process.env.NEWSBEE_READER_MEDIA_MODE || editionMode || "illustrated";
  if (value !== "illustrated" && value !== "photos" && value !== "none") throw Error("NEWSBEE_READER_MEDIA_MODE must be illustrated, photos or none");
  return value;
}
