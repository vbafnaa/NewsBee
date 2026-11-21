import { randomUUID } from "node:crypto";
import { Binary, type Db } from "mongodb";
import { BACKUP_CHUNK_BYTES, BACKUP_MAX_BYTES } from "../../lib/site-backup-transfer";

export const BACKUP_STAGING_COLLECTIONS: readonly string[] = ["_newsbee_backup_uploads", "_newsbee_backup_chunks"];
type Upload = { _id: string; owner: string; bytes: number; expiresAt: Date };
type Chunk = { _id: string; uploadId: string; part: number; data: Binary; expiresAt: Date };

export async function startBackupUpload(db: Db, owner: string, bytes: number) {
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > BACKUP_MAX_BYTES) throw new Error("Invalid backup size; the maximum is 250 MB.");
  await Promise.all(BACKUP_STAGING_COLLECTIONS.map((name) =>
    db.collection(name).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })));
  await db.collection(BACKUP_STAGING_COLLECTIONS[1]).createIndex({ uploadId: 1, part: 1 }, { unique: true });
  const upload: Upload = { _id: randomUUID(), owner, bytes, expiresAt: new Date(Date.now() + 60 * 60_000) };
  await db.collection<Upload>(BACKUP_STAGING_COLLECTIONS[0]).insertOne(upload);
  return { uploadId: upload._id, chunkBytes: BACKUP_CHUNK_BYTES };
}

async function findUpload(db: Db, owner: string, id: string) {
  const upload = await db.collection<Upload>(BACKUP_STAGING_COLLECTIONS[0])
    .findOne({ _id: id, owner, expiresAt: { $gt: new Date() } });
  if (!upload) throw new Error("Backup upload not found or expired. Select the file and upload it again.");
  return upload;
}

export async function saveBackupChunk(db: Db, owner: string, id: string, part: number, data: Uint8Array) {
  const upload = await findUpload(db, owner, id);
  const parts = Math.ceil(upload.bytes / BACKUP_CHUNK_BYTES);
  if (!Number.isSafeInteger(part) || part < 0 || part >= parts ||
    data.byteLength !== Math.min(BACKUP_CHUNK_BYTES, upload.bytes - part * BACKUP_CHUNK_BYTES)) {
    throw new Error("Invalid backup chunk size or position.");
  }
  await db.collection<Chunk>(BACKUP_STAGING_COLLECTIONS[1]).replaceOne(
    { _id: `${id}:${part}` },
    { uploadId: id, part, data: new Binary(data), expiresAt: upload.expiresAt },
    { upsert: true },
  );
}

export async function readBackupUpload(db: Db, owner: string, id: string): Promise<unknown> {
  const upload = await findUpload(db, owner, id);
  const chunks = await db.collection<Chunk>(BACKUP_STAGING_COLLECTIONS[1]).find({ uploadId: id }).sort({ part: 1 }).toArray();
  if (chunks.length !== Math.ceil(upload.bytes / BACKUP_CHUNK_BYTES) ||
    chunks.some((chunk, part) => chunk.part !== part ||
      chunk.data.length() !== Math.min(BACKUP_CHUNK_BYTES, upload.bytes - part * BACKUP_CHUNK_BYTES))) {
    throw new Error("Backup upload is incomplete. Upload the file again before importing.");
  }
  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.data.value())), upload.bytes).toString("utf8");
  try { return JSON.parse(text) as unknown; }
  catch { throw new Error("The uploaded file is not valid JSON."); }
}

export async function deleteBackupUpload(db: Db, owner: string, id: string) {
  await findUpload(db, owner, id);
  await db.collection<Chunk>(BACKUP_STAGING_COLLECTIONS[1]).deleteMany({ uploadId: id });
  await db.collection<Upload>(BACKUP_STAGING_COLLECTIONS[0]).deleteOne({ _id: id, owner });
}
