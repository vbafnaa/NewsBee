import NextAuth, { type DefaultSession } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { saveDriveConsent } from "./pipeline/storage/drive-consent";
import { MongoClient } from "mongodb";
import { principalForEmail, type Account } from "./pipeline/accounts/identity";
import { PasswordAuthError, verifyPasswordLogin } from "./pipeline/accounts/password-auth";
import { fencedDatabase, maintenanceState } from "../../shared/restore-maintenance";
import { loginDestination } from "./lib/login-destination";

declare module "next-auth" {
  interface User {
    newsbeePrincipalId?: string;
    newsbeeSessionVersion?: number;
    newsbeeRestoreGeneration?: string;
  }
  interface Session {
    user: DefaultSession["user"] & { newsbeePrincipalId?: string; newsbeeSessionVersion?: number; newsbeeRestoreGeneration?: string };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    newsbeePrincipalId?: string;
    newsbeeSessionVersion?: number;
    newsbeeRestoreGeneration?: string;
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
  return fencedDatabase(client.db(databaseName));
}

export async function isAdminEmail(email: string | null | undefined) {
  if (!email) return false;

  return (await principalForEmail(await getMongoDatabase(), email)) !== null;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID ?? "",
      clientSecret: process.env.AUTH_GOOGLE_SECRET ?? "",
    }),
    Credentials({
      name: "Username and password",
      credentials: {
        username: { label: "Username", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials, request) {
        if (typeof credentials.username !== "string" || typeof credentials.password !== "string") return null;
        try {
          const principal = await verifyPasswordLogin(
            await getMongoDatabase(),
            credentials.username,
            credentials.password,
            request,
          );
          return { id: principal.id, email: principal.email, newsbeeSessionVersion: principal.sessionVersion, newsbeeRestoreGeneration: principal.restoreGeneration };
        } catch (error) {
          if (error instanceof PasswordAuthError && error.status !== 429) return null;
          throw error;
        }
      },
    }),
  ],
  pages: { signIn: "/login" },
  session: { strategy: "jwt" },
  callbacks: {
    async redirect({ url, baseUrl }) {
      if (url === "/login" || url === new URL("/login", baseUrl).href) return new URL("/login", baseUrl).href;
      return new URL(loginDestination(url, baseUrl), baseUrl).href;
    },
    async signIn({ user, profile, account }) {
      const verifiedVersion = user.newsbeeSessionVersion;
      const verifiedGeneration = user.newsbeeRestoreGeneration;
      delete user.newsbeePrincipalId;
      delete user.newsbeeSessionVersion;
      delete user.newsbeeRestoreGeneration;
      const email = (user.email ?? profile?.email)?.trim().toLowerCase();
      if (!email || (account?.provider !== "credentials" && profile?.email_verified !== true)) return false;
      const db = await getMongoDatabase();
      const authority = await maintenanceState(db);
      if (authority.phase !== "open") {
        if (account?.provider !== "google" || email !== process.env.NEWSBEE_OWNER_EMAIL?.trim().toLowerCase()
          || authority.owner?.email !== email) return false;
        user.newsbeePrincipalId = authority.owner.id;
        user.newsbeeSessionVersion = 0;
        user.newsbeeRestoreGeneration = authority.identityGeneration;
        return true;
      }
      const principal = await principalForEmail(db, email);
      if (!principal || (account?.provider === "credentials" && principal.id !== user.id)) return false;
      const stored = await db.collection<Account>("journalist_admins").findOne({ principalId: principal.id, enabled: true });
      if (!stored || (account?.provider === "credentials" && (verifiedVersion !== (stored.sessionVersion ?? 0)
        || verifiedGeneration !== authority.identityGeneration))) return false;
      user.newsbeePrincipalId = principal.id;
      user.newsbeeSessionVersion = stored.sessionVersion ?? 0;
      user.newsbeeRestoreGeneration = authority.identityGeneration;
      return true;
    },
    async jwt({ token, user, account }) {
      // Only a fresh, admitted sign-in may bind a principal. Legacy JWTs must sign in again.
      if (account && user) {
        delete token.newsbeePrincipalId;
        delete token.newsbeeSessionVersion;
        delete token.newsbeeRestoreGeneration;
        if (user.newsbeePrincipalId) token.newsbeePrincipalId = user.newsbeePrincipalId;
        if (user.newsbeePrincipalId) token.newsbeeSessionVersion = user.newsbeeSessionVersion;
        if (user.newsbeePrincipalId) token.newsbeeRestoreGeneration = user.newsbeeRestoreGeneration;
      }
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
          if (account.refresh_token && (await maintenanceState(await getMongoDatabase())).phase === "open") {
            await saveDriveConsent(await getMongoDatabase(), accountEmail, account.refresh_token);
            token.googleDriveRefreshToken = account.refresh_token;
          }
          token.googleDriveAccountEmail = accountEmail;
          token.googleDriveScopes = [...new Set([...(token.googleDriveScopes ?? []), ...scopes])];
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (typeof token.newsbeePrincipalId === "string" && token.newsbeePrincipalId) {
        session.user.newsbeePrincipalId = token.newsbeePrincipalId;
        session.user.newsbeeSessionVersion = token.newsbeeSessionVersion;
        session.user.newsbeeRestoreGeneration = token.newsbeeRestoreGeneration;
      } else {
        delete session.user.newsbeePrincipalId;
        delete session.user.newsbeeSessionVersion;
        delete session.user.newsbeeRestoreGeneration;
      }
      return session;
    },
  },
});
