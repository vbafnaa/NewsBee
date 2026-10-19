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
