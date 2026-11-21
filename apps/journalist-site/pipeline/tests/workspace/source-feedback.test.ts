import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import type { Principal } from "../../accounts/identity";
import {
  decideSuggestion,
  ensureSourceSuggestionIndexes,
  listPublicationSourceFeedback,
  listSuggestions,
  SourceSuggestionConflict,
  sourceSuggestions,
  submitPublicationSourceFeedback,
} from "../../connectors/manual-links";
import { statusFor } from "../../../lib/admin-error-status";
import { loadSettings } from "../../core/config";
import { inbox } from "../../orchestration/inbox";
import { createOutputChannel, resolveOutputChannel } from "../../orchestration/output-channels";
import { publicationAccessAuditIsIntact, type PublicationChangeAuditEvent } from "../../publications/audit";
import { PublicationAccessDenied } from "../../publications/permissions";
import { COLLECTIONS } from "../../storage/mongo";

const publicationId = "b".repeat(32);
const owner: Principal = { id: "publication-owner", email: "owner@example.test", role: "owner" };
const editor: Principal = { id: "publication-editor", email: "editor@example.test", role: "editor" };
let server: MongoMemoryReplSet;
let client: MongoClient;
let db: Db;

beforeAll(async () => {
  server = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  client = await MongoClient.connect(server.getUri());
  db = client.db("source-feedback");
});
beforeEach(async () => {
  await db.dropDatabase();
  await createOutputChannel(db, owner.id, publicationId, "folder", {
    name: "Independent Weekly",
    destinations: [{ type: "reader", url: "" }],
    enabled: true,
    selectedLocationIds: ["town-wa", "other-wa"],
  });
  await db.collection(COLLECTIONS.outputChannels).updateOne({ _id: publicationId }, {
    $set: { members: [{ principal_id: editor.id, role: "editor" }] },
  });
  await db.collection(COLLECTIONS.locations).insertOne({ _id: "town-wa", id: "town-wa", name: "Town, WA", state: "WA", systems: [] });
  await db.collection(COLLECTIONS.locations).insertOne({ _id: "other-wa", id: "other-wa", name: "Other, WA", state: "WA", systems: [] });
  await db.collection("source_map").insertOne({
    _id: "town-wa:web:source",
    location_id: "town-wa",
    source_id: "web:source",
    name: "Town records",
    url: "https://town.example/records",
    reader: "web",
    params: {},
    section: "civic",
    found_by: { method: "editor", detail: "Fixture" },
    inside_area: true,
    status: "active",
    health: {},
    score: 1,
    first_seen: "2026-11-01",
    last_seen: "2026-11-01",
  });
  await db.collection("source_map").insertOne({
    _id: "other-wa:web:source",
    location_id: "other-wa",
    source_id: "web:source",
    name: "Other records",
    url: "https://other.example/records",
    reader: "web",
    params: {},
    section: "civic",
    found_by: { method: "editor", detail: "Fixture" },
    inside_area: true,
    status: "active",
    health: {},
    score: 1,
    first_seen: "2026-11-01",
    last_seen: "2026-11-01",
  });
  await ensureSourceSuggestionIndexes(db, true);
});
afterAll(async () => { await client.close(); await server.stop(); });

describe("publication source feedback", () => {
  it("reuses source suggestions, suppresses exact duplicates, and records decisions without mutating sources", async () => {
    const context = (await resolveOutputChannel(db, editor.id, publicationId))!.context;
    const before = await db.collection("source_map").findOne({ _id: "town-wa:web:source" });
    const first = await submitPublicationSourceFeedback(db, context, editor, {
      location_id: "town-wa",
      source_id: "web:source",
      category: "stale",
      message: "The records page has not been updated this month.",
    });
    const duplicate = await submitPublicationSourceFeedback(db, context, editor, {
      location_id: "town-wa",
      source_id: "web:source",
      category: "stale",
      message: "The records page has not been updated this month.",
    });
    expect(duplicate._id).toBe(first._id);
    const sameSourceIdElsewhere = await submitPublicationSourceFeedback(db, context, editor, {
      location_id: "other-wa",
      source_id: "web:source",
      category: "stale",
      message: "The records page has not been updated this month.",
    });
    expect(sameSourceIdElsewhere._id).not.toBe(first._id);
    expect(await sourceSuggestions(db).countDocuments()).toBe(2);
    expect(await db.collection("source_map").findOne({ _id: "town-wa:web:source" })).toEqual(before);
    await expect(decideSuggestion(db, loadSettings({}), first._id, "approved", { ...editor, id: "unassigned-journalist" }))
      .rejects.toBeInstanceOf(PublicationAccessDenied);
    const decided = await decideSuggestion(db, loadSettings({}), first._id, "approved", editor);
    expect(decided).toMatchObject({ status: "approved", source_id: "web:source" });
    expect(await db.collection("source_map").findOne({ _id: "town-wa:web:source" })).toEqual(before);
    const audits = await db.collection<PublicationChangeAuditEvent>(COLLECTIONS.publicationAccessAudit).find({
      action: { $in: ["source_feedback_submitted", "source_feedback_decided"] },
    }).toArray();
    expect(audits).toHaveLength(3);
    expect(audits.every(publicationAccessAuditIsIntact)).toBe(true);
  });

  it("keeps legacy reader suggestions separate and exposes pending feedback in the existing inbox", async () => {
    await sourceSuggestions(db).insertOne({
      _id: "legacy",
      location_id: "town-wa",
      location_name: "Town, WA",
      name: "Legacy suggestion",
      url: "https://legacy.example/source",
      section: "news",
      why: null,
      status: "pending",
      submitted_at: "2026-11-01T00:00:00.000Z",
    });
    const context = (await resolveOutputChannel(db, editor.id, publicationId))!.context;
    await submitPublicationSourceFeedback(db, context, editor, {
      location_id: "town-wa",
      source_id: "web:source",
      category: "incorrect_details",
      message: "The agency name shown on this source is incorrect.",
    });
    expect(await listSuggestions(db)).toMatchObject([{ _id: "legacy" }]);
    expect(await listPublicationSourceFeedback(db, { publicationId })).toHaveLength(1);
    const review = await inbox(db, "town-wa", owner);
    expect(review.counts).toMatchObject({ suggestions: 1, source_feedback: 1 });
    expect(review.source_feedback[0]).toMatchObject({ publication_id: publicationId, source_name_snapshot: "Town records" });
    const adminReview = await inbox(db, "town-wa", {
      id: "team-admin",
      email: "admin@example.test",
      role: "admin",
    });
    expect(adminReview.counts.source_feedback).toBe(1);
    expect(await db.collection(COLLECTIONS.publicationAccessAudit).findOne({
      publication_id: publicationId,
      principal_id: "team-admin",
      action: "privileged_inspection",
    })).toMatchObject({ record_hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const indexes = await sourceSuggestions(db).indexes();
    expect(indexes.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "publication_feedback_review",
      "source_suggestions_location_review",
      "publication_feedback_submitter",
      "one_pending_publication_feedback",
    ]));
  });

  it("rolls back audit failures and maps stale feedback decisions to conflict", async () => {
    const context = (await resolveOutputChannel(db, editor.id, publicationId))!.context;
    await db.collection(COLLECTIONS.publicationAccessAudit).createIndex(
      { action: 1 },
      { unique: true, name: "fixture_unique_audit_action" },
    );
    await db.collection(COLLECTIONS.publicationAccessAudit).insertOne({
      _id: "submit-audit-blocker",
      action: "source_feedback_submitted",
    });
    await expect(submitPublicationSourceFeedback(db, context, editor, {
      location_id: "town-wa",
      source_id: "web:source",
      category: "stale",
      message: "This submission must roll back with its audit.",
    })).rejects.toMatchObject({ code: 11000 });
    expect(await sourceSuggestions(db).countDocuments({ kind: "publication_source_feedback" })).toBe(0);

    await db.collection(COLLECTIONS.publicationAccessAudit).dropIndex("fixture_unique_audit_action");
    await db.collection(COLLECTIONS.publicationAccessAudit).deleteOne({ _id: "submit-audit-blocker" });
    const feedback = await submitPublicationSourceFeedback(db, context, editor, {
      location_id: "town-wa",
      source_id: "web:source",
      category: "stale",
      message: "This decision must remain pending if its audit fails.",
    });
    await db.collection(COLLECTIONS.publicationAccessAudit).createIndex(
      { action: 1 },
      { unique: true, name: "fixture_unique_audit_action" },
    );
    await db.collection(COLLECTIONS.publicationAccessAudit).insertOne({
      _id: "decision-audit-blocker",
      action: "source_feedback_decided",
    });
    await expect(decideSuggestion(db, loadSettings({}), feedback._id, "approved", owner))
      .rejects.toMatchObject({ code: 11000 });
    expect(await sourceSuggestions(db).findOne({ _id: feedback._id })).toMatchObject({ status: "pending" });

    await db.collection(COLLECTIONS.publicationAccessAudit).dropIndex("fixture_unique_audit_action");
    await db.collection(COLLECTIONS.publicationAccessAudit).deleteOne({ _id: "decision-audit-blocker" });
    await expect(decideSuggestion(db, loadSettings({}), feedback._id, "approved", owner))
      .resolves.toMatchObject({ status: "approved" });
    const conflict = new SourceSuggestionConflict("Source feedback was already reviewed");
    expect(statusFor(conflict)).toBe(409);
    await expect(decideSuggestion(db, loadSettings({}), feedback._id, "rejected", owner))
      .rejects.toBeInstanceOf(SourceSuggestionConflict);
  });
});
