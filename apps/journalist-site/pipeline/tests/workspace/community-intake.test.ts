import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { COMMUNITY_INTAKE_COLLECTION, validateCommunityIntake, type CommunityIntakeInput } from "../../../../../shared/community-intake";
import { listCommunityIntake, reviewCommunityIntake, saveCommunityIntake } from "../../../../reader-site/src/lib/community-intake-storage";

const contact = {
  submitter_name: "A Community Reader", submitter_email: "READER@example.test", consent: true,
  community_name: "New Town, WA", topic: "coverage", message: "Could you cover our community meeting next month?", website: "",
};
const application = { ...contact, intent: "start_branch", experience: "I organize neighborhood events and write local stories.", motivation: "I would like to build a reliable local publication for our neighborhood and help neighbors find useful information." };

describe("private community inquiry validation", () => {
  it("normalizes contact details, keeps the intent, and strips unrelated fields", () => {
    const checked = validateCommunityIntake("editor_interest", { ...application, status: "approved", role: "owner" });
    expect(checked).toMatchObject({ input: { kind: "editor_interest", submitter_email: "reader@example.test", intent: "start_branch", location_id: null } });
    expect("input" in checked && checked.input).not.toHaveProperty("role");
    expect("input" in checked && checked.input).not.toHaveProperty("status");
  });
  it("requires consent, valid contact details, a meaningful message and an empty spam field", () => {
    for (const invalid of [null, [], { ...contact, consent: false }, { ...contact, submitter_email: "reader\n@example.test" },
      { ...contact, website: "https://spam.test" }, { ...contact, message: "hello" }, { ...contact, message: "x".repeat(4001) },
      { ...contact, topic: "approve-me" }, { ...contact, location_id: "../../admin" }]) {
      expect(validateCommunityIntake("contact", invalid)).toHaveProperty("error");
    }
  });
  it("requires community, intent, experience and motivation for a branch application", () => {
    for (const invalid of [{ ...application, community_name: "" }, { ...application, intent: "owner" },
      { ...application, experience: "short" }, { ...application, motivation: "short" }]) {
      expect(validateCommunityIntake("editor_interest", invalid)).toHaveProperty("error");
    }
  });
});

let server: MongoMemoryServer, client: MongoClient, db: Db;
beforeAll(async () => { server = await MongoMemoryServer.create(); client = await MongoClient.connect(server.getUri()); db = client.db("community-intake"); });
beforeEach(async () => { await db.dropDatabase(); });
afterAll(async () => { await client?.close(); await server?.stop(); });
const input = (value = contact): CommunityIntakeInput => {
  const checked = validateCommunityIntake("contact", value);
  if ("error" in checked) throw new Error(checked.error);
  return checked.input;
};

describe("durable inquiry intake and review", () => {
  it("deduplicates retries into the same private receipt and records consent", async () => {
    const now = new Date("2026-11-12T12:00:00Z"), checked = input();
    const first = await saveCommunityIntake(db, checked, now), second = await saveCommunityIntake(db, checked, now);
    expect(second).toBe(first);
    expect(await db.collection(COMMUNITY_INTAKE_COLLECTION).countDocuments()).toBe(1);
    expect(await db.collection(COMMUNITY_INTAKE_COLLECTION).findOne({ _id: first as never })).toMatchObject({
      status: "pending", consent_version: "community-intake-v1", consented_at: now.toISOString(), submitter_email: "reader@example.test",
    });
  });
  it("enforces an email-wide hourly limit across both submission kinds", async () => {
    const now = new Date("2026-11-12T12:00:00Z");
    for (let i = 0; i < 5; i++) await saveCommunityIntake(db, input({ ...contact, message: `${contact.message} Inquiry ${i}.` }), now);
    const checked = validateCommunityIntake("editor_interest", application);
    if ("error" in checked) throw new Error(checked.error);
    await expect(saveCommunityIntake(db, checked.input, now)).rejects.toMatchObject({ status: 429 });
    await expect(saveCommunityIntake(db, checked.input, new Date("2026-11-12T13:00:00Z"))).resolves.toMatch(/^[a-f0-9-]{36}$/);
    expect(await db.collection("community_intake_limits").findOne()).toHaveProperty("expires_at");
  });
  it("filters and paginates private records, audits review, and never creates roles or communities", async () => {
    const checked = validateCommunityIntake("editor_interest", application);
    if ("error" in checked) throw new Error(checked.error);
    const id = await saveCommunityIntake(db, checked.input);
    const reviewed = await reviewCommunityIntake(db, id, "in_review", "Discuss community coverage.", "editor@example.test");
    expect(reviewed).toMatchObject({ status: "in_review", reviewed_by: "editor@example.test", review_history: [{ status: "in_review", note: "Discuss community coverage." }] });
    expect(reviewed).not.toHaveProperty("dedupe_key");
    await reviewCommunityIntake(db, id, "closed", "Contacted applicant.", "owner@example.test");
    expect((await listCommunityIntake(db, { kind: "editor_interest", status: "closed", page: 999 })).items).toHaveLength(1);
    expect((await listCommunityIntake(db, { status: "pending", page: 1 })).items).toHaveLength(0);
    expect((await listCommunityIntake(db, { status: "closed", page: 999 })).page).toBe(1);
    for (const collection of ["locations", "accounts", "journalist_admins"]) expect(await db.collection(collection).countDocuments()).toBe(0);
    await expect(reviewCommunityIntake(db, id, "approved" as never, "", "owner@example.test")).rejects.toMatchObject({ status: 422 });
  });
});
