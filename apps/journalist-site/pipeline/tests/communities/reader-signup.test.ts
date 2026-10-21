import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { POST } from "../../../../reader-site/src/pages/api/locations/[location_id]/interest";
import { withMongo } from "../support/mongo";

const mongo = withMongo();
const origin = "https://newsbee.example";

beforeEach(() => {
  vi.stubEnv("MONGODB_URI", "mongodb://reader-signup-test");
  vi.stubEnv("MONGODB_DATABASE", mongo.db.databaseName);
  const client = { connect: vi.fn(), db: () => mongo.db };
  client.connect.mockResolvedValue(client);
  vi.stubGlobal("newsbeeReaderMongo", { uri: process.env.MONGODB_URI, client });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function signup(body: unknown, locationId = "ballard-seattle-wa", requestOrigin = origin) {
  return POST({
    params: { location_id: locationId },
    request: new Request(`${origin}/reader/api/locations/${locationId}/interest`, {
      method: "POST",
      headers: { origin: requestOrigin, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    url: new URL(origin),
  } as Parameters<typeof POST>[0]);
}

it.each([undefined, false, "true", 1])("rejects signup without explicit consent (%s)", async (consent) => {
  expect((await signup({ email: "reader@example.com", consent })).status).toBe(422);
  expect(await mongo.db.collection("reader_interest_signups").countDocuments()).toBe(0);
});

it("persists normalized email, location and consent idempotently before and after publication", async () => {
  const body = { email: " Reader@Example.com ", consent: true };
  expect((await signup(body)).status).toBe(200);
  const collection = mongo.db.collection("reader_interest_signups");
  const initial = await collection.findOne({ email: "reader@example.com" });
  expect(initial).toMatchObject({
    location_id: "ballard-seattle-wa",
    location_name: "Ballard, Seattle, WA",
    email: "reader@example.com",
    created_at: expect.any(Date),
    consented_at: expect.any(Date),
    consent_version: "weekly-editions-v2",
    weekly_editions: true,
    launch_notification: false,
  });
  await mongo.db.collection("editions").insertOne({ location_id: "ballard-seattle-wa" });
  expect((await signup(body)).status).toBe(200);
  expect(await collection.countDocuments()).toBe(1);
  expect((await collection.findOne({ email: "reader@example.com" }))?.created_at).toEqual(initial?.created_at);
  expect((await signup(body, "fremont-seattle-wa")).status).toBe(200);
  expect(await collection.countDocuments()).toBe(2);
});

it("only adds weekly consent to legacy interest records when the reader explicitly signs up again", async () => {
  const collection = mongo.db.collection("reader_interest_signups");
  const createdAt = new Date("2026-01-01");
  await collection.insertOne({
    location_id: "ballard-seattle-wa", email: "reader@example.com", created_at: createdAt,
  });
  expect((await signup({ email: "reader@example.com" })).status).toBe(422);
  expect((await collection.findOne({ email: "reader@example.com" }))?.weekly_editions).toBeUndefined();
  expect((await signup({ email: "reader@example.com", consent: true })).status).toBe(200);
  expect(await collection.countDocuments()).toBe(1);
  expect(await collection.findOne({ email: "reader@example.com" })).toMatchObject({
    created_at: createdAt, weekly_editions: true, consent_version: "weekly-editions-v2",
  });

});

it("only records launch notifications when explicitly requested", async () => {
  const body = { email: "reader@example.com", consent: true, launch_notification: true };
  expect((await signup(body)).status).toBe(200);
  const collection = mongo.db.collection("reader_interest_signups");
  expect(await collection.findOne({ email: body.email })).toMatchObject({
    weekly_editions: true, launch_notification: true, consent_version: "weekly-editions-v1",
  });
  expect((await signup({ ...body, launch_notification: false })).status).toBe(200);
  expect(await collection.findOne({ email: body.email })).toMatchObject({
    weekly_editions: true, launch_notification: false, consent_version: "weekly-editions-v2",
  });
  expect(await collection.countDocuments()).toBe(1);
});

it.each(["true", 1, null])("rejects invalid launch preferences (%s)", async (launch_notification) => {
  expect((await signup({ email: "reader@example.com", consent: true, launch_notification })).status).toBe(422);
  expect(await mongo.db.collection("reader_interest_signups").countDocuments()).toBe(0);
});

it("rejects unknown locations, invalid emails and cross-origin requests", async () => {
  expect((await signup({ email: "reader@example.com", consent: true }, "unknown")).status).toBe(404);
  expect((await signup({ email: "invalid", consent: true })).status).toBe(422);
  expect((await signup({ email: "reader@example.com", consent: true }, "ballard-seattle-wa", "https://elsewhere.example")).status).toBe(403);
  expect(await mongo.db.collection("reader_interest_signups").countDocuments()).toBe(0);
});

it("reports a failed save rather than confirming a signup", async () => {
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    vi.stubGlobal("newsbeeReaderMongo", {
      uri: process.env.MONGODB_URI,
      client: { connect: vi.fn().mockRejectedValue(new Error("Database unavailable")) },
    });
    const response = await signup({ email: "reader@example.com", consent: true });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ detail: "Signup could not be saved. Please try again." });
    expect(errorLog).toHaveBeenCalled();
  } finally {
    errorLog.mockRestore();
  }
});
