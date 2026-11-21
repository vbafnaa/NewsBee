import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import type { Edition, EditionItem } from "../../../../reader-site/src/lib/reader-data";
import { MAIL, SUBSCRIPTIONS, deliverNewsletterJob, dispatchNewsletters, editionEmail, newsletterAccess, newsletterConfig,
  newsletterItems, newsletterLink, newsletterTransport, requestNewsletter, updateNewsletter, validateNewsletterSignup,
  type MailTransport, type NewsletterConfig, type Subscription } from "../../../../reader-site/src/lib/newsletter";

// Keep simulated requests within one hourly bucket and its TTL ahead of Mongo's real clock.
const now = new Date(Math.floor(Date.now() / 3600_000) * 3600_000);
const later = (milliseconds: number) => new Date(now.getTime() + milliseconds);
const location = { id: "ballard-wa", name: "Ballard, WA" };
const localEnvironment = { NEWSBEE_MODE: "local", NODE_ENV: "test", NEWSBEE_NEWSLETTER_PROVIDER: "local",
  NEWSBEE_NEWSLETTER_PUBLIC_URL: "http://127.0.0.1:4321/reader", NEWSBEE_NEWSLETTER_SECRET: "isolated-newsletter-test-secret-at-least-32-chars" };
const config: NewsletterConfig = { provider: "local", from: "Newsbee <preview@newsbee.test>",
  publicUrl: localEnvironment.NEWSBEE_NEWSLETTER_PUBLIC_URL, secret: localEnvironment.NEWSBEE_NEWSLETTER_SECRET, apiKey: "fake-local-key" };
const signup = (topics: string[] = []) => validateNewsletterSignup({ email: " Reader@Example.test ", consent: true, topics });
const story = (id: string | null, headline: string, kind: EditionItem["kind"] = "local_news"): EditionItem => ({
  story_id: id, headline, kind, blurb: "Public details from the neighborhood.", event_date: "2026-11-12", when_where: "Town Hall", source_url: "https://example.test/news",
});
const edition = (id = "edition-published", locationId = location.id, publishedAt = now.getTime() / 1000 - 60, items = [story("bus", "New bus route")]): Edition => ({
  id, location_id: locationId, location_name: location.name, published_at: publishedAt, headline: "This week", intro: "",
  window_start: "2026-11-06", window_end: "2026-11-12", items,
});

let server: MongoMemoryServer, client: MongoClient, db: Db;
const subscriptions = () => db.collection<Subscription>(SUBSCRIPTIONS);
const jobs = () => db.collection<{ _id: string; kind: string; status: string; attempts: number; firstAttemptAt?: Date; nextAttemptAt: Date; [key: string]: unknown }>(MAIL);
const tokenFrom = (url: string) => new URL(url).searchParams.get("token")!;
async function pending(topics: string[] = []) {
  const request = await requestNewsletter(db, location, signup(topics), config, now);
  return (await subscriptions().findOne({ _id: request.id }))!;
}
async function active(topics: string[] = []) {
  const sub = await pending(topics);
  return (await updateNewsletter(db, config, sub._id, tokenFrom(newsletterLink(config, sub, "confirm")), "confirm", undefined, later(1000))).sub;
}

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await MongoClient.connect(server.getUri());
  db = client.db("isolated-reader-newsletter");
});
beforeEach(async () => { await db.dropDatabase(); });
afterAll(async () => { await client?.close(); await server?.stop(); });

describe("newsletter configuration and signup validation", () => {
  it("requires explicit local mode and rejects a local provider in production", () => {
    expect(newsletterConfig(localEnvironment)).toMatchObject({ provider: "local", publicUrl: "http://127.0.0.1:4321/reader" });
    expect(newsletterConfig({ ...localEnvironment, NEWSBEE_MODE: "cloud" })).toBeNull();
    expect(newsletterConfig({ ...localEnvironment, NODE_ENV: "production" })).toBeNull();
    expect(newsletterConfig({ ...localEnvironment, NEWSBEE_NEWSLETTER_SECRET: "short" })).toBeNull();
  });

  it("uses a canonical public URL and prevents mail-header injection or unknown topics", () => {
    expect(newsletterConfig({ ...localEnvironment, NEWSBEE_NEWSLETTER_PUBLIC_URL: "http://127.0.0.1:4321/reader?host=untrusted" })).toBeNull();
    expect(newsletterConfig({ ...localEnvironment, NEWSBEE_NEWSLETTER_FROM: "Newsbee <mail@example.test>\r\nBcc: other@example.test" })).toBeNull();
    expect(newsletterConfig({ ...localEnvironment, NEWSBEE_NEWSLETTER_PUBLIC_URL: "https://user:password@example.test/reader" })).toBeNull();
    expect(() => validateNewsletterSignup({ email: "reader@example.test", consent: false })).toThrow(/consent/i);
    expect(() => signup(["internal-topic"])).toThrow(/topics/i);
    expect(signup(["housing", "housing"])).toMatchObject({ email: "reader@example.test", topics: ["housing"] });
  });
});

describe("confirmed subscription ownership", () => {
  it("limits repeated public requests per email and permits a new request in the next hourly window", async () => {
    for (let i = 0; i < 5; i++) await requestNewsletter(db, location, signup(), null, later(i * 120_000));
    await expect(requestNewsletter(db, location, signup(["events"]), null, later(600_000))).rejects.toThrow(/too many/i);
    expect(await subscriptions().countDocuments()).toBe(1);
    expect((await subscriptions().findOne({ email: "reader@example.test" }))?.pending?.topics).toEqual([]);
    await expect(requestNewsletter(db, location, signup(["events"]), null, later(3600_000))).resolves.toMatchObject({ queued: false });
    expect((await subscriptions().findOne({ email: "reader@example.test" }))?.pending?.topics).toEqual(["events"]);
  });

  it("queues a confirmation and activates chosen preferences only after a valid confirmation", async () => {
    const sub = await pending(["housing", "events"]);
    expect(sub).toMatchObject({ status: "pending", topics: [], pending: { topics: ["housing", "events"] } });
    expect(await db.collection("reader_newsletter_preview_mail").countDocuments()).toBe(1);
    expect(await jobs().findOne({ kind: "confirmation" })).toMatchObject({ status: "sent", attempts: 1 });
    const confirmationToken = tokenFrom(newsletterLink(config, sub, "confirm"));
    const result = await updateNewsletter(db, config, sub._id, confirmationToken, "confirm", undefined, later(1000));
    expect(result.sub).toMatchObject({ status: "active", topics: ["housing", "events"] });
    expect(result.sub.pending).toBeUndefined();
    expect(new URL(result.manageUrl).origin).toBe("http://127.0.0.1:4321");
    expect(await newsletterAccess(db, config, sub._id, confirmationToken, "confirm", later(2000))).toMatchObject({ status: "active", topics: ["housing", "events"] });
    expect(await newsletterAccess(db, config, sub._id, tokenFrom(result.manageUrl), "manage", later(2000))).not.toBeNull();
  });

  it("retries a successful confirmation without resetting later preferences or reactivating an unsubscribed reader", async () => {
    const sub = await pending(["housing"]);
    const confirmationToken = tokenFrom(newsletterLink(config, sub, "confirm"));
    const first = await updateNewsletter(db, config, sub._id, confirmationToken, "confirm", undefined, later(1000));
    const retried = await updateNewsletter(db, config, sub._id, confirmationToken, "confirm", undefined, later(2000));
    expect(retried.manageUrl).toBe(first.manageUrl);
    expect(retried.sub.confirmedAt).toEqual(first.sub.confirmedAt);
    const manageToken = tokenFrom(first.manageUrl);
    await updateNewsletter(db, config, sub._id, manageToken, "preferences", ["events"], later(3000));
    expect((await updateNewsletter(db, config, sub._id, confirmationToken, "confirm", undefined, later(4000))).sub.topics).toEqual(["events"]);
    await expect(updateNewsletter(db, config, sub._id, confirmationToken, "confirm", undefined, later(48 * 3600_000 + 1))).rejects.toThrow(/invalid or expired/i);
    await updateNewsletter(db, config, sub._id, manageToken, "unsubscribe", undefined, later(5000));
    await expect(updateNewsletter(db, config, sub._id, confirmationToken, "confirm", undefined, later(6000))).rejects.toThrow(/invalid or expired/i);
    expect((await subscriptions().findOne({ _id: sub._id }))?.status).toBe("unsubscribed");
  });

  it("rejects invalid, wrong-purpose, superseded, and expired confirmation tokens", async () => {
    const sub = await pending(["housing"]);
    const original = tokenFrom(newsletterLink(config, sub, "confirm"));
    expect(await newsletterAccess(db, config, "not-an-id", original, "confirm", now)).toBeNull();
    expect(await newsletterAccess(db, config, sub._id, "not-hex", "confirm", now)).toBeNull();
    expect(await newsletterAccess(db, config, sub._id, "0".repeat(64), "confirm", now)).toBeNull();
    expect(await newsletterAccess(db, config, sub._id, original, "manage", now)).toBeNull();
    expect(await newsletterAccess(db, config, sub._id, original, "confirm", later(48 * 3600_000))).toBeNull();
    await expect(updateNewsletter(db, config, sub._id, original, "confirm", undefined, later(48 * 3600_000))).rejects.toThrow(/invalid or expired/i);
    await requestNewsletter(db, location, signup(["sports"]), config, later(61_000));
    expect(await newsletterAccess(db, config, sub._id, original, "confirm", later(62_000))).toBeNull();
    expect((await subscriptions().findOne({ _id: sub._id }))?.status).toBe("pending");
  });

  it("does not let unauthenticated signup requests change active preferences or resubscribe an opted-out reader", async () => {
    const sub = await active(["housing"]);
    const manageToken = tokenFrom(newsletterLink(config, sub, "manage"));
    await requestNewsletter(db, location, signup(["sports"]), config, later(61_000));
    const unchanged = await subscriptions().findOne({ _id: sub._id });
    expect(unchanged).toMatchObject({ status: "active", topics: ["housing"], pending: { topics: ["sports"] } });
    await expect(updateNewsletter(db, config, sub._id, "f".repeat(64), "preferences", ["sports"], later(62_000))).rejects.toThrow(/invalid/i);
    await updateNewsletter(db, config, sub._id, manageToken, "unsubscribe", undefined, later(63_000));
    await requestNewsletter(db, location, signup(["sports"]), config, later(125_000));
    expect(await subscriptions().findOne({ _id: sub._id })).toMatchObject({ status: "unsubscribed", topics: ["housing"] });
  });

  it("blocks confirmation, reactivation, and delivery while subscription data clearing is pending", async () => {
    const sub = await active(["housing"]);
    const manageToken = tokenFrom(newsletterLink(config, sub, "manage"));
    await requestNewsletter(db, location, signup(["events"]), config, later(61_000));
    const current = (await subscriptions().findOne({ _id: sub._id }))!;
    const confirmationToken = tokenFrom(newsletterLink(config, current, "confirm"));
    const issue = edition("revoked", location.id, undefined, [story("permit", "New housing permit", "building_permit")]);
    await dispatchNewsletters(db, config, { locations: [location], editions: [issue] }, later(62_000), async () => { throw new Error("temporary"); });
    const queued = (await jobs().findOne({ kind: "edition" }))!;
    expect(queued.status).toBe("queued");
    const previewCount = await db.collection("reader_newsletter_preview_mail").countDocuments();
    await subscriptions().updateOne({ _id: sub._id }, { $set: { dataClearPending: true } });
    await expect(requestNewsletter(db, location, signup(), config, later(125_000))).rejects.toThrow(/being cleared/i);
    expect(await newsletterAccess(db, config, sub._id, manageToken, "manage", later(126_000))).toBeNull();
    expect(await newsletterAccess(db, config, sub._id, confirmationToken, "confirm", later(126_000))).toBeNull();
    await expect(updateNewsletter(db, config, sub._id, manageToken, "preferences", ["events"], later(126_000))).rejects.toThrow(/invalid or expired/i);
    await expect(updateNewsletter(db, config, sub._id, confirmationToken, "confirm", undefined, later(126_000))).rejects.toThrow(/invalid or expired/i);
    const send = vi.fn<MailTransport>(async () => "must-not-send");
    expect(await deliverNewsletterJob(db, config, queued._id, later(300_000), send)).toBe(false);
    const result = await dispatchNewsletters(db, config, { locations: [location], editions: [issue] }, later(400_000), send);
    expect(result.scanned).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(await jobs().findOne({ _id: queued._id })).toMatchObject({ status: "cancelled" });
    await expect(newsletterTransport(db, config)(editionEmail(config, current, issue), "revoked-local-preview")).rejects.toThrow(/revoked/i);
    expect(await db.collection("reader_newsletter_preview_mail").countDocuments()).toBe(previewCount);
  });
});

describe("personalized public editions", () => {
  it("filters topics without changing exact story indices and escapes public text in email", async () => {
    const sub = await active(["events"]);
    const issue = edition("issue & exact", location.id, undefined, [
      story("news", "New bus route"), story(null, "Library <story time>", "event"), story("court", "Court update", "court_case"),
    ]);
    expect(newsletterItems(issue, sub.topics).map(({ index }) => index)).toEqual([1]);
    const email = editionEmail(config, sub, issue);
    expect(email.text).toContain("story=item%3A2");
    expect(email.text).toContain("edition=issue+%26+exact");
    expect(email.text).not.toContain("New bus route");
    expect(email.html).toContain("Library &lt;story time&gt;");
    expect(email.html).not.toContain("Library <story time>");
    expect(email.headers).toMatchObject({ "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
    expect(email.headers?.["List-Unsubscribe"]).toContain("http://127.0.0.1:4321/reader/api/newsletter/unsubscribe?");
  });

  it("excludes other communities, removed communities, future issues, and unpublished timestamps", async () => {
    await active();
    const send = vi.fn<MailTransport>(async () => "fake-receipt");
    await dispatchNewsletters(db, config, { locations: [location], editions: [
      edition("other", "moses-lake-wa"), edition("draft", location.id, 0), edition("negative", location.id, -1),
      edition("future", location.id, later(60_000).getTime() / 1000), edition("invalid", location.id, Number.NaN),
    ] }, later(2000), send);
    expect(send).not.toHaveBeenCalled();
    expect(await jobs().countDocuments({ kind: "edition" })).toBe(0);
  });

  it("sends only the latest eligible edition to the subscribed community", async () => {
    await active(["events"]);
    const send = vi.fn<MailTransport>(async () => "fake-receipt");
    await dispatchNewsletters(db, config, { locations: [location, { id: "moses-lake-wa", name: "Moses Lake, WA" }], editions: [
      edition("old", location.id, now.getTime() / 1000 - 100, [story("old", "Old library event", "event")]),
      edition("latest", location.id, now.getTime() / 1000 - 1, [story("new", "New library event", "event"), story("bus", "Bus route")]),
      edition("other-latest", "moses-lake-wa", now.getTime() / 1000, [story("other", "Other community event", "event")]),
    ] }, later(2000), send);
    expect(send).toHaveBeenCalledTimes(1);
    const envelope = send.mock.calls[0][0];
    expect(envelope.text).toContain("New library event");
    expect(envelope.text).toContain("edition=latest");
    expect(envelope.text).not.toContain("Old library event");
    expect(envelope.text).not.toContain("Other community event");
    expect(envelope.text).not.toContain("Bus route");
  });

  it("does not retry a queued edition after its community or edition leaves the public catalog", async () => {
    await active();
    await dispatchNewsletters(db, config, { locations: [location], editions: [edition()] }, later(2000), async () => { throw new Error("temporary"); });
    const queued = (await jobs().findOne({ kind: "edition" }))!;
    expect(queued.status).toBe("queued");
    const send = vi.fn<MailTransport>(async () => "must-not-send");
    await dispatchNewsletters(db, config, { locations: [], editions: [] }, later(300_000), send);
    expect(send).not.toHaveBeenCalled();
    expect(await jobs().findOne({ _id: queued._id })).toMatchObject({ status: "cancelled" });
  });
});

describe("durable delivery claims", () => {
  it("claims concurrent dispatches once and retains the sent receipt on later dispatches", async () => {
    await active();
    const send = vi.fn<MailTransport>(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); return "fake-receipt"; });
    const catalog = { locations: [location], editions: [edition()] };
    await Promise.all([dispatchNewsletters(db, config, catalog, later(2000), send), dispatchNewsletters(db, config, catalog, later(2000), send)]);
    await dispatchNewsletters(db, config, catalog, later(300_000), send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await jobs().countDocuments({ kind: "edition" })).toBe(1);
    expect(await jobs().findOne({ kind: "edition" })).toMatchObject({ status: "sent", providerId: "fake-receipt", attempts: 1 });
  });

  it("retries provider failures with the same idempotency key and prevents a second successful delivery", async () => {
    await active();
    const firstSend = vi.fn<MailTransport>(async () => { throw new Error("Temporary provider failure"); });
    await dispatchNewsletters(db, config, { locations: [location], editions: [edition()] }, later(2000), firstSend);
    const queued = (await jobs().findOne({ kind: "edition" }))!;
    expect(queued.status).toBe("queued");
    const retry = vi.fn<MailTransport>(async () => "retried-receipt");
    expect(await deliverNewsletterJob(db, { ...config, from: "Changed sender <changed@newsbee.test>" }, queued._id, later(300_000), retry)).toBe(true);
    expect(await deliverNewsletterJob(db, config, queued._id, later(400_000), retry)).toBe(false);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(firstSend.mock.calls[0][1]).toBe(retry.mock.calls[0][1]);
    expect(retry.mock.calls[0][0]).toEqual(firstSend.mock.calls[0][0]);
    expect(retry.mock.calls[0][0].from).toBe(config.from);
    expect(await jobs().findOne({ _id: queued._id })).toMatchObject({ status: "sent", attempts: 2 });
  });

  it("stops retrying beyond the provider's safe 23-hour idempotency window", async () => {
    await active();
    await dispatchNewsletters(db, config, { locations: [location], editions: [edition()] }, later(2000), async () => { throw new Error("temporary"); });
    const queued = (await jobs().findOne({ kind: "edition" }))!;
    await jobs().updateOne({ _id: queued._id }, { $set: { firstAttemptAt: later(-24 * 3600_000), nextAttemptAt: now } });
    const send = vi.fn<MailTransport>(async () => "must-not-send");
    expect(await deliverNewsletterJob(db, config, queued._id, later(3000), send)).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(await jobs().findOne({ _id: queued._id })).toMatchObject({ status: "failed", error: expect.stringContaining("retry window expired") });
  });

  it("cancels queued editions when the reader unsubscribes", async () => {
    const sub = await active();
    const catalog = { locations: [location], editions: [edition()] };
    await dispatchNewsletters(db, config, catalog, later(2000), async () => { throw new Error("temporary"); });
    const queued = (await jobs().findOne({ kind: "edition" }))!;
    await updateNewsletter(db, config, sub._id, tokenFrom(newsletterLink(config, sub, "manage")), "unsubscribe", undefined, later(3000));
    expect(await jobs().findOne({ _id: queued._id })).toMatchObject({ status: "cancelled" });
    const send = vi.fn<MailTransport>(async () => "must-not-send");
    expect(await deliverNewsletterJob(db, config, queued._id, later(300_000), send)).toBe(false);
    await dispatchNewsletters(db, config, catalog, later(400_000), send);
    expect(send).not.toHaveBeenCalled();
  });
});
