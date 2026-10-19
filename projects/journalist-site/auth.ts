import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { MongoClient } from "mongodb";

type MongoCache = typeof globalThis & {
  newsbeeMongo?: {
    uri: string;
    client: MongoClient;
    promise?: Promise<MongoClient>;
  };
};

export type AdminAccount = { email: string; enabled: boolean; createdAt?: Date };
export type ConfiguredSource = {
  id: string;
  category: string;
  name: string;
  location: string;
  url?: string;
  platform?: string;
  tenant?: string;
};

type SourceConfigDocument = { _id: string; data: Record<string, unknown> };

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

export async function listConfiguredSources(): Promise<ConfiguredSource[]> {
  const databaseName = process.env.MONGODB_DATABASE;
  if (!databaseName) throw new Error("MONGODB_DATABASE is not configured");

  const client = await getMongoClient();
  const configs = await client
    .db(databaseName)
    .collection<SourceConfigDocument>("source_configs")
    .find({}, { projection: { _id: 1, data: 1 } })
    .sort({ _id: 1 })
    .toArray();

  return configs.flatMap((config) => {
    if (!isRecord(config.data)) return [];

    if (config._id === "library-websites") {
      return Object.entries(config.data).flatMap(([location, value]) => {
        if (!isRecord(value)) return [];
        const name = typeof value.name === "string" ? value.name : location;
        const url = secureUrl(value.website);
        return [{ id: `library-${location}`, category: "Library", name, location, url }];
      });
    }

    if (config._id === "government-sources") {
      return Object.entries(config.data).flatMap(([location, value]) => {
        if (!isRecord(value)) return [];
        return [{
          id: `government-${location}`,
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
            category: "State newsroom",
            name: newsroom.name,
            location: `${regionName} (${region})`,
            url,
          }];
        });
      });
    }

    return [];
  });
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
