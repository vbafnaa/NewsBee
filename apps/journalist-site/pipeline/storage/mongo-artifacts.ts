/**
 * Artifact storage in MongoDB, for deployments that cannot use a Google Shared drive.
 * Folders are namespaces: a file's parent_id is its folder's id, so the reader site can
 * list a channel folder the same way it lists one on Drive.
 */
import { createHash } from "node:crypto";
import type { Collection, Db } from "mongodb";
import { ARTIFACTS_COLLECTION } from "../../../../shared/artifact-store";
import type { ArtifactStore, StoredFile } from "./artifacts";

type ArtifactDoc = { _id: string; parent_id: string; name: string; folder: boolean; mime_type?: string; content?: string; updated_at: Date };

/** Ids come from the parent and name, so saving a name again overwrites it, as on Drive. */
export function artifactId(parentId: string, name: string) {
  return createHash("sha256").update(`${parentId}\u0000${name}`).digest("hex").slice(0, 32);
}

export class MongoArtifacts implements ArtifactStore {
  readonly kind = "mongo" as const;
  private index?: Promise<string>;

  constructor(private readonly database: () => Promise<Db>) {}

  private async collection(): Promise<Collection<ArtifactDoc>> {
    const collection = (await this.database()).collection<ArtifactDoc>(ARTIFACTS_COLLECTION);
    this.index ??= collection.createIndex({ parent_id: 1, folder: 1, name: 1 }).catch((error: unknown) => {
      this.index = undefined;
      throw error;
    });
    await this.index;
    return collection;
  }

  async ensureFolder(parentId: string, name: string) {
    const id = artifactId(parentId, name);
    await (await this.collection()).updateOne(
      { _id: id },
      { $setOnInsert: { parent_id: parentId, name, folder: true, updated_at: new Date() } },
      { upsert: true },
    );
    return id;
  }

  async saveText(parentId: string, name: string, value: string, mimeType: string) {
    const id = artifactId(parentId, name);
    await (await this.collection()).updateOne(
      { _id: id },
      { $set: { parent_id: parentId, name, folder: false, mime_type: mimeType, content: value, updated_at: new Date() } },
      { upsert: true },
    );
    return id;
  }

  async saveJson(parentId: string, name: string, value: unknown) {
    return this.saveText(parentId, name, JSON.stringify(value), "application/json");
  }

  async readText(fileId: string) {
    const doc = await (await this.collection()).findOne({ _id: fileId, folder: false });
    if (typeof doc?.content !== "string") throw new Error(`Artifact ${fileId} was not found`);
    return doc.content;
  }

  async readJson<T>(fileId: string) {
    return JSON.parse(await this.readText(fileId)) as T;
  }

  async list(parentId: string): Promise<StoredFile[]> {
    const docs = await (await this.collection())
      .find({ parent_id: parentId, folder: false }, { projection: { _id: 1, name: 1 } })
      .sort({ name: 1 })
      .toArray();
    return docs.map((doc) => ({ id: doc._id, name: doc.name }));
  }
}
