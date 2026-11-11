import type { Db } from "mongodb";
import { isMongoChannelFolderId, mongoChannelFolderId } from "../../../../shared/reader-folder";
import { artifactSegment, type ArtifactStore } from "./artifacts";
import { COLLECTIONS } from "./mongo";

type ChannelFile = { _id: string; folder_id: string; name: string; value: string };

export async function driveChannelFolderOrMongo(
  store: ArtifactStore, id: string, authorized: boolean, createDriveFolder: () => Promise<string>,
  onDriveFailure: (error: unknown) => void,
) {
  if (authorized) {
    try {
      const folderId = await createDriveFolder();
      await store.saveJson(folderId, "locations.json", { locations: [] });
      return folderId;
    } catch (error) {
      onDriveFailure(error);
    }
  }
  return mongoChannelFolderId(id);
}

export function channelArtifactStore(db: Db, store: ArtifactStore, folderId: string): ArtifactStore {
  if (!isMongoChannelFolderId(folderId)) return store;
  const files = db.collection<ChannelFile>(COLLECTIONS.outputChannelFiles);
  const fileKey = (parentId: string, name: string) => {
    if (parentId !== folderId) throw new Error("Invalid MongoDB channel folder");
    return `${parentId}/${artifactSegment(name)}`;
  };
  return {
    kind: "local",
    async ensureFolder() { throw new Error("MongoDB channel folders cannot contain subfolders"); },
    async findFolder() { return null; },
    async saveJson(parentId, name, value) {
      return this.saveText(parentId, name, `${JSON.stringify(value, null, 2)}\n`, "application/json");
    },
    async saveText(parentId, name, value) {
      const _id = fileKey(parentId, name);
      await files.updateOne({ _id }, { $set: { folder_id: parentId, name, value } }, { upsert: true });
      return _id;
    },
    async readJson<T>(fileId: string) { return JSON.parse(await this.readText(fileId)) as T; },
    async readText(fileId) {
      const document = await files.findOne({ _id: fileId, folder_id: folderId });
      if (!document) throw new Error("MongoDB channel file not found");
      return document.value;
    },
    async list(parentId) {
      if (parentId !== folderId) throw new Error("Invalid MongoDB channel folder");
      return files.find({ folder_id: parentId }).map(({ _id, name }) => ({ id: _id, name })).toArray();
    },
    async removeFile(parentId, name) {
      return (await files.deleteOne({ _id: fileKey(parentId, name) })).deletedCount;
    },
  };
}
