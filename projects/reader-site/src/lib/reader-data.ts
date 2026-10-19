import { MongoClient } from "mongodb";

export type EditionItem = {
  story_id?: string | null;
  headline: string;
  blurb: string;
  when_where: string;
  event_date: string;
  source_url: string | null;
  rank?: number | null;
  kind?: string;
  source_name?: string;
  section?: string | null;
  local?: boolean;
};

export type Edition = {
  id: string;
  location_id: string;
  location_name: string;
  window_start: string;
  window_end: string;
  published_at: number;
  headline: string;
  intro: string;
  items: EditionItem[];
  coverage?: string[];
  corrections?: { story_id?: string; reason: string; created_at: number }[];
};

export type Location = {
  id: string;
  name: string;
  branch_count?: number;
  system_count?: number;
};

type DriveFile = { id: string; name: string; modifiedTime?: string };
type Cache = typeof globalThis & {
  newsbeeReaderData?: {
    accessToken?: { value: string; expiresAt: number };
    tokenPromise?: Promise<string>;
    data?: { folderId: string; expiresAt: number; locations: Location[]; editions: Edition[] };
    dataPromise?: {
      folderId: string;
      promise: Promise<{ locations: Location[]; editions: Edition[] }>;
    };
  };
  newsbeeReaderMongo?: {
    uri: string;
    client: MongoClient;
    promise?: Promise<MongoClient>;
    indexPromise?: Promise<string>;
  };
};

function cache() {
  const global = globalThis as Cache;
  global.newsbeeReaderData ??= {};
  return global.newsbeeReaderData;
}

async function readerMongoClient() {
  const uri = process.env.MONGODB_URI;
  const databaseName = process.env.MONGODB_DATABASE;
  if (!uri) throw new Error("MONGODB_URI is not configured");
  if (!databaseName) throw new Error("MONGODB_DATABASE is not configured");

  const global = globalThis as Cache;
  if (!global.newsbeeReaderMongo || global.newsbeeReaderMongo.uri !== uri) {
    global.newsbeeReaderMongo = { uri, client: new MongoClient(uri) };
  }
  const mongo = global.newsbeeReaderMongo;
  if (!mongo.promise) {
    mongo.promise = mongo.client.connect().catch((error: unknown) => {
      mongo.promise = undefined;
      throw error;
    });
  }
  return { client: await mongo.promise, databaseName, mongo };
}

export async function readerChannelSettings() {
  const { client, databaseName } = await readerMongoClient();
  const channelId = process.env.NEWSBEE_OUTPUT_CHANNEL_ID ?? "reader-site";
  const channel = await client.db(databaseName)
    .collection<{ _id: string; enabled: boolean; drive_folder_id: string }>("output_channels")
    .findOne({ _id: channelId }, { projection: { _id: 1, enabled: 1, drive_folder_id: 1 } });
  if (!channel) throw new Error(`Reader channel ${channelId} is missing from the output_channels collection`);
  if (typeof channel.enabled !== "boolean" ||
    typeof channel.drive_folder_id !== "string" ||
    !/^[A-Za-z0-9_-]{10,200}$/.test(channel.drive_folder_id)) {
    throw new Error("The reader output channel configuration is malformed");
  }
  return { enabled: channel.enabled, driveFolderId: channel.drive_folder_id };
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function encodeJson(value: unknown) {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function privateKeyBytes(pem: string) {
  const normalized = pem.replace(/\\n/g, "\n");
  const encoded = normalized.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const binary = atob(encoded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function serviceAccountToken() {
  const state = cache();
  if (state.accessToken && state.accessToken.expiresAt > Date.now() + 60_000) {
    return state.accessToken.value;
  }
  if (state.tokenPromise) return state.tokenPromise;

  state.tokenPromise = (async () => {
    const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    const pem = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
    if (!email || !pem) throw new Error("Google Drive service account is not configured");

    const now = Math.floor(Date.now() / 1000);
    const header = encodeJson({ alg: "RS256", typ: "JWT" });
    const claims = encodeJson({
      iss: email,
      scope: "https://www.googleapis.com/auth/drive.readonly",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    });
    const unsigned = `${header}.${claims}`;
    const key = await crypto.subtle.importKey(
      "pkcs8",
      privateKeyBytes(pem),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(unsigned),
    );
    const assertion = `${unsigned}.${base64Url(new Uint8Array(signature))}`;
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Google token request failed (${response.status})`);
    const token = await response.json() as { access_token: string; expires_in: number };
    state.accessToken = {
      value: token.access_token,
      expiresAt: Date.now() + token.expires_in * 1000,
    };
    return token.access_token;
  })().finally(() => {
    state.tokenPromise = undefined;
  });
  return state.tokenPromise;
}

async function driveGet<T>(url: URL): Promise<T> {
  const token = await serviceAccountToken();
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Google Drive request failed (${response.status})`);
  return response.json() as Promise<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLocation(value: unknown): Location | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") return null;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*-[a-z]{2}$/i.test(value.id) || !value.name.trim()) return null;
  return {
    id: value.id,
    name: value.name.trim(),
    ...(typeof value.branch_count === "number" ? { branch_count: value.branch_count } : {}),
    ...(typeof value.system_count === "number" ? { system_count: value.system_count } : {}),
  };
}

function parseEdition(value: unknown): Edition | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null;
  if (
    typeof value.id !== "string" ||
    typeof value.location_id !== "string" ||
    typeof value.location_name !== "string" ||
    typeof value.window_start !== "string" ||
    typeof value.window_end !== "string" ||
    typeof value.published_at !== "number" ||
    typeof value.headline !== "string" ||
    typeof value.intro !== "string"
  ) return null;
  for (const item of value.items) {
    if (!isRecord(item) || typeof item.headline !== "string" ||
      typeof item.blurb !== "string" || typeof item.when_where !== "string" ||
      typeof item.event_date !== "string" ||
      !(typeof item.source_url === "string" || item.source_url === null)) return null;
  }
  return value as Edition;
}

async function loadDriveData(folderId: string) {
  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set("q", `'${folderId.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}' in parents and trashed = false`);
    url.searchParams.set("pageSize", "1000");
    url.searchParams.set("fields", "nextPageToken,files(id,name,mimeType,modifiedTime)");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const page = await driveGet<{ files?: DriveFile[]; nextPageToken?: string }>(url);
    files.push(...(page.files ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);

  const jsonFiles = files.filter((file) => file.name.endsWith(".json"));
  const directoryFile = jsonFiles.find((file) => file.name === "locations.json");
  if (!directoryFile) throw new Error("Drive folder must contain locations.json");

  const loadFile = async (file: DriveFile) => {
    const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}`);
    url.searchParams.set("alt", "media");
    return driveGet<unknown>(url);
  };
  const directoryData = await loadFile(directoryFile);
  if (!isRecord(directoryData) || !Array.isArray(directoryData.locations)) {
    throw new Error("locations.json must contain a locations array");
  }
  const locations = directoryData.locations.map(parseLocation);
  if (locations.some((location) => location === null)) {
    throw new Error("locations.json contains an invalid location");
  }

  const editionFiles = jsonFiles.filter((file) => file !== directoryFile);
  const editions = await Promise.all(editionFiles.map(async (file) => {
    const edition = parseEdition(await loadFile(file));
    if (!edition) throw new Error(`Drive edition file ${file.name} does not match the edition contract`);
    return edition;
  }));

  const ids = new Set((locations as Location[]).map((location) => location.id));
  if (editions.some((edition) => !ids.has(edition.location_id))) {
    throw new Error("An edition references a location missing from locations.json");
  }
  return { locations: locations as Location[], editions };
}

export async function readerData(folderId?: string) {
  const state = cache();
  const selectedFolderId = folderId ?? (await readerChannelSettings()).driveFolderId;
  if (state.data?.folderId === selectedFolderId && state.data.expiresAt > Date.now()) {
    return state.data;
  }
  if (state.dataPromise?.folderId !== selectedFolderId) {
    const promise = loadDriveData(selectedFolderId).then((data) => {
      const cached = { ...data, folderId: selectedFolderId, expiresAt: Date.now() + 60_000 };
      if (state.dataPromise?.folderId === selectedFolderId) state.data = cached;
      return cached;
    }).finally(() => {
      if (state.dataPromise?.folderId === selectedFolderId) state.dataPromise = undefined;
    });
    state.dataPromise = { folderId: selectedFolderId, promise };
  }
  const pending = state.dataPromise;
  if (!pending) throw new Error("Reader data loading did not start");
  return pending.promise;
}

export function searchLocations(locations: Location[], query: string) {
  const [cityPart, statePart = ""] = query.split(",", 2);
  const city = cityPart.trim().toLocaleLowerCase();
  const state = statePart.trim().toLocaleLowerCase();
  if (city.length < 2) return [];
  return locations
    .filter((location) => {
      const [locationCity, locationState = ""] = location.name.split(",");
      return locationCity.trim().toLocaleLowerCase().startsWith(city) &&
        (!state || locationState.trim().toLocaleLowerCase() === state);
    })
    .sort((left, right) => {
      const leftExact = left.name.split(",")[0].trim().toLocaleLowerCase() === city ? 0 : 1;
      const rightExact = right.name.split(",")[0].trim().toLocaleLowerCase() === city ? 0 : 1;
      return leftExact - rightExact ||
        (right.branch_count ?? 0) - (left.branch_count ?? 0) ||
        left.name.localeCompare(right.name);
    })
    .slice(0, 10);
}

export async function saveInterestSignup(location: Location, email: string) {
  const { client, databaseName, mongo } = await readerMongoClient();
  const collection = client.db(databaseName).collection("reader_interest_signups");
  if (!mongo.indexPromise) {
    mongo.indexPromise = collection.createIndex(
      { location_id: 1, email: 1 },
      { unique: true, name: "location_email_unique" },
    ).catch((error: unknown) => {
      mongo.indexPromise = undefined;
      throw error;
    });
  }
  await mongo.indexPromise;
  await collection.updateOne(
    { location_id: location.id, email },
    { $setOnInsert: { location_id: location.id, location_name: location.name, email, created_at: new Date() } },
    { upsert: true },
  );
}
