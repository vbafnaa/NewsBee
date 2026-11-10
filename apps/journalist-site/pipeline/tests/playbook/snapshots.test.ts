import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { HttpTransport } from "../../core/http";
import { HARD_LIMITS } from "../../trace/gateway";
import { agentRuns, jevRequest, methodRuns, pureCapture, serviceRequests } from "./capture";

// The made-up sites have no DNS, and nothing here needs pacing.
vi.mock("../../connectors/public-http", async (original) => ({ ...await original<object>(), publicSourceTransport: (transport: HttpTransport) => transport }));
vi.mock("../../connectors/fetch-state", async (original) => ({ ...await original<object>(), reserveHost: async () => 0 }));
// The golden copy is upstream's, made with caps on; this repository turns caps off by default.
vi.stubEnv("NEWSBEE_GUARDRAILS_OFF", "none");
// It was also made with upstream's never-read list; this repository adds three publishers to it.
vi.mock("../../connectors/fetcher", async (original) => ({ ...await original<object>(), DO_NOT_SCRAPE: ["facebook.com", "nextdoor.com", "instagram.com", "x.com", "twitter.com", "reddit.com", "tiktok.com", "legacy.com"] }));

const GOLDEN = new URL("./golden.json", import.meta.url);
const golden: Record<string, unknown> = existsSync(GOLDEN) ? JSON.parse(readFileSync(GOLDEN, "utf8")) : {};
const fresh: Record<string, unknown> = {};
/** Compared as JSON, so a difference is one in what would be stored or sent. */
const same = (name: string, value: unknown) => {
  fresh[name] = JSON.parse(JSON.stringify(value));
  if (!process.env.PLAYBOOK_WRITE_GOLDEN) expect(fresh[name]).toEqual(golden[name]);
};

describe("everything the scrapers did on origin/main, before the rules moved", () => {
  let server: MongoMemoryServer, client: MongoClient, db: Db;
  // What was sent is pinned without the free-tier hard limits, which pace and cap calls; they have tests of their own.
  const limits = { ...HARD_LIMITS };
  beforeAll(async () => { for (const key of Object.keys(HARD_LIMITS)) delete HARD_LIMITS[key]; server = await MongoMemoryServer.create(); client = await MongoClient.connect(server.getUri()); db = client.db("capture"); });
  afterAll(async () => {
    Object.assign(HARD_LIMITS, limits);
    await client.close(); await server.stop();
    if (process.env.PLAYBOOK_WRITE_GOLDEN) writeFileSync(GOLDEN, `${JSON.stringify({ ...golden, ...fresh }, null, 1)}\n`);
  });

  it("generated queries for sample places and topics", () => same("queries", pureCapture().queries));
  it("section, tier, page-match and address decisions", () => same("pure", pureCapture().pure));
  it("what each search service is sent", async () => same("services", await serviceRequests(db)), 120_000);
  it("the classifier's question", async () => same("jev", await jevRequest(db)));
  it("every fixed method and the operator search, against a made-up web", async () => same("methods", await methodRuns(db)), 280_000);
  it("the mapping agent's rounds and prompts, apart from the skill text", async () => same("agent", await agentRuns(db)), 120_000);
});
