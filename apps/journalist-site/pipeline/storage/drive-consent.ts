import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Db } from "mongodb";
import { normalizedEmail, principalForEmail } from "../accounts/identity";
import { refreshGoogleDriveAccess } from "./user-drive";

type DriveConsent = { _id: string; credential: string };
const collection = (db: Db) => db.collection<DriveConsent>("google_drive_consents");

function encryptionKey() {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is required to save Google Drive consent");
  return createHash("sha256").update(`newsbee-google-drive:${secret}`).digest();
}

export async function saveDriveConsent(db: Db, email: string, refreshToken: string) {
  const id = normalizedEmail(email);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from(id));
  const ciphertext = Buffer.concat([cipher.update(refreshToken, "utf8"), cipher.final()]);
  const credential = [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url")).join(".");
  await collection(db).updateOne({ _id: id }, { $set: { credential } }, { upsert: true });
}

export async function editorDriveAccess(db: Db, email: string) {
  const id = normalizedEmail(email);
  if (!(await principalForEmail(db, id))) throw new Error("An approved journalist must authorize the edition's Drive upload");
  const saved = await collection(db).findOne({ _id: id });
  const reconnect = `Connect Google Drive as ${id} on the Publishing Channels page, then retry the edition step.`;
  if (!saved) throw new Error(`The service account has no Drive storage quota. ${reconnect}`);
  let refreshToken: string;
  try {
    const [iv, tag, ciphertext] = saved.credential.split(".").map((part) => Buffer.from(part, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
    decipher.setAAD(Buffer.from(id));
    decipher.setAuthTag(tag);
    refreshToken = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error(`Saved Google Drive authorization is unavailable. ${reconnect}`);
  }
  return refreshGoogleDriveAccess(refreshToken);
}
