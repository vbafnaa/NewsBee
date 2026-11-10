import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import type { HttpTransport } from "../core/http";
import type { Story } from "../editions/stories";
import { contextPlace } from "./places";
import { captureDate, categoryCommonsPhotos, namedCommonsPhotos, reviewAreaPhoto, reviewCommonsPhoto, reviewLicensedPhoto,
  searchCommonsPhotos, type CommonsPage, type PhotoCandidate } from "./commons";
import { normalizeStoryImage, safeImageUrl, type StoryImage } from "../../../../shared/story-image";
import { PHOTO_CATALOG_SOURCES, PHOTO_SUPPLY_SUBMISSIONS, photoGrantData, catalogSourceActive, isCalendarDate, type PhotoCatalogRecord,
  type PhotoCatalogReference, type PhotoCatalogSource, type PhotoScope } from "../../../../shared/photo-catalog";

const CACHE = "photo_catalog_cache";
const MAX_SOURCES = 100;
const MAX_MATCHED_SOURCES = 2;
const DAY_MS = 86400_000;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const words = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const contains = (value: string, phrase: string) => ` ${words(value)} `.includes(` ${words(phrase)} `);

function invalid(detail: string): never { throw new Error(`Invalid photo catalog: ${detail}`); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("expected an object");
  return value as Record<string, unknown>;
}
function string(value: unknown, max = 240): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) invalid("invalid text field");
  return value.trim();
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid("invalid list");
  return value;
}
function url(value: unknown): string {
  const result = safeImageUrl(value);
  if (!result) invalid("expected a public HTTPS URL");
  return result;
}
function date(value: unknown): string {
  if (!isCalendarDate(value)) invalid("expected a valid YYYY-MM-DD date");
  return value;
}

function parseScope(value: unknown): PhotoScope {
  const raw = object(value);
  if (!["event", "venue", "street", "person", "organization", "story"].includes(String(raw.kind))) invalid("unsupported scope");
  const kind = raw.kind as PhotoScope["kind"];
  const name = string(raw.name), city = string(raw.city, 120);
  if ((kind !== "organization" && words(name).split(" ").length < 2) || words(name) === words(city) || /^(downtown|park|library|community center|city hall)$/i.test(name))
    invalid("scope must identify a specific event, venue or street");
  const aliases = list(raw.aliases ?? [], 4).map(item => string(item));
  const source_urls = list(raw.source_urls ?? [], 8).map(url);
  const source_domains = list(raw.source_domains ?? [], 4).map(value => {
    const domain = string(value, 253).toLowerCase();
    if (new URL(url(`https://${domain}/`)).hostname !== domain) invalid("invalid source domain");
    return domain;
  });
  const entity = kind === "person" || kind === "organization";
  if (kind === "story" && !source_urls.length) invalid("story scope needs exact story URLs");
  if (entity && !source_urls.length && !source_domains.length) invalid("subject scope needs approved story URLs or exact source domains");
  if (kind === "person" && aliases.some(alias => words(alias).split(" ").length < 2)) invalid("person aliases require full names");
  return { kind, name, city, aliases, source_urls,
    ...(source_domains.length ? { source_domains } : {}),
    ...(entity ? { identity_url: url(raw.identity_url) } : {}),
    ...(kind === "event" ? { event_date: date(raw.event_date) } : {}) };
}

function parseSource(value: unknown, locationId: string, today: Date): PhotoCatalogSource {
  const raw = object(value), id = string(raw.id, 80);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) invalid("source ID must use lowercase letters, numbers, underscores or hyphens");
  if (raw.status !== "active" && raw.status !== "pending" && raw.status !== "revoked") invalid("unsupported source status");
  const reviewed = date(raw.reviewed_on), expires = date(raw.expires_on);
  if (reviewed > today.toISOString().slice(0, 10) || expires < reviewed) invalid("invalid review window");
  const common = { id, location_id: locationId, name: string(raw.name), status: raw.status as PhotoCatalogSource["status"],
    reviewed_on: reviewed, expires_on: expires, evidence_url: url(raw.evidence_url), scope: parseScope(raw.scope),
    ...(typeof raw.permission_record_id === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(raw.permission_record_id) ? { permission_record_id: raw.permission_record_id } : {}) };
  if (raw.permission_record_id !== undefined && !common.permission_record_id) invalid("invalid permission record");
  if (common.scope.kind === "story" && raw.kind !== "supplied") invalid("story-scoped photographs require an explicit supplied-photo grant");
  if (raw.kind === "commons_search") {
    if (common.scope.kind !== "person" && common.scope.kind !== "organization") invalid("Commons search requires a specific subject scope");
    return { ...common, kind: "commons_search" };
  }
  if (raw.kind === "commons_category") {
    const category = string(raw.category);
    if (!/^Category:[^|]{1,230}$/.test(category)) invalid("expected a Commons Category: title");
    return { ...common, kind: raw.kind, category };
  }
  if (raw.kind === "commons_files") {
    const files = list(raw.files, 12).map(item => string(item));
    if (!files.length || files.some(file => !/^File:[^|]{1,230}$/.test(file))) invalid("expected Commons File: titles");
    return { ...common, kind: raw.kind, files: [...new Set(files)] };
  }
  if (raw.kind !== "supplied") invalid("unsupported photo source kind");
  const grant = object(raw.permission);
  if ([grant.editorial, grant.archive, grant.crop].some(flag => typeof flag !== "boolean")) invalid("permission fields must be explicit booleans");
  const permission = { editorial: grant.editorial as boolean, archive: grant.archive as boolean, crop: grant.crop as boolean };
  if (raw.status === "active" && (!permission.editorial || !permission.archive || !permission.crop)) invalid("active supplied photos require editorial, archive and crop permission");
  const photos = list(raw.photos, 24).map((value): StoryImage => {
    const fields = object(value);
    const image = normalizeStoryImage({ ...fields, image_role: undefined });
    if (!image?.image_credit || !image.image_source_url || !image.image_caption || !image.image_alt
      || !isCalendarDate(image.image_date) || !image.image_license
      || !image.image_license_url && image.image_license !== "Used with permission") invalid("supplied photos need a credit, caption, alt text, capture date and rights evidence");
    if (image.image_width !== undefined && image.image_width < 1200 || image.image_height !== undefined && image.image_height < 600)
      invalid("supplied photo metadata is below editorial resolution");
    const role = fields.image_role;
    if (["person", "organization", "story"].includes(common.scope.kind) && role !== undefined) invalid("subject photographs cannot be tagged as venue or stock");
    if ((common.scope.kind === "venue" || common.scope.kind === "street") && role !== (common.scope.kind === "street" ? "area" : "venue")) invalid("context photo role does not match its scope");
    if (role !== undefined && role !== "area" && role !== "venue") invalid("catalog photos cannot bypass the stock stage");
    const { image_catalog_id: _catalogId, image_catalog_revision: _revision, image_asset_id: _asset, ...photo } = image;
    return { ...photo, ...(role ? { image_role: role } : {}) };
  });
  if (raw.status === "active" && !photos.length) invalid("active supplied source needs at least one photo");
  return { ...common, kind: raw.kind, photos, permission };
}

export function parsePhotoCatalog(value: unknown, locationId: string, today = new Date()): PhotoCatalogSource[] {
  const raw = object(value);
  if (raw.version !== 1 || raw.location_id !== locationId) invalid("manifest version or community does not match");
  const sources = list(raw.sources, 20).map(source => parseSource(source, locationId, today));
  if (new Set(sources.map(source => source.id)).size !== sources.length) invalid("duplicate source IDs");
  return sources;
}

export async function importPhotoCatalog(db: Db, manifest: unknown, locationId: string, apply = false, today = new Date()) {
  const sources = parsePhotoCatalog(manifest, locationId, today);
  const records = sources.map(source => ({ ...source, _id: digest([locationId, source.id]), revision: digest(source), updated_at: today.toISOString() }));
  for (const source of records) if (source.status === "active" && !await photoGrantActive(db, source)) invalid("the supplied-photo grant is missing, changed or withdrawn");
  const collection = db.collection<PhotoCatalogRecord>(PHOTO_CATALOG_SOURCES);
  const existing = await collection.countDocuments({ location_id: locationId, id: { $nin: records.map(record => record.id) } });
  if (existing + records.length > MAX_SOURCES) invalid("community source limit exceeded");
  if (apply && records.length) {
    await collection.createIndex({ location_id: 1, status: 1 });
    await collection.bulkWrite(records.map(record => ({ replaceOne: { filter: { _id: record._id }, replacement: record, upsert: true } })));
  }
  return { applied: apply, location_id: locationId, sources: records.map(({ id, status, kind, revision }) => ({ id, status, kind, revision })) };
}

export async function listPhotoCatalog(db: Db, locationId: string): Promise<PhotoCatalogRecord[]> {
  return db.collection<PhotoCatalogRecord>(PHOTO_CATALOG_SOURCES).find({ location_id: locationId }).sort({ _id: 1 }).limit(MAX_SOURCES).toArray();
}

export async function photoCatalogVersion(db: Db, locationId: string): Promise<string> {
  return digest((await listPhotoCatalog(db, locationId)).map(source => [source._id, source.revision]));
}

export function photoScopeMatches(scope: PhotoScope, story: Story, city: string): boolean {
  if (words(scope.city) !== words(city)) return false;
  const storyUrl = safeImageUrl(story.first.source_url);
  if (scope.source_urls.length || scope.source_domains?.length) {
    if (!storyUrl || !scope.source_urls.includes(storyUrl) && !scope.source_domains?.includes(new URL(storyUrl).hostname)) return false;
  }
  const names = [scope.name, ...scope.aliases];
  if (scope.kind === "story") return scope.source_urls.includes(storyUrl ?? "")
    && !["public_record", "safety_incident", "court_case", "home_sale", "housing_market", "obituary", "reader_story"].includes(story.kind) && !story.facts.link_only;
  if (scope.kind === "person" || scope.kind === "organization") {
    if (["public_record", "safety_incident", "court_case", "home_sale", "housing_market", "obituary", "reader_story"].includes(story.kind)
      || story.facts.link_only || !scope.identity_url) return false;
    return names.some(name => contains(story.title, name));
  }
  if (scope.kind === "event") return story.kind === "event" && story.first.event_date?.slice(0, 10) === scope.event_date
    && names.some(name => contains(story.title, name));
  const place = contextPlace(story);
  if (!place || place.role !== (scope.kind === "street" ? "area" : "venue")) return false;
  return names.some(name => place.queries.some(query => words(query) === words(name)));
}

async function sourcePages(db: Db, source: PhotoCatalogRecord, today: Date, transport: HttpTransport): Promise<CommonsPage[]> {
  const key = digest([source._id, source.revision, "commons_catalog_v2"]);
  const cache = db.collection<{ _id: string; location_id: string; pages: CommonsPage[]; expires_at: Date }>(CACHE);
  await cache.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
  const saved = await cache.findOne({ _id: key, expires_at: { $gt: today } });
  if (saved) return saved.pages;
  const pages = source.kind === "commons_category" ? await categoryCommonsPhotos(source.category, transport)
    : source.kind === "commons_files" ? await namedCommonsPhotos(source.files, transport)
      : source.kind === "commons_search" ? await searchCommonsPhotos(`"${words(source.scope.name)}" "${words(source.scope.city)}" filetype:bitmap -intitle:DPLA -intitle:MOHAI`, transport) : [];
  await cache.updateOne({ _id: key }, { $set: { location_id: source.location_id, pages, expires_at: new Date(today.getTime() + DAY_MS) } }, { upsert: true });
  return pages;
}

function reviewPage(page: CommonsPage, source: PhotoCatalogRecord, today: Date): PhotoCandidate {
  const scope = source.scope, names = [scope.name, ...scope.aliases];
  if (scope.kind === "person" || scope.kind === "organization") {
    const description = String(page.imageinfo?.[0]?.extmetadata?.ImageDescription?.value ?? "").replace(/<[^>]*>/g, " ");
    if (!names.some(name => contains(`${page.title} ${description}`, name)) || !contains(`${page.title} ${description}`, scope.city))
      return { title: page.title ?? "", accepted: false, reason: "catalog_subject_identity_mismatch" };
    return reviewLicensedPhoto(page, { role: "source", subject: scope.name, alt: `Photograph of ${scope.name}`,
      caption: `${scope.name}. Subject photograph; not a photograph of the reported event.` }, today);
  }
  if (scope.kind === "event") {
    const description = String(page.imageinfo?.[0]?.extmetadata?.ImageDescription?.value ?? "").replace(/<[^>]*>/g, " ");
    if (!names.some(name => contains(`${page.title} ${description}`, name)) || !contains(`${page.title} ${description}`, scope.city)
      || captureDate(page.imageinfo?.[0]?.extmetadata?.DateTimeOriginal?.value) !== scope.event_date)
      return { title: page.title ?? "", accepted: false, reason: "catalog_event_identity_or_date_mismatch" };
    return reviewLicensedPhoto(page, { role: "source", place: scope.name, alt: `Photograph from ${scope.name}`,
      caption: `${scope.name}, ${scope.city}, photographed ${scope.event_date}.` }, today);
  }
  const review = scope.kind === "street" ? reviewAreaPhoto : reviewCommonsPhoto;
  return names.map(name => review(page, name, scope.city, today)).find(candidate => candidate.accepted) ?? review(page, scope.name, scope.city, today);
}

export async function matchingCatalogSources(db: Db, locationId: string, story: Story, city: string, today: Date, commonsEnabled = true) {
  const matching = (await listPhotoCatalog(db, locationId)).filter(source => catalogSourceActive(source, today)
    && photoScopeMatches(source.scope, story, city) && (commonsEnabled || source.kind === "supplied"))
    .sort((a, b) => (b.scope.source_urls.includes(story.first.source_url) ? 1 : 0) - (a.scope.source_urls.includes(story.first.source_url) ? 1 : 0)
      || b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id));
  const checked = await Promise.all(matching.map(async source => ({ source, granted: await photoGrantActive(db, source) })));
  return checked.filter(item => item.granted).slice(0, MAX_MATCHED_SOURCES).map(item => item.source);
}

export async function photoGrantActive(db: Db, source: PhotoCatalogSource): Promise<boolean> {
  if (!source.permission_record_id) return true;
  const grant = await db.collection(PHOTO_SUPPLY_SUBMISSIONS).findOne({ _id: source.permission_record_id as never, location_id: source.location_id, status: "approved" });
  return Boolean(grant && grant.grant_fingerprint === digest(photoGrantData(source)));
}

export const photoGrantFingerprint = (source: PhotoCatalogSource) => digest(photoGrantData(source));

export async function discoverCatalogPhotos(db: Db, locationId: string, story: Story, city: string, today: Date, transport: HttpTransport,
  commonsEnabled = true): Promise<PhotoCandidate[]> {
  const sources = await matchingCatalogSources(db, locationId, story, city, today, commonsEnabled);
  const candidates: PhotoCandidate[] = [];
  for (const source of sources) {
    const reference = { id: source._id, revision: source.revision };
    try {
      const found: PhotoCandidate[] = source.kind === "supplied" ? source.photos.map(image => ({ title: image.image_alt ?? source.name,
        accepted: Boolean(image.image_date && isCalendarDate(image.image_date) && Date.parse(image.image_date) <= today.getTime()
          && today.getTime() - Date.parse(image.image_date) <= 365 * DAY_MS), reason: "supplied_photo_capture_date", image }))
        : (await sourcePages(db, source, today, transport)).map(page => reviewPage(page, source, today));
      const subject = [source.scope.name, ...source.scope.aliases].find(name => contains(story.title, name));
      const subjectScope = source.scope.kind === "person" || source.scope.kind === "organization";
      for (const candidate of found) candidates.push({ ...candidate, catalog: reference,
        ...(candidate.image ? { image: { ...candidate.image, ...(subjectScope ? { image_subject: subject } : {}), image_catalog_id: reference.id, image_catalog_revision: reference.revision } } : {}) });
    } catch (error) {
      candidates.push({ title: source.name, accepted: false, reason: `catalog_discovery_failed: ${error instanceof Error ? error.message : String(error)}`, catalog: reference });
    }
  }
  return [...new Map(candidates.map(candidate => [candidate.image?.image ?? `${candidate.title}:${candidate.reason}`, candidate])).values()];
}

/** A stored selection never outlives the permission revision or its exact story scope. */
export async function catalogPhotoApproved(db: Db, reference: PhotoCatalogReference, story: Story, locationId: string, city: string, today: Date): Promise<boolean> {
  const source = await db.collection<PhotoCatalogRecord>(PHOTO_CATALOG_SOURCES).findOne({ _id: reference.id, location_id: locationId, revision: reference.revision });
  return Boolean(source && catalogSourceActive(source, today) && photoScopeMatches(source.scope, story, city) && await photoGrantActive(db, source));
}
