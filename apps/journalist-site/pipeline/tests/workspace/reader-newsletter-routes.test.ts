import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { newsletterLink, requestNewsletter, updateNewsletter, validateNewsletterSignup, SUBSCRIPTIONS,
  type NewsletterConfig, type Subscription } from "../../../../reader-site/src/lib/newsletter";

const deps = vi.hoisted(() => ({ readerData: vi.fn(), readerDatabase: vi.fn() }));
vi.mock("../../../../reader-site/src/lib/reader-data", () => deps);
import { GET as dispatchGet } from "../../../../reader-site/src/pages/api/newsletter/dispatch";
import { POST as preferencesPost } from "../../../../reader-site/src/pages/api/newsletter/preferences";
import { GET as unsubscribeGet, POST as unsubscribePost } from "../../../../reader-site/src/pages/api/newsletter/unsubscribe";

const origin = "http://127.0.0.1:4321";
const base = `${origin}/reader`;
const secret = "isolated-newsletter-route-test-secret-at-least-32";
const cronSecret = "isolated-newsletter-cron-secret";
const location = { id: "ballard-wa", name: "Ballard, WA" };
const config: NewsletterConfig = { provider: "local", from: "Newsbee <preview@newsbee.test>", publicUrl: base, secret, apiKey: "fake-local-key" };
let server: MongoMemoryServer, client: MongoClient, db: Db;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await MongoClient.connect(server.getUri());
  db = client.db("isolated-reader-newsletter-routes");
});
beforeEach(async () => {
  await db.dropDatabase();
  deps.readerDatabase.mockReset().mockResolvedValue(db);
  deps.readerData.mockReset().mockResolvedValue({ locations: [location], editions: [] });
  vi.stubEnv("NEWSBEE_MODE", "local"); vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("NEWSBEE_NEWSLETTER_PROVIDER", "local"); vi.stubEnv("NEWSBEE_NEWSLETTER_PUBLIC_URL", base);
  vi.stubEnv("NEWSBEE_NEWSLETTER_SECRET", secret); vi.stubEnv("NEWSBEE_NEWSLETTER_FROM", config.from);
  vi.stubEnv("RESEND_API_KEY", "fake-local-key"); vi.stubEnv("CRON_SECRET", cronSecret);
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { await client?.close(); await server?.stop(); });

const context = (request: Request) => ({ request, url: new URL(request.url) }) as Parameters<typeof preferencesPost>[0];
async function active() {
  const request = await requestNewsletter(db, location, validateNewsletterSignup({ email: "reader@example.test", consent: true, topics: ["housing"] }), config);
  const pending = (await db.collection<Subscription>(SUBSCRIPTIONS).findOne({ _id: request.id }))!;
  const confirmToken = new URL(newsletterLink(config, pending, "confirm")).searchParams.get("token")!;
  return (await updateNewsletter(db, config, pending._id, confirmToken, "confirm")).sub;
}
const preferencesRequest = (body: unknown, requestOrigin: string | null = origin) => new Request(`${base}/api/newsletter/preferences`, {
  method: "POST", headers: { "Content-Type": "application/json", ...(requestOrigin ? { Origin: requestOrigin } : {}) }, body: JSON.stringify(body),
});

describe("newsletter route boundaries", () => {
  it("authenticates dispatch before loading the public catalog or subscriber database", async () => {
    for (const authorization of [undefined, "Bearer wrong", "Basic anything"]) {
      const response = await dispatchGet(context(new Request(`${base}/api/newsletter/dispatch`, { headers: authorization ? { Authorization: authorization } : {} })));
      expect(response.status).toBe(401);
    }
    expect(deps.readerDatabase).not.toHaveBeenCalled();
    expect(deps.readerData).not.toHaveBeenCalled();
    const allowed = await dispatchGet(context(new Request(`${base}/api/newsletter/dispatch`, { headers: { Authorization: `Bearer ${cronSecret}` } })));
    expect(allowed.status).toBe(503);
    expect(await allowed.json()).toMatchObject({ detail: expect.stringContaining("has not launched") });
    expect(deps.readerDatabase).not.toHaveBeenCalled();
    expect(deps.readerData).not.toHaveBeenCalled();
    expect(allowed.headers.get("cache-control")).toContain("no-store");
  });

  it("blocks confirmation before DB access and preserves inactive status on preference updates", async () => {
    const sub = await active();
    const token = new URL(newsletterLink(config, sub, "manage")).searchParams.get("token")!;
    deps.readerDatabase.mockClear();
    const blocked = await preferencesPost(context(preferencesRequest({ id: sub._id, token, action: "confirm" })));
    expect(blocked.status).toBe(503);
    expect(deps.readerDatabase).not.toHaveBeenCalled();
    for (const status of ["pending", "unsubscribed"] as const) {
      await db.collection<Subscription>(SUBSCRIPTIONS).updateOne({ _id: sub._id }, { $set: { status } });
      const response = await preferencesPost(context(preferencesRequest({
        id: sub._id, token, action: "preferences", topics: ["events"], consent: true,
      })));
      expect(response.status).toBe(200);
      expect(await db.collection<Subscription>(SUBSCRIPTIONS).findOne({ _id: sub._id }))
        .toMatchObject({ status, topics: ["events"] });
    }
  });

  it("requires same-origin requests, a signed capability, and explicit consent for preference changes", async () => {
    const sub = await active();
    const token = new URL(newsletterLink(config, sub, "manage")).searchParams.get("token")!;
    const body = { id: sub._id, token, action: "preferences", topics: ["events"], consent: true };
    expect((await preferencesPost(context(preferencesRequest(body, "https://other.example")))).status).toBe(403);
    expect((await preferencesPost(context(preferencesRequest(body, null)))).status).toBe(403);
    expect((await preferencesPost(context(preferencesRequest({ ...body, consent: false })))).status).toBe(422);
    expect((await preferencesPost(context(preferencesRequest({ ...body, token: "0".repeat(64) })))).status).toBe(422);
    expect((await db.collection<Subscription>(SUBSCRIPTIONS).findOne({ _id: sub._id }))?.topics).toEqual(["housing"]);
    const saved = await preferencesPost(context(preferencesRequest(body)));
    expect(saved.status).toBe(200);
    expect(saved.headers.get("referrer-policy")).toBe("no-referrer");
    expect((await db.collection<Subscription>(SUBSCRIPTIONS).findOne({ _id: sub._id }))?.topics).toEqual(["events"]);
  });

  it("bounds streamed preference JSON even without a Content-Length header", async () => {
    const request = preferencesRequest({ padding: "x".repeat(9000) });
    expect(request.headers.has("content-length")).toBe(false);
    const response = await preferencesPost(context(request));
    expect(response.status).toBe(400);
    expect(deps.readerDatabase).not.toHaveBeenCalled();
  });

  it("keeps unsubscribe GET read-only while allowing an authenticated one-click POST without a browser origin", async () => {
    const sub = await active();
    const token = new URL(newsletterLink(config, sub, "manage")).searchParams.get("token")!;
    const url = new URL(`${base}/api/newsletter/unsubscribe`);
    url.search = new URLSearchParams({ id: sub._id, token }).toString();
    const getContext = { ...context(new Request(url)), redirect: (target: string, status = 302) => new Response(null, { status, headers: { Location: target } }) } as Parameters<typeof unsubscribeGet>[0];
    const shown = await unsubscribeGet(getContext);
    expect(shown.status).toBe(303);
    expect(shown.headers.get("location")).toContain("/newsletter?");
    expect(shown.headers.get("cache-control")).toBe("private, no-store");
    expect(shown.headers.get("referrer-policy")).toBe("no-referrer");
    expect((await db.collection<Subscription>(SUBSCRIPTIONS).findOne({ _id: sub._id }))?.status).toBe("active");
    const request = new Request(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
    expect(request.headers.has("origin")).toBe(false);
    const result = await unsubscribePost(context(request));
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ status: "unsubscribed" });
    expect((await db.collection<Subscription>(SUBSCRIPTIONS).findOne({ _id: sub._id }))?.status).toBe("unsubscribed");
    url.searchParams.set("token", "0".repeat(64));
    expect((await unsubscribePost(context(new Request(url, { method: "POST" })))).status).toBe(422);
  });
});
