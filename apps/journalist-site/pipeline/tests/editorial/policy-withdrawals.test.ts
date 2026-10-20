import { describe, expect, it } from "vitest";
import { errors, sourceErrors } from "../../editorial/policy";
import { withMongo } from "../support/mongo";
import { withdraw, restore, forLocation } from "../../editorial/withdrawals";
import { COLLECTIONS } from "../../storage/mongo";

describe("editorial publication policy", () => {
  it("holds sensitive, unsupported, context-free and non-HTTPS stories", () => {
    expect(errors({ title: "Budget meeting", description: "The council considers the budget.", kind: "meeting_preview" })).toEqual([]);
    expect(errors({ title: "Arrest hearing", description: "An arrest is discussed.", kind: "event" })).toContain("sensitive_requires_editor");
    expect(errors({ title: "Unknown", description: "ok", kind: "invented" })).toContain("unsupported_story_kind");
    expect(errors({ title: "Unknown", kind: "event" })).toContain("insufficient_source_context");
    expect(sourceErrors(["https://example.org/source"])).toEqual([]);
    expect(sourceErrors(["http://example.org/source"])).toEqual(["missing_source_link"]);
  });
});

describe("story withdrawals", () => {
  const mongo = withMongo();
  it("withdraws, lists and restores with immutable audit reason", async () => {
    const id = "edition-1";
    await mongo.db.collection(COLLECTIONS.editions).insertOne({ id, location_id: "town", status: "published" });
    await mongo.db.collection(COLLECTIONS.editionEntries).insertOne({ edition_id: id, disposition: "checks_passed", result: { story: { id: "story-1", occurrences: [{ source_id: "library:x", source_event_id: "evt-1" }] } } });
    await withdraw(mongo.db, id, "story-1", "The source corrected the details.");
    expect((await forLocation(mongo.db, "town"))["story-1"].source_refs).toEqual([["library:x", "evt-1"]]);
    await expect(withdraw(mongo.db, id, "story-1", "A different audit reason.")).rejects.toThrow("cannot be overwritten");
    await restore(mongo.db, "town", "story-1");
    expect(await forLocation(mongo.db, "town")).toEqual({});
  });
});
