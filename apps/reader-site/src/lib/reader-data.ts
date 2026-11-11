import type { StorySource } from "../../../../shared/source-attribution";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MongoClient, type Db } from "mongodb";
import { communityName, matchingCommunities, onboardedCommunities, type Community } from "../../../../shared/community-directory";
import { GEOGRAPHIC_PLACES, stateCode, type GeographicPlace } from "../../../../shared/geography";
import { isMongoChannelFolderId, resolveReaderDriveFolderId, type ReaderChannel } from "../../../../shared/reader-folder";
import { uniquePhotoItems } from "../../../../shared/photo-identity";
import { photoStoryMismatch } from "../../../../shared/photo-story-match";
import { ARTIFACTS_COLLECTION, usesMongoArtifacts } from "../../../../shared/artifact-store";
import { searchGeography } from "../../../journalist-site/pipeline/communities/geocoder";
import { recordReaderSignup } from "./signup-storage";
import { normalizeStoryImage, type StoryImage } from "../../../../shared/story-image";

export type EditionItem = Omit<Partial<StoryImage>, "image" | "image_caption" | "image_credit"> & {
  story_id?: string | null;
  headline: string;
  blurb: string;
  when_where: string;
  event_date: string;
  source_url: string | null;
  sources?: StorySource[];
  rank?: number | null;
  kind?: "event" | "meeting_preview" | "meeting_outcome" | "state_news" | "earthquake" | "trending_topic" | "social_trend" | "safety_notice" | "housing_market" | "development" | "school_sports" | "game_result" | "home_sale" | "building_permit" | "weather_alert" | "court_case" | "local_news" | "business_opening" | "obituary" | "reader_story" | "safety_incident" | "news_report" | "public_record";
  source_name?: string;
  illustration_id?: string;
  illustration_asset_id?: string;
  illustration_policy?: string;
  section?: string | null;
  section_id?: string | null;
  local?: boolean;
  image?: string | null;
  image_caption?: string | null;
  image_credit?: string | null;
};

export type Edition = {
  media_mode?: "illustrated" | "photos" | "none";
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

/** Resolve the existing channel first, falling back only when it is absent. */
export async function readerFolderId() {
  const db = await readerDatabase();
  return resolveReaderDriveFolderId((id) => db.collection<ReaderChannel>("output_channels")
    .findOne({ _id: id }, { projection: { _id: 1, enabled: 1, drive_folder_id: 1 } }));
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
  url.searchParams.set("supportsAllDrives", "true");
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

export function parseEdition(value: unknown): Edition | null {
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
      !(typeof item.source_url === "string" || item.source_url === null) ||
      (item.sources !== undefined && (!Array.isArray(item.sources) || item.sources.some((source: unknown) => !isRecord(source) || typeof source.name !== "string" || typeof source.url !== "string")))) return null;
  }
  // Malformed optional media must never make a published edition unreadable.
  return {
    ...value,
    media_mode: ["illustrated", "photos", "none"].includes(String(value.media_mode)) ? value.media_mode : undefined,
    items: uniquePhotoItems(value.items.map((item) => {
      const { image, image_credit, image_source_url, image_alt, image_width, image_height,
        image_role, image_place, image_subject, image_caption, image_date, image_license, image_license_url, image_asset_id,
        image_catalog_id, image_catalog_revision, ...story } = item;
      const credited = typeof image_credit === "string" && Boolean(image_credit.trim());
      // The published payload owns image selection. A display fallback must not
      // replace a photo withheld by rights, quality or visual-review checks.
      const media = normalizeStoryImage({ ...item, image: credited ? image : null }, item);
      return { ...story, ...(media && !photoStoryMismatch(story, media) ? media : null) };
    })),
  } as Edition;
}

type FolderReader = { list(): Promise<DriveFile[]>; read(file: DriveFile): Promise<unknown> };

function driveFolder(folderId: string): FolderReader {
  return {
    async list() {
      const files: DriveFile[] = [];
      let pageToken: string | undefined;
      do {
        const url = new URL("https://www.googleapis.com/drive/v3/files");
        url.searchParams.set("q", `'${folderId.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}' in parents and trashed = false`);
        url.searchParams.set("pageSize", "1000");
        url.searchParams.set("fields", "nextPageToken,files(id,name,mimeType,modifiedTime)");
        url.searchParams.set("includeItemsFromAllDrives", "true");
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const page = await driveGet<{ files?: DriveFile[]; nextPageToken?: string }>(url);
        files.push(...(page.files ?? []));
        pageToken = page.nextPageToken;
      } while (pageToken);
      return files;
    },
    async read(file) {
      const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}`);
      url.searchParams.set("alt", "media");
      return driveGet<unknown>(url);
    },
  };
}

/** Local mode: the pipeline's local Drive stand-in; the reader folder is a sub-folder of it. */
export function localDriveRoot() {
  return process.env.NEWSBEE_LOCAL_DRIVE_DIR ?? resolve(process.cwd(), "..", "..", ".local", "stage2", "drive");
}

function localFolder(folderId: string): FolderReader {
  const folder = join(localDriveRoot(), folderId);
  return {
    async list() {
      try {
        const entries = await readdir(folder, { withFileTypes: true });
        return entries.filter((entry) => entry.isFile()).map((entry) => ({ id: entry.name, name: entry.name }));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    },
    async read(file) {
      return JSON.parse(await readFile(join(folder, file.id), "utf8"));
    },
  };
}

/** NEWSBEE_ARTIFACT_STORE=mongo: the reader folder is a namespace in the pipeline's artifacts collection. */
function mongoArtifactFolder(folderId: string): FolderReader {
  type ArtifactDoc = { _id: string; parent_id: string; name: string; folder: boolean; content?: string };
  const collection = async () => {
    const { client, databaseName } = await readerMongoClient();
    return client.db(databaseName).collection<ArtifactDoc>(ARTIFACTS_COLLECTION);
  };
  return {
    async list() {
      const docs = await (await collection())
        .find({ parent_id: folderId, folder: false }, { projection: { _id: 1, name: 1 } })
        .toArray();
      return docs.map((doc) => ({ id: doc._id, name: doc.name }));
    },
    async read(file) {
      const doc = await (await collection()).findOne({ _id: file.id, folder: false });
      if (typeof doc?.content !== "string") throw new Error(`Artifact ${file.name} was not found`);
      return JSON.parse(doc.content);
    },
  };
}

export function isLocalMode() {
  return (process.env.NEWSBEE_MODE ?? "local") !== "cloud";
}

function mongoFolder(folderId: string): FolderReader {
  return {
    async list() {
      const db = await readerDatabase();
      return db.collection<{ _id: string; folder_id: string; name: string; value: string }>("output_channel_files")
        .find({ folder_id: folderId }).project<{ _id: string; name: string }>({ _id: 1, name: 1 })
        .map((file) => ({ id: file._id, name: file.name })).toArray();
    },
    async read(file) {
      const db = await readerDatabase();
      const document = await db.collection<{ _id: string; folder_id: string; value: string }>("output_channel_files")
        .findOne({ _id: file.id, folder_id: folderId });
      if (!document) throw new Error(`MongoDB channel file ${file.name} was not found`);
      return JSON.parse(document.value) as unknown;
    },
  };
}

async function loadDriveData(folderId: string) {
  // A MongoDB publishing channel's folder first, then this repository's artifact store when it is on, then local or Drive.
  const folder = isMongoChannelFolderId(folderId) ? mongoFolder(folderId) : usesMongoArtifacts() ? mongoArtifactFolder(folderId) : isLocalMode() ? localFolder(folderId) : driveFolder(folderId);
  const files = await folder.list();

  const jsonFiles = files.filter((file) => file.name.endsWith(".json"));
  const directoryFile = jsonFiles.find((file) => file.name === "locations.json");
  if (!directoryFile) throw new Error("Reader folder must contain locations.json");

  const loadFile = (file: DriveFile) => folder.read(file);
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
  // Editions of removed locations stay archived in the folder but are not served.
  return { locations: locations as Location[], editions: editions.filter((edition) => ids.has(edition.location_id)) };
}

export async function readerData(folderId?: string) {
  const state = cache();
  const selectedFolderId = folderId ?? await readerFolderId();
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

export async function readerDatabase() {
  const { client, databaseName } = await readerMongoClient();
  return client.db(databaseName);
}

export async function discoverReaderCommunities(query: string, db?: Db): Promise<Location[]> {
  return (await searchGeography(db ?? await readerDatabase(), query))
    .map((place) => ({ id: place.id, name: place.label }));
}

type DirectoryPlace = { _id: string; name: string; name_lower: string; state: string };

async function readerCommunities(db: Db) {
  const locations = await db.collection<{ _id: string; id?: string; community?: Community }>("locations").find({ community: { $exists: true } }, { projection: { id: 1, community: 1 } }).toArray();
  return onboardedCommunities(locations);
}

/** Readers search Census places, onboarded communities and saved geographic communities. */
export async function searchTownDirectory(query: string, db?: Db): Promise<Location[]> {
  const [cityPart, statePart = ""] = query.split(",", 2);
  const city = cityPart.trim().toLowerCase();
  const state = stateCode(query.split(",").at(-1)?.trim() ?? "") ?? statePart.trim().toUpperCase();
  if (city.length < 2) return [];
  const database = db ?? await readerDatabase();
  const places = await database.collection<DirectoryPlace>("census_places").aggregate<DirectoryPlace>([
    { $match: { name_lower: { $regex: `^${city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` }, ...(state ? { state } : {}) } },
    { $addFields: { exact: { $cond: [{ $eq: ["$name_lower", city] }, 0, 1] } } },
    { $sort: { exact: 1, name_lower: 1, state: 1, _id: 1 } },
    { $limit: 10 },
    { $project: { _id: 1, name: 1, state: 1 } },
  ]).toArray();
  const communities = matchingCommunities(await readerCommunities(database), query).map(([id, community]) => ({ id, name: communityName(community) }));
  const geographic = await database.collection<GeographicPlace & { _id: string; name_lower: string }>(GEOGRAPHIC_PLACES).find({
    name_lower: { $regex: `^${city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` }, ...(state ? { state } : {}),
    ...(query.split(",").length > 2 ? { parent_name: { $regex: `^${query.split(",").slice(1, -1).join(",").trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } } : {}),
  }).limit(10).toArray();
  communities.push(...geographic.filter((place) => !communities.some((community) => community.id === place.id)).map((place) => ({ id: place.id, name: place.label })));
  const communityIds = new Set(communities.map((community) => community.id));
  return [...communities, ...places.map((place) => ({ id: place._id, name: `${place.name}, ${place.state}` }))]
    .sort((a, b) => Number(a.name.split(",")[0].toLowerCase() !== city) - Number(b.name.split(",")[0].toLowerCase() !== city)
      || Number(communityIds.has(b.id)) - Number(communityIds.has(a.id))
      || a.name.split(",")[0].localeCompare(b.name.split(",")[0]) || a.name.localeCompare(b.name)).slice(0, 10);
}

export async function directoryTown(id: string, db?: Db): Promise<Location | null> {
  const database = db ?? await readerDatabase();
  const geographic = await database.collection<GeographicPlace & { _id: string }>(GEOGRAPHIC_PLACES).findOne({ _id: id });
  if (geographic) return { id, name: geographic.label };
  const community = (await readerCommunities(database))[id];
  if (community) return { id, name: communityName(community) };
  const place = await database.collection<DirectoryPlace>("census_places").findOne({ _id: id });
  return place ? { id: place._id, name: `${place.name}, ${place.state}` } : null;
}

export async function saveInterestSignup(location: Location, email: string, launchNotification = false) {
  await recordReaderSignup(await readerDatabase(), location, email, launchNotification);
}

export async function saveRemembrance(location: Location, input: import("../../../../shared/remembrance").RemembranceInput) {
  const { REMEMBRANCE_COLLECTION } = await import("../../../../shared/remembrance");
  const { client, databaseName } = await readerMongoClient();
  const { randomUUID } = await import("node:crypto");
  const submission = { _id: randomUUID(), location_id: location.id, location_name: location.name, ...input, status: "pending" as const, submitted_at: new Date().toISOString() };
  await client.db(databaseName).collection(REMEMBRANCE_COLLECTION).insertOne(submission as never);
  return submission._id;
}

/** An editor-approved notice for its public page; pending and rejected notices are never shown. */
export async function approvedRemembrance(locationId: string, id: string) {
  const { REMEMBRANCE_COLLECTION } = await import("../../../../shared/remembrance");
  const { client, databaseName } = await readerMongoClient();
  const found = await client.db(databaseName).collection(REMEMBRANCE_COLLECTION).findOne({ _id: id as never, location_id: locationId, status: "approved" });
  return found ? { person_name: String(found.person_name), notice: String(found.notice), link: typeof found.link === "string" ? found.link : null } : null;
}

export async function saveReaderStory(location: Location, input: import("../../../../shared/reader-stories").ReaderStoryInput, image: import("../../../../shared/reader-stories").ReaderStoryImage | null = null) {
  const { READER_STORIES_COLLECTION } = await import("../../../../shared/reader-stories");
  const { client, databaseName } = await readerMongoClient();
  const { randomUUID } = await import("node:crypto");
  const story = { _id: randomUUID(), location_id: location.id, location_name: location.name, ...input, image, status: "pending" as const, submitted_at: new Date().toISOString() };
  await client.db(databaseName).collection(READER_STORIES_COLLECTION).insertOne(story as never);
  return story._id;
}

/** An editor-approved neighbour story for its public page; pending and rejected stories are never shown. */
export async function approvedReaderStory(locationId: string, id: string) {
  const { READER_STORIES_COLLECTION, creditLine } = await import("../../../../shared/reader-stories");
  const { client, databaseName } = await readerMongoClient();
  const found = await client.db(databaseName).collection(READER_STORIES_COLLECTION).findOne(
    { _id: id as never, location_id: locationId, status: "approved" }, { projection: { "image.data": 0 } },
  );
  if (!found) return null;
  return { headline: String(found.headline), story: String(found.story), link: typeof found.link === "string" ? found.link : null,
    image: found.image ? { caption: String(found.image.caption), credit: String(found.image.credit) } : null,
    event_date: typeof found.event_date === "string" ? found.event_date : null, credit: creditLine({ credit: found.credit === "name" ? "name" : "anonymous", submitter_name: String(found.submitter_name ?? "") }) };
}

export async function approvedStoryImage(locationId: string, id: string) {
  const { READER_STORIES_COLLECTION } = await import("../../../../shared/reader-stories");
  const db = await readerDatabase();
  const found = await db.collection<import("../../../../shared/reader-stories").ReaderStory>(READER_STORIES_COLLECTION)
    .findOne({ _id: id, location_id: locationId, status: "approved" }, { projection: { image: 1 } });
  return found?.image ?? null;
}

/** One anonymous engagement event (see api/engagement.ts); read by the pipeline's ranking. */
export async function saveEngagement(event: { location_id: string; edition_id: string; action: "view" | "open" | "share"; story_ids: string[] }) {
  const { client, databaseName } = await readerMongoClient();
  const at = new Date();
  await client.db(databaseName).collection("reader_engagement").insertOne({ ...event, at, day: at.toISOString().slice(0, 10) });
}

export const SUGGESTION_SECTIONS = ["events", "civic", "schools", "sports", "safety", "real_estate", "business", "obituaries", "community", "weather", "news"] as const;
export function validateSuggestion(input: unknown): { input: { name: string; url: string; section: string; why: string | null } } | { error: string } {
  if (!input || typeof input !== "object") return { error: "Send the source's name and link" };
  const value = input as Record<string, unknown>;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (name.length < 2 || name.length > 120) return { error: "Enter a name of 2-120 characters" };
  let url: URL;
  try { url = new URL(String(value.url ?? "").trim()); } catch { return { error: "Enter a valid link" }; }
  if (url.protocol !== "https:" || url.username || url.password) return { error: "Enter a public https:// link" };
  const section = SUGGESTION_SECTIONS.includes(value.section as never) ? String(value.section) : "community";
  const why = typeof value.why === "string" && value.why.trim() ? value.why.trim().slice(0, 300) : null;
  return { input: { name, url: url.toString(), section, why } };
}
export async function pendingSuggestions(locationId: string) {
  const { client, databaseName } = await readerMongoClient();
  return client.db(databaseName).collection("source_suggestions").countDocuments({ location_id: locationId, status: "pending" });
}
export async function saveSourceSuggestion(location: Location, input: { name: string; url: string; section: string; why: string | null }) {
  const { client, databaseName } = await readerMongoClient();
  const { randomUUID } = await import("node:crypto");
  await client.db(databaseName).collection("source_suggestions").insertOne({ _id: randomUUID(), location_id: location.id, location_name: location.name, ...input, status: "pending", submitted_at: new Date().toISOString() } as never);
}

export async function saveStoryReport(location: Location, input: { edition_id: string | null; story_id: string | null; headline: string | null; message: string }) {
  const { client, databaseName } = await readerMongoClient();
  const { randomUUID } = await import("node:crypto");
  await client.db(databaseName).collection("story_reports").insertOne({ _id: randomUUID(), location_id: location.id, ...input, status: "open", submitted_at: new Date().toISOString() } as never);
}
