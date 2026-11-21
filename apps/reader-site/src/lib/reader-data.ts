import type { StorySource } from "../../../../shared/source-attribution";
import { open, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MongoClient, type Db, type Filter } from "mongodb";
import { fencedDatabase } from "../../../../shared/restore-maintenance";
import { communityName, matchingCommunities, onboardedCommunities, type Community } from "../../../../shared/community-directory";
import { GEOGRAPHIC_PLACES, stateCode, type GeographicPlace } from "../../../../shared/geography";
import { isMongoChannelFolderId, ReaderChannelDisabledError, resolveReaderDriveFolderId, type ReaderChannel } from "../../../../shared/reader-folder";
import { uniquePhotoItems } from "../../../../shared/photo-identity";
import { photoStoryMismatch } from "../../../../shared/photo-story-match";
import { ARTIFACTS_COLLECTION, usesMongoArtifacts } from "../../../../shared/artifact-store";
import { searchGeography } from "../../../journalist-site/pipeline/communities/geocoder";
import { recordReaderSignup } from "./signup-storage";
import { normalizeStoryImage, safeImageUrl, safePublicHttpsUrl, type StoryImage } from "../../../../shared/story-image";
import type { SponsorSlot } from "../../../../shared/publication-settings";
import type { LocationPreparationState } from "../../../../shared/location-readiness";
import { locationReadinessForIds } from "../../../journalist-site/pipeline/communities/readiness";
import {
  parsePublicationManifest,
  parsePublicationRelease,
  publicationContentHash,
  type PublicationManifestV1,
  type PublicationReleaseItem,
  type PublicationReleaseManifestEntry,
  type PublicationReleasePayloadV1,
} from "../../../../shared/publication-release";
import {
  defaultPublicationSettings,
  type VersionedPublicationSetting,
  type PublicationProfileValues,
} from "../../../../shared/publication-settings";

export type EditionItem = Omit<Partial<StoryImage>, "image" | "image_caption" | "image_credit"> & {
  item_id?: string;
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
  origin?: "generated" | "original";
  source_references?: Array<{ location_id: string; edition_id: string; story_id: string }>;
  byline?: string;
  location_ids?: string[];
  location_names?: string[];
  reader_href?: string;
  image?: string | null;
  image_caption?: string | null;
  image_credit?: string | null;
};

export type Edition = {
  /** Internal browse/index metadata; never returned by the exact-edition API. */
  items_loaded?: false;
  publication_release?: boolean;
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
  sections?: Array<{ id: string; title: string }>;
  publication?: {
    id: string;
    schema_version: 1;
    revision: number;
    display_name: string;
    description: string | null;
    homepage_url: string | null;
    logo_url: string | null;
  };
  sponsor_placements?: {
    schema_version: 1;
    revision: number;
    placements: ReaderSponsorPlacement[];
  };
};

export type ReaderSponsorPlacement = {
  id: string;
  slot: SponsorSlot;
  sponsor_name: string;
  headline: string;
  body: string;
  landing_url: string;
  image_url: string | null;
};

export type Location = {
  id: string;
  name: string;
  branch_count?: number;
  system_count?: number;
  preparation_state?: LocationPreparationState;
};

export type ReaderPublicationSummary = {
  id: string;
  archived_at: number | null;
  display_name: string;
  description: string | null;
  logo_url: string | null;
  latest_release_id: string | null;
  latest_published_at: number | null;
  latest_title: string | null;
  latest_window_start: string | null;
  latest_window_end: string | null;
  locations: Array<{ id: string; name: string }>;
};

export type ReaderPublicationDirectorySummary = ReaderPublicationSummary & {
  latest_release_id: string;
  latest_published_at: number;
};

export type ReaderPublicationArchive = {
  summary: ReaderPublicationSummary;
  manifest: PublicationManifestV1;
};

export type ReaderPublicationBrowseRelease = {
  key: string;
  publication_id: string;
  publication_name: string;
  release_id: string;
  title: string;
  window_start: string;
  window_end: string;
  published_at: number;
  locations: Array<{ id: string; name: string }>;
  withdrawn: boolean;
  withdrawal_reason: string | null;
  latest: boolean;
  items: PublicationReleaseItem[] | null;
};

export type ReaderPublicationBrowseCatalog = {
  locations: Location[];
  releases: ReaderPublicationBrowseRelease[];
};

export type ReaderPublication = {
  summary: ReaderPublicationSummary;
  manifest: PublicationManifestV1;
  entry: PublicationReleaseManifestEntry;
  release: PublicationReleasePayloadV1;
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
    publicationManifests?: Map<string, PublicationManifestV1>;
    publicationReleases?: Map<string, PublicationReleasePayloadV1>;
    publicationManifestLoads?: Map<string, Promise<PublicationManifestV1>>;
    publicationReleaseLoads?: Map<string, Promise<PublicationReleasePayloadV1>>;
    artifactReads?: { active: number; waiting: Array<() => void> };
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
  global.newsbeeReaderData.publicationManifests ??= new Map();
  global.newsbeeReaderData.publicationReleases ??= new Map();
  global.newsbeeReaderData.publicationManifestLoads ??= new Map();
  global.newsbeeReaderData.publicationReleaseLoads ??= new Map();
  global.newsbeeReaderData.artifactReads ??= { active: 0, waiting: [] };
  return global.newsbeeReaderData;
}

const ARTIFACT_CONCURRENCY = 6;

async function boundedArtifactRead<T>(read: () => Promise<T>): Promise<T> {
  const reads = cache().artifactReads!;
  if (reads.active >= ARTIFACT_CONCURRENCY) await new Promise<void>((ready) => reads.waiting.push(ready));
  else reads.active += 1;
  try {
    return await read();
  } finally {
    const next = reads.waiting.shift();
    if (next) next();
    else reads.active -= 1;
  }
}

async function immutableArtifact<K, V>(
  values: Map<K, V>,
  pending: Map<K, Promise<V>>,
  key: K,
  read: () => Promise<V>,
): Promise<V> {
  const cached = values.get(key);
  if (cached) return cached;
  let promise = pending.get(key);
  if (!promise) {
    promise = boundedArtifactRead(read).then((value) => {
      values.set(key, value);
      boundMap(values);
      return value;
    }).finally(() => pending.delete(key));
    pending.set(key, promise);
  }
  return promise;
}

export async function readerMongoClient() {
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

function boundedText(value: unknown, maximum: number) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : null;
}

function parsePublication(value: unknown): Edition["publication"] | undefined {
  if (!isRecord(value)) return;
  const id = boundedText(value.id, 128);
  const displayName = boundedText(value.display_name, 120);
  const description = value.description === null ? null : boundedText(value.description, 500);
  if (!id
    || value.schema_version !== 1
    || !Number.isInteger(value.revision) || Number(value.revision) < 0
    || !displayName
    || value.description !== null && !description
  ) return;
  const homepage = value.homepage_url === null ? null : safePublicHttpsUrl(value.homepage_url);
  const logo = value.logo_url === null ? null : safeImageUrl(value.logo_url);
  if (value.homepage_url !== null && !homepage || value.logo_url !== null && !logo) return;
  return {
    id,
    schema_version: 1,
    revision: value.revision as number,
    display_name: displayName,
    description,
    homepage_url: homepage,
    logo_url: logo,
  };
}

function parseSponsorPlacements(value: unknown): Edition["sponsor_placements"] | undefined {
  if (!isRecord(value) || value.schema_version !== 1 || !Number.isInteger(value.revision) || Number(value.revision) < 0 || !Array.isArray(value.placements)) return;
  const slots = new Set<string>();
  const ids = new Set<string>();
  const placements = value.placements.flatMap((placement): ReaderSponsorPlacement[] => {
    if (!isRecord(placement)) return [];
    const sponsorName = boundedText(placement.sponsor_name, 120);
    const headline = boundedText(placement.headline, 160);
    const body = boundedText(placement.body, 500);
    if (typeof placement.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(placement.id) || ids.has(placement.id)
      || !["home_after_top_news", "home_before_newsroom"].includes(String(placement.slot))
      || slots.has(String(placement.slot))
      || !sponsorName
      || !headline
      || !body
      || placement.enabled !== true
    ) return [];
    const landing = safePublicHttpsUrl(placement.landing_url);
    const image = placement.image_url === null || placement.image_url === undefined ? null : safeImageUrl(placement.image_url);
    if (!landing || placement.image_url && !image) return [];
    ids.add(placement.id);
    slots.add(String(placement.slot));
    return [{
      id: placement.id,
      slot: placement.slot as SponsorSlot,
      sponsor_name: sponsorName,
      headline,
      body,
      landing_url: landing,
      image_url: image,
    }];
  });
  return { schema_version: 1, revision: value.revision as number, placements };
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
    publication: parsePublication(value.publication),
    sponsor_placements: parseSponsorPlacements(value.sponsor_placements),
  } as Edition;
}

const LEGACY_HEADER_LIMIT = 65_536;
type FolderReader = {
  list(): Promise<DriveFile[]>;
  read(file: DriveFile): Promise<unknown>;
  prefix(file: DriveFile): Promise<string>;
};

function legacyHeader(text: string): Edition | null {
  // Published legacy payloads put their scalar identity/window before items.
  // Only accept a real root-level key: JSON parsing rejects matches inside text.
  for (const match of text.matchAll(/"items"\s*:\s*\[/g)) {
    try {
      const edition = parseEdition(JSON.parse(`${text.slice(0, match.index)}"items":[]}`));
      if (edition) return { ...edition, items_loaded: false };
    } catch { /* An escaped string or nested key is not the edition items key. */ }
  }
  return null;
}

async function responsePrefix(response: Response) {
  if (!response.ok) throw new Error(`Google Drive request failed (${response.status})`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Google Drive returned an empty edition");
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (bytes < LEGACY_HEADER_LIMIT) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const remaining = LEGACY_HEADER_LIMIT - bytes;
      text += decoder.decode(chunk.value.subarray(0, remaining), { stream: true });
      bytes += chunk.value.byteLength;
      if (legacyHeader(text)) break;
    }
    return text;
  } finally {
    await reader.cancel();
  }
}

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
    async prefix(file) {
      const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}`);
      url.searchParams.set("alt", "media");
      url.searchParams.set("supportsAllDrives", "true");
      return responsePrefix(await fetch(url, {
        headers: { Authorization: `Bearer ${await serviceAccountToken()}`, Range: `bytes=0-${LEGACY_HEADER_LIMIT - 1}` },
        signal: AbortSignal.timeout(15_000),
      }));
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
    async prefix(file) {
      const handle = await open(join(folder, file.id), "r");
      const decoder = new TextDecoder();
      let text = "";
      try {
        const buffer = Buffer.alloc(1024);
        for (let offset = 0; offset < LEGACY_HEADER_LIMIT; offset += buffer.length) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
          if (!bytesRead) break;
          text += decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
          if (legacyHeader(text)) break;
        }
        return text;
      } finally {
        await handle.close();
      }
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
    async prefix(file) {
      // Only the start of the file, cut in the database, as for channel folders.
      const doc = await (await collection()).findOne<{ head?: string }>({ _id: file.id, folder: false }, { projection: { head: { $substrCP: ["$content", 0, LEGACY_HEADER_LIMIT] } } });
      if (typeof doc?.head !== "string") throw new Error(`Artifact ${file.name} was not found`);
      return doc.head;
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
    async prefix(file) {
      const db = await readerDatabase();
      const document = await db.collection<{ _id: string; value: string }>("output_channel_files").findOne(
        { _id: file.id, folder_id: folderId },
        { projection: { value: { $let: {
          vars: { header: { $regexFind: {
            input: { $substrCP: ["$value", 0, LEGACY_HEADER_LIMIT] },
            regex: '^[\\s\\S]*?"items"\\s*:\\s*\\[',
          } } },
          in: { $ifNull: ["$$header.match", ""] },
        } } } },
      );
      if (!document) throw new Error(`MongoDB channel file ${file.name} was not found`);
      return String(document.value);
    },
  };
}

export type ReaderDataSelection = {
  locationId?: string;
  editionId?: string | null;
  indexOnly?: boolean;
  catalog?: boolean;
};

async function loadDriveData(folderId: string, selection: ReaderDataSelection = {}) {
  // A MongoDB publishing channel's folder first, then this repository's artifact store when it is on, then local or Drive.
  const folder = isMongoChannelFolderId(folderId) ? mongoFolder(folderId) : usesMongoArtifacts() ? mongoArtifactFolder(folderId) : isLocalMode() ? localFolder(folderId) : driveFolder(folderId);
  const files = await folder.list();

  const jsonFiles = files.filter((file) => file.name.endsWith(".json"));
  const directoryFile = jsonFiles.find((file) => file.name === "locations.json");
  if (!directoryFile) throw new Error("Reader folder must contain locations.json");

  const loadFile = (file: DriveFile) => boundedArtifactRead(() => folder.read(file));
  const directoryData = await loadFile(directoryFile);
  if (!isRecord(directoryData) || !Array.isArray(directoryData.locations)) {
    throw new Error("locations.json must contain a locations array");
  }
  const locations = directoryData.locations.map(parseLocation);
  if (locations.some((location) => location === null)) {
    throw new Error("locations.json contains an invalid location");
  }

  const ids = new Set((locations as Location[]).map((location) => location.id));
  if (selection.locationId && !ids.has(selection.locationId)) return { locations: locations as Location[], editions: [] };
  let editionFiles = jsonFiles.filter((file) => file !== directoryFile);
  const readEdition = async (file: DriveFile) => {
    const edition = parseEdition(await loadFile(file));
    if (!edition) throw new Error(`Drive edition file ${file.name} does not match the edition contract`);
    return edition;
  };
  if (selection.editionId && !selection.catalog) {
    const exact = editionFiles.filter((file) => file.name === `${selection.editionId}.json`);
    if (exact.length) editionFiles = exact;
  }
  const targeted = selection.locationId || selection.editionId || selection.indexOnly;
  let editions: Edition[];
  if (targeted && !(selection.editionId && !selection.catalog && editionFiles.every((file) => file.name === `${selection.editionId}.json`))) {
    const indexed = await Promise.all(editionFiles.map(async (file) => {
      const header = legacyHeader(await boundedArtifactRead(() => folder.prefix(file)));
      // Older/reordered external JSON remains readable without a format migration.
      return { file, edition: header ?? await readEdition(file) };
    }));
    let selected = indexed.filter(({ edition }) => ids.has(edition.location_id)
      && (!selection.locationId || edition.location_id === selection.locationId)
      && (!selection.editionId || edition.id === selection.editionId));
    if (!selection.catalog && !selection.indexOnly) {
      selected = selected.sort((left, right) => right.edition.published_at - left.edition.published_at).slice(0, 1);
    }
    const loaded = new Map<string, Edition>();
    if (!selection.indexOnly) await Promise.all(selected.map(async ({ file, edition }) => {
      const full = edition.items_loaded === false ? await readEdition(file) : edition;
      // Recheck identity after the mutable legacy artifact is read.
      if (full.id !== edition.id || full.location_id !== edition.location_id) {
        throw new Error("Reader edition changed while its index was being read");
      }
      loaded.set(file.id, full);
    }));
    editions = selection.catalog || selection.indexOnly
      ? indexed.map(({ file, edition }) => loaded.get(file.id) ?? edition)
      : [...loaded.values()];
  } else {
    editions = await Promise.all(editionFiles.map(readEdition));
  }

  // Editions of removed locations stay archived in the folder but are not served.
  return { locations: locations as Location[], editions: editions.filter((edition) => ids.has(edition.location_id)
    && (selection.catalog || selection.indexOnly || !selection.locationId || edition.location_id === selection.locationId)
    && (selection.catalog || selection.indexOnly || !selection.editionId || edition.id === selection.editionId)) };
}

export async function readerData(folderId?: string, selection: ReaderDataSelection = {}) {
  const state = cache();
  const selectedFolderId = folderId ?? await readerFolderId();
  if (selection.locationId || selection.editionId || selection.indexOnly) return loadDriveData(selectedFolderId, selection);
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

/** Discovery combines independent publications with legacy content only when that channel is enabled. */
export async function legacyReaderDiscovery(selection: ReaderDataSelection = {}): Promise<{ locations: Location[]; editions: Edition[] }> {
  try {
    return await readerData(undefined, selection);
  } catch (error) {
    if (!(error instanceof ReaderChannelDisabledError)) throw error;
    return { locations: [], editions: [] };
  }
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
  return fencedDatabase(client.db(databaseName));
}

type ReaderPublicationDocument = {
  _id: string;
  name: string;
  enabled: boolean;
  archived_at?: number;
  archived_was_enabled?: boolean;
  destination?: "reader" | "video";
  destinations?: Array<{ type: "reader" | "video"; url: string }>;
  drive_folder_id: string;
  profile?: VersionedPublicationSetting<PublicationProfileValues>;
  reader_publication?: {
    manifest_file_id: string;
    manifest_revision: number;
    latest_release_id: string | null;
    latest_published_at: number | null;
    latest_title?: string | null;
    latest_window_start?: string | null;
    latest_window_end?: string | null;
    location_ids: string[];
    locations: Array<{ id: string; name: string }>;
    publication?: PublicationReleasePayloadV1["publication"] | null;
  };
};
type LoadedReaderPublicationArchive = ReaderPublicationArchive & {
  database: Db;
  document: ReaderPublicationDocument;
};

function readerDestination(document: ReaderPublicationDocument) {
  return document.destinations?.length
    ? document.destinations.some((destination) => destination.type === "reader")
    : (document.destination ?? "reader") === "reader";
}

const publicPublicationFilter: Filter<ReaderPublicationDocument> = {
  $or: [
    { enabled: true },
    { $expr: { $isNumber: "$archived_at" }, archived_was_enabled: true },
  ],
};

function publicPublication(document: ReaderPublicationDocument) {
  return document.enabled === true || (
    typeof document.archived_at === "number" && Number.isFinite(document.archived_at)
    && document.archived_was_enabled === true
  );
}

function publicationSummary(document: ReaderPublicationDocument): ReaderPublicationSummary | null {
  const pointer = document.reader_publication;
  if (!publicPublication(document) || !readerDestination(document) || !pointer) return null;
  const fallback = document.profile?.schema_version === 1
    ? document.profile.values
    : defaultPublicationSettings(document.name).profile.values;
  const profile = pointer.publication ?? {
    id: document._id,
    profile_revision: 0,
    ...fallback,
  };
  return {
    id: document._id,
    archived_at: typeof document.archived_at === "number" && Number.isFinite(document.archived_at)
      ? document.archived_at : null,
    display_name: profile.display_name,
    description: profile.description,
    logo_url: profile.logo_url,
    latest_release_id: pointer.latest_release_id,
    latest_published_at: pointer.latest_published_at,
    latest_title: pointer.latest_title ?? null,
    latest_window_start: pointer.latest_window_start ?? null,
    latest_window_end: pointer.latest_window_end ?? null,
    locations: pointer.locations,
  };
}

export async function publicationDirectory(
  locationId?: string,
  db?: Db,
): Promise<ReaderPublicationDirectorySummary[]> {
  const database = db ?? await readerDatabase();
  const rows = await database.collection<ReaderPublicationDocument>("output_channels").find({
    ...publicPublicationFilter,
    "reader_publication.latest_release_id": { $type: "string" },
    ...(locationId ? { "reader_publication.location_ids": locationId } : {}),
  }).sort({ "reader_publication.latest_published_at": -1, _id: 1 }).toArray();
  const value = rows.flatMap((row): ReaderPublicationDirectorySummary[] => {
    const summary = publicationSummary(row);
    return summary?.latest_release_id && summary.latest_published_at
      ? [{ ...summary, latest_release_id: summary.latest_release_id, latest_published_at: summary.latest_published_at }]
      : [];
  });
  return value;
}

function safeArtifactId(fileId: string) {
  const parts = fileId.split("/");
  if (!parts.length || parts.some((part) => !/^[A-Za-z0-9._:-]{1,240}$/.test(part) || part === "." || part === "..")) {
    throw new Error("Publication artifact id is invalid");
  }
  return parts;
}

async function readPublicationArtifact(folderId: string, fileId: string, db?: Db) {
  if (isMongoChannelFolderId(folderId)) {
    const database = db ?? await readerDatabase();
    const document = await database.collection<{ _id: string; folder_id: string; value: string }>("output_channel_files")
      .findOne({ _id: fileId, folder_id: folderId });
    if (!document) throw new Error("Publication artifact was not found");
    return JSON.parse(document.value) as unknown;
  }
  if (isLocalMode()) {
    return JSON.parse(await readFile(join(localDriveRoot(), ...safeArtifactId(fileId)), "utf8")) as unknown;
  }
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("alt", "media");
  return driveGet<unknown>(url);
}

function boundMap<K, V>(map: Map<K, V>, maximum = 100) {
  while (map.size > maximum) map.delete(map.keys().next().value!);
}

async function loadReaderPublicationArchive(
  publicationId: string,
  db?: Db,
): Promise<LoadedReaderPublicationArchive | null> {
  const database = db ?? await readerDatabase();
  const document = await database.collection<ReaderPublicationDocument>("output_channels").findOne({
    _id: publicationId,
    ...publicPublicationFilter,
    "reader_publication.manifest_file_id": { $type: "string" },
  });
  return document ? loadReaderPublicationArchiveRow(document, database) : null;
}

async function loadReaderPublicationArchiveRow(
  document: ReaderPublicationDocument,
  database: Db,
): Promise<LoadedReaderPublicationArchive | null> {
  const publicationId = document._id;
  const summary = document && publicationSummary(document);
  const pointer = document?.reader_publication;
  if (!document || !summary || !pointer || !readerDestination(document)) return null;
  const state = cache();
  const manifestKey = JSON.stringify([process.env.MONGODB_URI, database.databaseName, isLocalMode() ? localDriveRoot() : null, document.drive_folder_id,
    publicationId, pointer.manifest_file_id, pointer.manifest_revision]);
  const manifest = await immutableArtifact(state.publicationManifests!, state.publicationManifestLoads!, manifestKey, async () => {
    const parsed = parsePublicationManifest(await readPublicationArtifact(document.drive_folder_id, pointer.manifest_file_id, database));
    if (!parsed || parsed.publication.id !== publicationId || parsed.revision !== pointer.manifest_revision) {
      throw new Error("Publication manifest failed integrity validation");
    }
    return parsed;
  });
  const effectiveSummary = pointer.publication ? summary : {
    ...summary,
    display_name: manifest.publication.display_name,
    description: manifest.publication.description,
    logo_url: manifest.publication.logo_url,
  };
  return { summary: effectiveSummary, manifest, database, document };
}

export async function publicationArchive(publicationId: string, db?: Db): Promise<ReaderPublicationArchive | null> {
  const loaded = await loadReaderPublicationArchive(publicationId, db);
  return loaded ? { summary: loaded.summary, manifest: loaded.manifest } : null;
}

async function loadPublicationRelease(
  archive: LoadedReaderPublicationArchive,
  entry: PublicationReleaseManifestEntry,
) {
  const state = cache();
  const releaseKey = JSON.stringify([process.env.MONGODB_URI, archive.database.databaseName, isLocalMode() ? localDriveRoot() : null,
    archive.document.drive_folder_id, archive.summary.id, entry.release_id, entry.artifact_file_id, entry.content_hash]);
  return immutableArtifact(state.publicationReleases!, state.publicationReleaseLoads!, releaseKey, async () => {
    const parsed = parsePublicationRelease(await readPublicationArtifact(
      archive.document.drive_folder_id,
      entry.artifact_file_id,
      archive.database,
    ));
    if (!parsed || parsed.publication.id !== archive.summary.id || parsed.release_id !== entry.release_id
      || publicationContentHash(parsed) !== entry.content_hash) {
      throw new Error("Publication release failed integrity validation");
    }
    return parsed;
  });
}

export async function loadReaderPublication(publicationId: string, releaseId?: string | null, db?: Db): Promise<ReaderPublication | null> {
  const loaded = await loadReaderPublicationArchive(publicationId, db);
  if (!loaded) return null;
  const { summary, manifest } = loaded;
  const entry = releaseId
    ? manifest.archive.find((candidate) => candidate.release_id === releaseId)
    : manifest.latest;
  if (!entry) return null;
  const release = await loadPublicationRelease(loaded, entry);
  return { summary, manifest, entry, release };
}

export async function publicationBrowseCatalog(
  db?: Db,
  selection: { locationId?: string; editionId?: string } = {},
): Promise<ReaderPublicationBrowseCatalog> {
  const database = db ?? await readerDatabase();
  const rows = await database.collection<ReaderPublicationDocument>("output_channels").find({
    ...publicPublicationFilter,
    "reader_publication.manifest_file_id": { $type: "string" },
  }).sort({ "reader_publication.latest_published_at": -1, _id: 1 }).toArray();
  const locations = new Map<string, Location>();
  const releases = (await Promise.all(rows.flatMap(async (row) => {
    if (!readerDestination(row)) return [];
    const archive = await loadReaderPublicationArchiveRow(row, database);
    if (!archive) return [];
    const latestEntry = archive.manifest.latest;
    const latest = latestEntry && !latestEntry.withdrawn
      && (!selection.locationId || latestEntry.locations.some((location) => location.id === selection.locationId))
      && (!selection.editionId || selection.editionId === `publication:${row._id}:${latestEntry.release_id}`)
      ? await loadPublicationRelease(archive, latestEntry)
      : null;
    for (const entry of archive.manifest.archive) {
      if (!Number.isFinite(entry.published_at) || entry.published_at <= 0 || entry.published_at > Date.now() / 1000) continue;
      for (const location of entry.locations) locations.set(location.id, location);
    }
    return archive.manifest.archive
      .filter((entry) => !selection.locationId || entry.locations.some((location) => location.id === selection.locationId))
      .map((entry): ReaderPublicationBrowseRelease => ({
      key: `publication:${row._id}:${entry.release_id}`,
      publication_id: row._id,
      publication_name: archive.summary.display_name,
      release_id: entry.release_id,
      title: entry.title,
      window_start: entry.window_start,
      window_end: entry.window_end,
      published_at: entry.published_at,
      locations: entry.locations,
      withdrawn: entry.withdrawn,
      withdrawal_reason: entry.withdrawal_reason,
      latest: archive.manifest.latest?.release_id === entry.release_id,
      items: archive.manifest.latest?.release_id === entry.release_id ? latest?.items ?? null : null,
    }));
  }))).flat();
  return {
    locations: [...locations.values()].sort((left, right) => left.name.localeCompare(right.name)),
    releases,
  };
}

async function withReadiness(db: Db, locations: Location[]): Promise<Location[]> {
  const byId = new Map((await locationReadinessForIds(db, locations)).map((row) => [row.location_id, row.state]));
  return locations.map((location) => ({ ...location, preparation_state: byId.get(location.id) ?? "available" }));
}

export async function discoverReaderCommunities(query: string, db?: Db): Promise<Location[]> {
  const database = db ?? await readerDatabase();
  return withReadiness(database, (await searchGeography(database, query))
    .map((place) => ({ id: place.id, name: place.label })));
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
  const publishedLocations = new Map((await publicationDirectory(undefined, database))
    .flatMap((publication) => publication.locations).map((location) => [location.id, location]));
  for (const location of searchLocations([...publishedLocations.values()], query)) {
    if (!communities.some((community) => community.id === location.id)) communities.push(location);
  }
  const geographic = await database.collection<GeographicPlace & { _id: string; name_lower: string }>(GEOGRAPHIC_PLACES).find({
    name_lower: { $regex: `^${city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` }, ...(state ? { state } : {}),
    ...(query.split(",").length > 2 ? { parent_name: { $regex: `^${query.split(",").slice(1, -1).join(",").trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } } : {}),
  }).limit(10).toArray();
  communities.push(...geographic.filter((place) => !communities.some((community) => community.id === place.id)).map((place) => ({ id: place.id, name: place.label })));
  const communityIds = new Set(communities.map((community) => community.id));
  const results = [...communities, ...places.map((place) => ({ id: place._id, name: `${place.name}, ${place.state}` }))]
    .sort((a, b) => Number(a.name.split(",")[0].toLowerCase() !== city) - Number(b.name.split(",")[0].toLowerCase() !== city)
      || Number(communityIds.has(b.id)) - Number(communityIds.has(a.id))
      || a.name.split(",")[0].localeCompare(b.name.split(",")[0]) || a.name.localeCompare(b.name)).slice(0, 10);
  return withReadiness(database, results);
}

export async function directoryTown(id: string, db?: Db): Promise<Location | null> {
  const database = db ?? await readerDatabase();
  const geographic = await database.collection<GeographicPlace & { _id: string }>(GEOGRAPHIC_PLACES).findOne({ _id: id });
  if (geographic) return (await withReadiness(database, [{ id, name: geographic.label }]))[0];
  const community = (await readerCommunities(database))[id];
  if (community) return (await withReadiness(database, [{ id, name: communityName(community) }]))[0];
  const place = await database.collection<DirectoryPlace>("census_places").findOne({ _id: id });
  return place ? (await withReadiness(database, [{ id: place._id, name: `${place.name}, ${place.state}` }]))[0] : null;
}

export async function saveInterestSignup(location: Location, email: string, launchNotification = false) {
  await recordReaderSignup(await readerDatabase(), location, email, launchNotification);
}

export async function saveRemembrance(location: Location, input: import("../../../../shared/remembrance").RemembranceInput) {
  const { REMEMBRANCE_COLLECTION } = await import("../../../../shared/remembrance");
  const { client, databaseName } = await readerMongoClient();
  const { randomUUID } = await import("node:crypto");
  const submission = { _id: randomUUID(), location_id: location.id, location_name: location.name, ...input, status: "pending" as const, submitted_at: new Date().toISOString() };
  await (await fencedDatabase(client.db(databaseName))).collection(REMEMBRANCE_COLLECTION).insertOne(submission as never);
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
  await (await fencedDatabase(client.db(databaseName))).collection(READER_STORIES_COLLECTION).insertOne(story as never);
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
export async function saveEngagement(event: { location_id: string; edition_id: string; action: "view" | "open" | "share" | "edition_share"; story_ids: string[] }) {
  const { client, databaseName } = await readerMongoClient();
  const at = new Date();
  await (await fencedDatabase(client.db(databaseName))).collection("reader_engagement").insertOne({ ...event, at, day: at.toISOString().slice(0, 10) });
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
  await (await fencedDatabase(client.db(databaseName))).collection("source_suggestions").insertOne({ _id: randomUUID(), kind: "reader_source_suggestion", location_id: location.id, location_name: location.name, ...input, status: "pending", submitted_at: new Date().toISOString() } as never);
}

export async function saveStoryReport(location: Location, input: { edition_id: string | null; story_id: string | null; headline: string | null; message: string }) {
  const { client, databaseName } = await readerMongoClient();
  const { randomUUID } = await import("node:crypto");
  await (await fencedDatabase(client.db(databaseName))).collection("story_reports").insertOne({ _id: randomUUID(), location_id: location.id, ...input, status: "open", submitted_at: new Date().toISOString() } as never);
}
