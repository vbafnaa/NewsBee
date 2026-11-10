import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { MongoClient } from "mongodb";
import { disableAccount, normalizedEmail, ownerEmail, principalForEmail, type Account } from "./pipeline/accounts/identity";

declare module "next-auth/jwt" {
  interface JWT {
    youtubeRefreshToken?: string;
    youtubeAccountEmail?: string;
    youtubeScopes?: string[];
    googleDriveRefreshToken?: string;
    googleDriveAccountEmail?: string;
    googleDriveScopes?: string[];
  }
}

type MongoCache = typeof globalThis & {
  newsbeeMongo?: {
    uri: string;
    client: MongoClient;
    promise?: Promise<MongoClient>;
  };
};

export type AdminAccount = Account;
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

  return (await principalForEmail(await getMongoDatabase(), email)) !== null;
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
    .find({}, { projection: { _id: 0, email: 1, enabled: 1, role: 1 } })
    .sort({ email: 1 })
    .toArray();
  return accounts.map((account) => ({ ...account, role: account.email === ownerEmail() ? "owner" : "editor" }));
}

export async function enableAdminAccount(email: string) {
  email = normalizedEmail(email);
  const accounts = await adminAccountsCollection();
  await accounts.updateOne(
    { email },
    { $set: { email, enabled: true, role: email === ownerEmail() ? "owner" : "editor" }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true },
  );
  return { email, enabled: true };
}

export async function disableAdminAccount(email: string) {
  return disableAccount(await getMongoDatabase(), email);
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
    async jwt({ token, user, account }) {
      if (account?.provider === "google") {
        const accountEmail = (user?.email ?? token.email)?.trim().toLowerCase();
        const scopes = account.scope?.split(" ").filter(Boolean) ?? [];
        if (token.youtubeAccountEmail && token.youtubeAccountEmail !== accountEmail) {
          delete token.youtubeRefreshToken;
          delete token.youtubeAccountEmail;
          delete token.youtubeScopes;
        }
        if (token.googleDriveAccountEmail && token.googleDriveAccountEmail !== accountEmail) {
          delete token.googleDriveRefreshToken;
          delete token.googleDriveAccountEmail;
          delete token.googleDriveScopes;
        }
        if (accountEmail && scopes.includes("https://www.googleapis.com/auth/youtube")) {
          if (account.refresh_token) token.youtubeRefreshToken = account.refresh_token;
          token.youtubeAccountEmail = accountEmail;
          token.youtubeScopes = [...new Set([...(token.youtubeScopes ?? []), ...scopes])];
        }
        if (accountEmail && scopes.includes("https://www.googleapis.com/auth/drive")) {
          if (account.refresh_token) token.googleDriveRefreshToken = account.refresh_token;
          token.googleDriveAccountEmail = accountEmail;
          token.googleDriveScopes = [...new Set([...(token.googleDriveScopes ?? []), ...scopes])];
        }
      }
      return token;
    },
  },
});
