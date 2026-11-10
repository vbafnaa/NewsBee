import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { MongoServerError, type Db } from "mongodb";
import type { Integrations, ProviderConfig } from "../core/config";
import { DEFAULT_LIGHT_MODEL, DEFAULT_MODEL_DAILY_CALLS, loadSettings } from "../core/config";
import { blockSponsoredRuns, isConfiguredOwner, principalById, type Principal } from "./identity";
import { ExecutionBlocked } from "../core/execution-errors";

export type PersonalConfig = {
  modelProviders: ProviderConfig[];
  tavilySearchApiKey: string | null;
  integrations: Integrations;
  lightModel: string;
  modelDailyCalls: number;
};
export type CredentialProfile = {
  userId: string; version: number; source: "personal" | "environment";
  config: PersonalConfig | null; revoked: boolean; automatic?: boolean;
};
export type CredentialInput = {
  source: "personal" | "environment";
  config?: Partial<Omit<PersonalConfig, "integrations" | "modelProviders">> & {
    modelProviders?: Array<Partial<ProviderConfig> & Pick<ProviderConfig, "name" | "kind">>;
    integrations?: Partial<Integrations>;
  };
};
type Stored = {
  _id: string; version: number; source: CredentialProfile["source"]; revoked: boolean;
  keyId?: string; iv?: string; tag?: string; ciphertext?: string;
};
export class CredentialValidationError extends Error {}
const invalid = (message: string): never => { throw new CredentialValidationError(message); };
const integrationKeys = ["serpapiKey", "searchapiKey", "brightdataKey", "brightdataZone", "brightdataUnlockerZone", "exaKey", "scrapingbeeKey", "typesafeKey", "openrouterKey", "attomKey", "jinaKey", "falKey"] as const;
export function emptyPersonalConfig(): PersonalConfig {
  const defaults = loadSettings({ NODE_ENV: process.env.NODE_ENV, NEWSBEE_MODE: "cloud" });
  return {
    modelProviders: [], tavilySearchApiKey: null, lightModel: DEFAULT_LIGHT_MODEL,
    modelDailyCalls: DEFAULT_MODEL_DAILY_CALLS,
    integrations: {
      serpapiKey: null, searchapiKey: null, brightdataKey: null, brightdataZone: null, brightdataUnlockerZone: null,
      exaKey: null, scrapingbeeKey: null, typesafeKey: null, openrouterKey: null,
      attomKey: null, jinaKey: null, falKey: null, typesafeBase: defaults.integrations.typesafeBase, jevModel: defaults.integrations.jevModel,
    },
  };
}
function keyFor(id: string): Buffer {
  let keys: Record<string, unknown>;
  try { keys = JSON.parse(process.env.NEWSBEE_CREDENTIAL_KEYS ?? "{}"); }
  catch { throw new Error("Credential encryption is not provisioned"); }
  const value = keys?.[id];
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error("Credential encryption key is unavailable");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("Credential encryption key is unavailable");
  return key;
}
const aad = (id: string, version: number) => Buffer.from(JSON.stringify(["newsbee-credentials", id, version]));
function decrypt(row: Stored): PersonalConfig | null {
  if (row.revoked || row.source === "environment") return null;
  const decipher = createDecipheriv("aes-256-gcm", keyFor(row.keyId!), Buffer.from(row.iv!, "base64"));
  decipher.setAAD(aad(row._id, row.version));
  decipher.setAuthTag(Buffer.from(row.tag!, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(row.ciphertext!, "base64")), decipher.final()]).toString("utf8"));
}
const project = (row: Stored): CredentialProfile => ({
  userId: row._id, version: row.version, source: row.source, config: decrypt(row), revoked: row.revoked,
});
export async function credentialProfile(db: Db, principal: Principal): Promise<CredentialProfile | null> {
  const row = await db.collection<Stored>("journalist_credentials").findOne({ _id: principal.id });
  if (!row) return null;
  if (row.source === "environment" && !isConfiguredOwner(principal)) return project({ ...row, revoked: true });
  return project(row);
}
export async function effectiveCredentialProfile(db: Db, principal: Principal): Promise<CredentialProfile | null> {
  const current = await principalById(db, principal.id);
  if (!current) throw new ExecutionBlocked("The sponsoring account is disabled. Further paid work is blocked.");
  const stored = await credentialProfile(db, current);
  if (stored) return stored;
  return isConfiguredOwner(current)
    ? { userId: current.id, version: 0, source: "environment", config: null, revoked: false, automatic: true }
    : null;
}
function text(value: unknown, fallback: string, label: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !value.trim() || value.length > 2000) return invalid(`Invalid ${label}`);
  return value.trim();
}
function secret(value: unknown, previous: string | null): string | null {
  if (value === undefined || value === "") return previous;
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 16000) return invalid("Invalid credential");
  return value.trim() || previous;
}
function url(value: unknown, fallback: string): string {
  const result = text(value, fallback, "base URL");
  try {
    const parsed = new URL(result);
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) return invalid("Base URL must be HTTP(S), without credentials or query");
  } catch { return invalid("Invalid base URL"); }
  return result;
}
function configFor(input: CredentialInput["config"], previous: PersonalConfig | null): PersonalConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid("Personal configuration is required");
  const result = structuredClone(previous ?? emptyPersonalConfig());
  result.lightModel = text(input.lightModel, result.lightModel, "light model");
  if (input.modelDailyCalls !== undefined) {
    if (!Number.isSafeInteger(input.modelDailyCalls) || input.modelDailyCalls < 0 || input.modelDailyCalls > 1000000) return invalid("Invalid model daily calls");
    result.modelDailyCalls = input.modelDailyCalls;
  }
  result.tavilySearchApiKey = secret(input.tavilySearchApiKey, result.tavilySearchApiKey);
  if (input.integrations !== undefined) {
    if (!input.integrations || typeof input.integrations !== "object" || Array.isArray(input.integrations)) return invalid("Invalid integrations");
    for (const key of integrationKeys) result.integrations[key] = secret(input.integrations[key], result.integrations[key]);
    result.integrations.typesafeBase = url(input.integrations.typesafeBase, result.integrations.typesafeBase);
    result.integrations.jevModel = text(input.integrations.jevModel, result.integrations.jevModel, "Jev model");
  }
  if (input.modelProviders !== undefined) {
    if (!Array.isArray(input.modelProviders) || input.modelProviders.length > 20) return invalid("Invalid model providers");
    const names = new Set<string>();
    result.modelProviders = input.modelProviders.map((p) => {
      if (!p || typeof p !== "object" || typeof p.name !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(p.name) || names.has(p.name)) return invalid("Provider names must be unique lowercase identifiers");
      names.add(p.name);
      if (!["ollama", "gemini", "openai"].includes(p.kind)) return invalid("Invalid provider kind");
      const old = result.modelProviders.find((value) => value.name === p.name && value.kind === p.kind);
      const temperature = p.temperature === undefined ? old ? old.temperature : 0 : p.temperature;
      if (temperature !== null && (typeof temperature !== "number" || !Number.isFinite(temperature) || temperature < 0 || temperature > 2)) return invalid("Invalid temperature");
      if (p.usage !== undefined && (!p.usage || typeof p.usage !== "object" || Array.isArray(p.usage))) return invalid("Invalid provider usage limits");
      const usage: ProviderConfig["usage"] = { inputCostPerMTok: null, outputCostPerMTok: null, requestsPerMinute: null, requestsPerDay: null };
      for (const key of Object.keys(usage) as Array<keyof typeof usage>) usage[key] = p.usage?.[key] === undefined ? old?.usage[key] ?? null : p.usage[key];
      for (const value of Object.values(usage)) if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) return invalid("Invalid provider usage limits");
      const maxTokensParam = p.maxTokensParam ?? old?.maxTokensParam ?? "max_tokens";
      const jsonMode = p.jsonMode ?? old?.jsonMode ?? "json_object";
      if (!["max_tokens", "max_completion_tokens"].includes(maxTokensParam) || !["json_object", "json_schema"].includes(jsonMode)) return invalid("Invalid provider options");
      const authHeader = p.authHeader === null ? null : p.authHeader === undefined ? old?.authHeader ?? null : text(p.authHeader, "", "auth header");
      if (authHeader && (!/^[A-Za-z0-9-]+$/.test(authHeader) || ["host", "cookie", "content-length"].includes(authHeader.toLowerCase()))) return invalid("Invalid auth header");
      if (p.vision !== undefined && typeof p.vision !== "boolean") return invalid("Invalid image-input capability");
      return {
        name: p.name, kind: p.kind, model: p.model === null ? null : text(p.model, old?.model ?? "", "model"),
        baseUrl: url(p.baseUrl, old?.baseUrl ?? (p.kind === "gemini" ? "https://generativelanguage.googleapis.com" : p.kind === "ollama" ? "http://127.0.0.1:11434" : "https://api.openai.com/v1")),
        apiKey: secret(p.apiKey, old?.apiKey ?? null), authHeader, maxTokensParam, temperature, jsonMode, usage,
        vision: p.vision ?? old?.vision,
        lightModel: p.lightModel === null ? null : p.lightModel === undefined ? old?.lightModel ?? null : text(p.lightModel, "", "light model") || null,
      };
    });
  }
  return result;
}
async function write(db: Db, principal: Principal, input: CredentialInput | null): Promise<CredentialProfile> {
  const collection = db.collection<Stored>("journalist_credentials");
  for (let attempt = 0; attempt < 20; attempt++) {
    const old = await collection.findOne({ _id: principal.id });
    const version = (old?.version ?? 0) + 1;
    const source = input?.source ?? old?.source ?? (isConfiguredOwner(principal) ? "environment" : "personal");
    if (input && source !== "personal" && source !== "environment") return invalid("Invalid credential source");
    if (input && source === "environment" && !isConfiguredOwner(principal)) return invalid("Only the owner configured by NEWSBEE_OWNER_EMAIL may choose deployment defaults");
    const config = input && source === "personal" ? configFor(input.config, old && !old.revoked ? decrypt(old) : null) : null;
    const row: Stored = { _id: principal.id, version, source, revoked: !input };
    if (config) {
      const keyId = process.env.NEWSBEE_CREDENTIAL_ACTIVE_KEY;
      if (!keyId) throw new Error("Credential encryption is not provisioned");
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", keyFor(keyId), iv);
      cipher.setAAD(aad(principal.id, version));
      row.keyId = keyId; row.iv = iv.toString("base64");
      row.ciphertext = Buffer.concat([cipher.update(JSON.stringify(config), "utf8"), cipher.final()]).toString("base64");
      row.tag = cipher.getAuthTag().toString("base64");
    }
    if (old) {
      if (!(await collection.replaceOne({ _id: principal.id, version: old.version }, row)).modifiedCount) continue;
    } else {
      try { await collection.insertOne(row); }
      catch (error) { if (error instanceof MongoServerError && error.code === 11000) continue; throw error; }
    }
    await blockSponsoredRuns(db, principal.id, input
      ? "The sponsor's API settings changed. Explicitly reconnect this run before continuing."
      : "The sponsor's API settings were revoked. Save credentials and explicitly reconnect this run before continuing.");
    return { userId: principal.id, version, source, config, revoked: !input };
  }
  throw new Error("Credential profile changed concurrently; retry");
}
export async function saveCredentialProfile(db: Db, principal: Principal, input: CredentialInput): Promise<CredentialProfile> {
  if (!input || typeof input !== "object") return invalid("Invalid credential profile");
  if (input.source !== "personal" && input.source !== "environment") return invalid("Choose an explicit credential source");
  return write(db, principal, input);
}
export async function revokeCredentialProfile(db: Db, principal: Principal): Promise<void> {
  await write(db, principal, null);
}
export function safeProfile(profile: CredentialProfile | null, resolvedConfig?: PersonalConfig) {
  if (!profile) return null;
  const config = profile.config;
  const capabilities = profile.revoked ? null : resolvedConfig ?? config;
  return {
    userId: profile.userId, version: profile.version, source: profile.source, revoked: profile.revoked, automatic: Boolean(profile.automatic),
    config: config ? {
      ...config,
      tavilySearchApiKey: config.tavilySearchApiKey ? "configured" : null,
      modelProviders: config.modelProviders.map((p) => ({ ...p, apiKey: p.apiKey ? "configured" : null })),
      integrations: Object.fromEntries(Object.entries(config.integrations).map(([key, value]) => [key, integrationKeys.includes(key as typeof integrationKeys[number]) ? value ? "configured" : null : value])),
    } : null,
    capabilities: {
      model: Boolean(capabilities?.modelProviders.some((p) => p.model && p.apiKey)),
      readyProviders: capabilities?.modelProviders.filter((p) => p.model && p.apiKey).map(({ name, kind, model }) => ({ name, kind, model })) ?? [],
      paidSearch: Boolean(capabilities && (capabilities.tavilySearchApiKey || capabilities.integrations.serpapiKey || capabilities.integrations.searchapiKey || capabilities.integrations.exaKey || (capabilities.integrations.brightdataKey && capabilities.integrations.brightdataZone))),
      integrations: capabilities ? integrationKeys.filter((key) => key !== "brightdataZone" && key !== "brightdataUnlockerZone" && capabilities.integrations[key]).map((key) => key.replace(/Key$/, "")) : [],
    },
  };
}
