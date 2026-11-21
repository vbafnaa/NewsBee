import { createHash, randomUUID } from "node:crypto";
import { MongoServerError, type Db } from "mongodb";
import { appendPublicationChangeAudit, publicationChangeTransaction } from "../publications/audit";
import { COLLECTIONS } from "../storage/mongo";
import { ensurePublicationIndexes } from "../publications/access";
import { principalById } from "../accounts/identity";
import { canManageNewsrooms, PublicationAccessDenied } from "../publications/permissions";
import { createOutputChannel, getOutputChannel, outputChannelConfigurationHash, outputChannels, type OutputChannelInput } from "./output-channels";

type Folder = { id: string; drive: boolean };
type Creation = {
  _id: string; actor_id: string; payload_hash: string; publication_id: string;
  folder?: Folder; complete: boolean; token?: string; lease_until?: number;
};

export class NewsroomCreationConflict extends Error {}
export class NewsroomCreationInvalid extends Error {}

export async function createNewsroom(
  db: Db, actor: { id: string; email: string }, key: string, input: OutputChannelInput,
  steps: {
    validate: () => Promise<void>;
    planFolder: (id: string) => Promise<Folder>;
    provision: (id: string, folder: Folder) => Promise<void>;
  },
) {
  const requests = db.collection<Creation>(COLLECTIONS.outputChannelCreations);
  const currentActor = await principalById(db, actor.id);
  if (!currentActor || !canManageNewsrooms(currentActor)) throw new PublicationAccessDenied();
  const identity = createHash("sha256").update(JSON.stringify([actor.id, key])).digest("hex");
  const payloadHash = createHash("sha256").update(JSON.stringify({
    ...input, destinations: [...input.destinations].sort((a, b) => a.type.localeCompare(b.type)),
    selectedLocationIds: [...input.selectedLocationIds].sort(),
  })).digest("hex");
  try {
    await requests.insertOne({
      _id: identity, actor_id: actor.id, payload_hash: payloadHash, publication_id: identity.slice(0, 32), complete: false,
    });
  } catch (error) {
    if (!(error instanceof MongoServerError && error.code === 11000)) throw error;
  }
  const existing = await requests.findOne({ _id: identity });
  if (!existing || existing.payload_hash !== payloadHash) {
    throw new NewsroomCreationConflict("This creation key belongs to different newsroom details. Retry the original details or deliberately start a new request.");
  }
  if (existing.complete) {
    const channel = await getOutputChannel(db, actor.id, existing.publication_id);
    if (!channel) throw new NewsroomCreationConflict("This request already created a newsroom that is no longer available. It will not be recreated.");
    return channel;
  }
  const token = randomUUID();
  const claimed = await requests.findOneAndUpdate({
    _id: identity, complete: false,
    $or: [{ token: { $exists: false } }, { lease_until: { $lte: Date.now() } }],
  }, { $set: { token, lease_until: Date.now() + 120_000 } }, { returnDocument: "after" });
  if (!claimed) throw new NewsroomCreationConflict("Newsroom creation is still in progress. Retry with the same details in a moment.");
  try {
    await steps.validate();
    if (!claimed.folder) {
      const planned = await steps.planFolder(claimed.publication_id);
      // Persist a stable destination before any folder or artifact can be created.
      const reserved = await requests.findOneAndUpdate(
        { _id: identity, token, folder: { $exists: false } }, { $set: { folder: planned } }, { returnDocument: "after" },
      );
      if (!reserved?.folder) throw new NewsroomCreationConflict("Creation is being resumed elsewhere. Retry the same request.");
      claimed.folder = reserved.folder;
    }
    await steps.provision(claimed.publication_id, claimed.folder);
    await ensurePublicationIndexes(db);
    return await publicationChangeTransaction(db, async (session) => {
      const account = await db.collection("journalist_admins").updateOne(
        { principalId: actor.id, enabled: true, role: { $in: ["owner", "admin"] } }, { $inc: { publicationCreationSequence: 1 } }, { session },
      );
      if (!account.matchedCount && currentActor.id !== "local-admin") throw new PublicationAccessDenied();
      const locked = await requests.updateOne(
        { _id: identity, token, complete: false }, { $set: { complete: true }, $unset: { token: "", lease_until: "" } }, { session },
      );
      if (!locked.modifiedCount) throw new NewsroomCreationConflict("Creation is being resumed elsewhere. Retry the same request.");
      if (await outputChannels(db).countDocuments({ owner_id: actor.id }, { session }) >= 100) {
        throw new NewsroomCreationInvalid("Newsroom limit reached. Contact a workspace administrator.");
      }
      const channel = await createOutputChannel(db, actor.id, claimed.publication_id, claimed.folder!.id, input, session);
      await appendPublicationChangeAudit(db, {
        publication_id: channel.id, principal_id: actor.id, principal_email: actor.email,
        action: "publication_created", resource_id: channel.id,
        detail: "Created newsroom with its initial allowed communities.",
        before_hash: null, after_hash: outputChannelConfigurationHash(channel),
      }, session);
      return channel;
    });
  } finally {
    await requests.updateOne({ _id: identity, token, complete: false }, { $unset: { token: "", lease_until: "" } });
  }
}
