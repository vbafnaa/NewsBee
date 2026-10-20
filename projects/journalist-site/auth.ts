import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { MongoClient } from "mongodb";
import { repositoryRoot } from "./pipeline/core/config";
import { loadSourceConfig, SOURCE_CONFIGS } from "./pipeline/storage/source-configs";

type MongoCache = typeof globalThis & {
  newsbeeMongo?: {
    uri: string;
    client: MongoClient;
    promise?: Promise<MongoClient>;
  };
};

export type AdminAccount = { email: string; enabled: boolean; createdAt?: Date };
export type OutputChannel = {
  id: string;
  name: string;
  url: string;
  driveFolderId: string;
  /** Locations whose editions this channel publishes. */
  selectedLocationIds: string[];
  enabled: boolean;
};
export type ConfiguredSource = {
  id: string;
  kind: "library" | "government" | "state-newsroom";
  category: string;
  name: string;
  location: string;
  region?: string;
  url?: string;
  platform?: string;
  tenant?: string;
};

type SourceConfigDocument = { _id: string; data: Record<string, unknown> };
type OutputChannelDocument = {
  _id: string;
  name: string;
  url: string;
  drive_folder_id: string;
  selected_location_ids?: string[];
  published_location_ids?: string[];
  enabled: boolean;
};
export type SourceConfigKind = "library" | "government" | "state-newsroom";
export type SourceConfigInput = {
  kind: SourceConfigKind;
  location?: string;
  region?: string;
  name: string;
  url?: string;
  platform?: string;
  tenant?: string;
};

export class SourceConfigError extends Error {
  constructor(message: string, readonly status: number = 400) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function secureUrl(value: unknown) {
  if (typeof value !== "string") return undefined;
  try {
    return new URL(value).protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

async function getMongoClient() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not configured");

  const cache = globalThis as MongoCache;
  if (!cache.newsbeeMongo || cache.newsbeeMongo.uri !== uri) {
    cache.newsbeeMongo = { uri, client: new MongoClient(uri) };
  }

  const mongo = cache.newsbeeMongo;
  if (!mongo.promise) {
    mongo.promise = mongo.client.connect().catch((error: unknown) => {
      mongo.promise = undefined;
      throw error;
    });
  }
  return mongo.promise;
}

export async function getMongoDatabase() {
  const databaseName = process.env.MONGODB_DATABASE;
  if (!databaseName) throw new Error("MONGODB_DATABASE is not configured");
  const client = await getMongoClient();
  return client.db(databaseName);
}

export async function isAdminEmail(email: string | null | undefined) {
  if (!email) return false;

  const databaseName = process.env.MONGODB_DATABASE;
  if (!databaseName) throw new Error("MONGODB_DATABASE is not configured");

  const client = await getMongoClient();
  const normalizedEmail = email.trim().toLowerCase();
  const account = await client
    .db(databaseName)
    .collection<{ email: string; enabled: boolean }>("journalist_admins")
    .findOne({ email: normalizedEmail, enabled: true }, { projection: { _id: 1 } });
  return account !== null;
}

async function adminAccountsCollection() {
  const databaseName = process.env.MONGODB_DATABASE;
  if (!databaseName) throw new Error("MONGODB_DATABASE is not configured");
  const client = await getMongoClient();
  return client.db(databaseName).collection<AdminAccount>("journalist_admins");
}

export async function listAdminAccounts() {
  const collection = await adminAccountsCollection();
  const accounts = await collection
    .find({}, { projection: { _id: 0, email: 1, enabled: 1 } })
    .sort({ email: 1 })
    .toArray();
  return accounts;
}

export async function enableAdminAccount(email: string) {
  const accounts = await adminAccountsCollection();
  await accounts.updateOne(
    { email },
    { $set: { email, enabled: true }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true },
  );
  return { email, enabled: true };
}

function outputChannelFromDocument(channel: OutputChannelDocument | null): OutputChannel {
  if (!channel || typeof channel._id !== "string" || typeof channel.name !== "string" ||
    typeof channel.url !== "string" || typeof channel.drive_folder_id !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(channel.drive_folder_id) || typeof channel.enabled !== "boolean") {
    throw new Error("The output channel configuration is malformed");
  }
  const selectedLocationIds = channel.selected_location_ids ?? [];
  if (!Array.isArray(selectedLocationIds) || selectedLocationIds.some((id) => typeof id !== "string")) {
    throw new Error("The output channel location selection is malformed");
  }
  return {
    id: channel._id,
    name: channel.name,
    url: channel.url,
    driveFolderId: channel.drive_folder_id,
    selectedLocationIds,
    enabled: channel.enabled,
  };
}

export async function getOutputChannel(channelId = "reader-site"): Promise<OutputChannel> {
  const database = await getMongoDatabase();
  const collection = database.collection<OutputChannelDocument>("output_channels");
  if (channelId === "reader-site") {
    await collection.updateOne(
      { _id: "reader-site" },
      {
        $setOnInsert: {
          name: "Newsbee reader site",
          url: process.env.NEWSBEE_READER_SITE_URL ?? "https://newsbee-reader-site.vercel.app",
          drive_folder_id: "1S2uePphOd_25yandeFtQJ6iZvSz2ydYw",
          enabled: true,
        },
      },
      { upsert: true },
    );
    await collection.updateOne(
      { _id: "reader-site", drive_folder_id: { $exists: false } },
      { $set: { drive_folder_id: "1S2uePphOd_25yandeFtQJ6iZvSz2ydYw" } },
    );
  }
  return outputChannelFromDocument(await collection.findOne({ _id: channelId }));
}

export async function listOutputChannels() {
  await getOutputChannel();
  const channels = await (await getMongoDatabase())
    .collection<OutputChannelDocument>("output_channels")
    .find({})
    .sort({ _id: 1 })
    .toArray();
  return channels.map(outputChannelFromDocument);
}

export async function createOutputChannel(channel: OutputChannel) {
  const database = await getMongoDatabase();
  await database.collection<OutputChannelDocument>("output_channels").insertOne({
    _id: channel.id,
    name: channel.name,
    url: channel.url,
    drive_folder_id: channel.driveFolderId,
    selected_location_ids: channel.selectedLocationIds,
    enabled: channel.enabled,
  });
  return channel;
}

export async function updateOutputChannel(
  channelId: string,
  channel: Omit<OutputChannel, "id" | "driveFolderId">,
) {
  const database = await getMongoDatabase();
  const collection = database.collection<OutputChannelDocument>("output_channels");
  await collection.updateOne(
    { _id: channelId },
    {
      $set: {
        name: channel.name,
        url: channel.url,
        selected_location_ids: channel.selectedLocationIds,
        enabled: channel.enabled,
      },
    },
  );
  return getOutputChannel(channelId);
}

async function seedSourceConfigs() {
  const database = await getMongoDatabase();
  for (const name of SOURCE_CONFIGS) await loadSourceConfig(database, repositoryRoot(), name);
}

export async function listConfiguredSources(): Promise<ConfiguredSource[]> {
  const databaseName = process.env.MONGODB_DATABASE;
  if (!databaseName) throw new Error("MONGODB_DATABASE is not configured");
  await seedSourceConfigs();

  const client = await getMongoClient();
  const configs = await client
    .db(databaseName)
    .collection<SourceConfigDocument>("source_configs")
    .find({}, { projection: { _id: 1, data: 1 } })
    .sort({ _id: 1 })
    .toArray();

  return configs.flatMap<ConfiguredSource>((config): ConfiguredSource[] => {
    if (!isRecord(config.data)) return [];

    if (config._id === "library-websites") {
      return Object.entries(config.data).flatMap(([location, value]) => {
        if (!isRecord(value)) return [];
        const name = typeof value.name === "string" ? value.name : location;
        const url = secureUrl(value.website);
        return [{ id: `library-${location}`, kind: "library", category: "Library", name, location, url }];
      });
    }

    if (config._id === "government-sources") {
      return Object.entries(config.data).flatMap(([location, value]) => {
        if (!isRecord(value)) return [];
        return [{
          id: `government-${location}`,
          kind: "government",
          category: "Government",
          name: location,
          location,
          platform: typeof value.platform === "string" ? value.platform : undefined,
          tenant: typeof value.tenant === "string" ? value.tenant : undefined,
        }];
      });
    }

    if (config._id === "state-sources") {
      return Object.entries(config.data).flatMap(([region, value]) => {
        if (!isRecord(value) || !Array.isArray(value.newsrooms)) return [];
        const regionName = typeof value.name === "string" ? value.name : region;
        return value.newsrooms.flatMap((newsroom, index) => {
          if (!isRecord(newsroom) || typeof newsroom.name !== "string") return [];
          const url = secureUrl(newsroom.feed);
          return [{
            id: `newsroom-${region}-${index}`,
            kind: "state-newsroom",
            category: "State newsroom",
            name: newsroom.name,
            location: `${regionName} (${region})`,
            region,
            url,
          }];
        });
      });
    }

    return [];
  });
}

function sourceConfigId(kind: SourceConfigKind) {
  return kind === "library" ? "library-websites" :
    kind === "government" ? "government-sources" : "state-sources";
}

function sourceConfigPath(kind: SourceConfigKind) {
  return kind === "library" ? "config/library-websites.json" :
    kind === "government" ? "config/government-sources.json" : "config/state-sources.json";
}

async function mutateSourceConfig(
  kind: SourceConfigKind,
  mutate: (data: Record<string, unknown>) => Record<string, unknown>,
) {
  const databaseName = process.env.MONGODB_DATABASE;
  if (!databaseName) throw new Error("MONGODB_DATABASE is not configured");
  const client = await getMongoClient();
  const collection = client.db(databaseName).collection<SourceConfigDocument>("source_configs");
  const configId = sourceConfigId(kind);
  await seedSourceConfigs();

  if (kind !== "state-newsroom") {
    await collection.updateOne(
      { _id: configId },
      { $setOnInsert: { config_path: sourceConfigPath(kind), data: {} } },
      { upsert: true },
    );
  }

  const current = await collection.findOne({ _id: configId }, { projection: { _id: 1, data: 1 } });
  if (!current || !isRecord(current.data)) {
    throw new SourceConfigError(`MongoDB source config ${configId} is missing or malformed`, 404);
  }
  const updated = mutate(current.data);
  const result = await collection.updateOne(
    { _id: configId, data: current.data },
    { $set: { data: updated } },
  );
  if (result.matchedCount !== 1) {
    throw new SourceConfigError("Source configuration changed concurrently; reload and try again.", 409);
  }
}

export async function createConfiguredSource(source: SourceConfigInput) {
  if (source.kind === "library") {
    const location = source.location!;
    await mutateSourceConfig(source.kind, (data) => {
      if (Object.prototype.hasOwnProperty.call(data, location)) {
        throw new SourceConfigError("A library source already exists for this identifier.", 409);
      }
      return { ...data, [location]: { name: source.name, website: source.url } };
    });
    return;
  }

  if (source.kind === "government") {
    const location = source.location!;
    await mutateSourceConfig(source.kind, (data) => {
      if (Object.prototype.hasOwnProperty.call(data, location)) {
        throw new SourceConfigError("A government source already exists for this location.", 409);
      }
      return { ...data, [location]: { platform: source.platform, tenant: source.tenant } };
    });
    return;
  }

  const region = source.region!;
  await mutateSourceConfig(source.kind, (data) => {
    const state = data[region];
    if (!isRecord(state) || !Array.isArray(state.newsrooms)) {
      throw new SourceConfigError(`State configuration ${region} does not exist or has no newsroom list.`, 404);
    }
    return {
      ...data,
      [region]: { ...state, newsrooms: [...state.newsrooms, { name: source.name, feed: source.url }] },
    };
  });
}

export async function updateConfiguredSource(id: string, source: SourceConfigInput) {
  const kind: SourceConfigKind = id.startsWith("library-") ? "library" :
    id.startsWith("government-") ? "government" : "state-newsroom";
  if (source.kind !== kind) throw new SourceConfigError("The source type cannot be changed.");

  if (kind === "library") {
    const location = id.slice("library-".length);
    await mutateSourceConfig(kind, (data) => {
      const current = data[location];
      if (!isRecord(current)) throw new SourceConfigError("Library source was not found.", 404);
      return { ...data, [location]: { ...current, name: source.name, website: source.url } };
    });
    return;
  }

  if (kind === "government") {
    const location = id.slice("government-".length);
    await mutateSourceConfig(kind, (data) => {
      const current = data[location];
      if (!isRecord(current)) throw new SourceConfigError("Government source was not found.", 404);
      return { ...data, [location]: { ...current, platform: source.platform, tenant: source.tenant } };
    });
    return;
  }

  const match = /^newsroom-(.+)-(\d+)$/.exec(id);
  if (!match) throw new SourceConfigError("Invalid state newsroom identifier.");
  const [, region, indexText] = match;
  const index = Number(indexText);
  await mutateSourceConfig(kind, (data) => {
    const state = data[region];
    if (!isRecord(state) || !Array.isArray(state.newsrooms) || !isRecord(state.newsrooms[index])) {
      throw new SourceConfigError("State newsroom source was not found.", 404);
    }
    const newsrooms = [...state.newsrooms];
    newsrooms[index] = { ...newsrooms[index], name: source.name, feed: source.url };
    return { ...data, [region]: { ...state, newsrooms } };
  });
}

export async function deleteConfiguredSource(id: string) {
  let retiredPrefix: string | undefined;
  if (id.startsWith("library-")) {
    const location = id.slice("library-".length);
    await mutateSourceConfig("library", (data) => {
      if (!Object.prototype.hasOwnProperty.call(data, location)) {
        throw new SourceConfigError("Library source was not found.", 404);
      }
      const updated = { ...data };
      delete updated[location];
      return updated;
    });
  } else if (id.startsWith("government-")) {
    const location = id.slice("government-".length);
    await mutateSourceConfig("government", (data) => {
      if (!Object.prototype.hasOwnProperty.call(data, location)) {
        throw new SourceConfigError("Government source was not found.", 404);
      }
      const updated = { ...data };
      delete updated[location];
      return updated;
    });
  } else {
    const match = /^newsroom-(.+)-(\d+)$/.exec(id);
    if (!match) throw new SourceConfigError("Invalid source identifier.");
    const [, region, indexText] = match;
    retiredPrefix = `newsroom-${region}-`;
    const index = Number(indexText);
    await mutateSourceConfig("state-newsroom", (data) => {
      const state = data[region];
      if (!isRecord(state) || !Array.isArray(state.newsrooms) || !isRecord(state.newsrooms[index])) {
        throw new SourceConfigError("State newsroom source was not found.", 404);
      }
      const newsrooms = [...state.newsrooms];
      newsrooms.splice(index, 1);
      return { ...data, [region]: { ...state, newsrooms } };
    });
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID ?? "",
      clientSecret: process.env.AUTH_GOOGLE_SECRET ?? "",
    }),
  ],
  pages: { signIn: "/login" },
  session: { strategy: "jwt" },
  callbacks: {
    async signIn({ user, profile }) {
      const email = (user.email ?? profile?.email)?.trim().toLowerCase();
      return Boolean(
        email &&
          profile?.email_verified === true &&
          (await isAdminEmail(email)),
      );
    },
  },
});
