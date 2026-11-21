import { MongoClient, type Db } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { principalById, type Principal } from "../../accounts/identity";
import { AccessPolicyError } from "../../accounts/access-policy";
import { PublicationAccessDenied } from "../../publications/permissions";
import { COLLECTIONS } from "../../storage/mongo";
import { GET as supportState, POST as enterSupport, DELETE as exitSupport } from "../../../app/api/admin/publications/[publicationId]/support/route";
import { GET as audit } from "../../../app/api/admin/audit/route";
import { PATCH as patchSettings } from "../../../app/api/admin/output-channels/[channelId]/settings/route";

const state = vi.hoisted(() => ({ db: null as Db | null, principal: null as Principal | null }));
vi.mock("@/lib/admin-api", () => {
  const route = async (operator: boolean, handler: (deps: unknown) => Promise<unknown>) => {
    const principal = state.principal && await principalById(state.db!, state.principal.id);
    if (!principal) return Response.json({ detail: "Sign in required" }, { status: 401 });
    if (operator && principal.role === "editor") return Response.json({ detail: "Operator required" }, { status: 403 });
    try {
      const result = await handler({ db: state.db!, principal });
      return result instanceof Response ? result : Response.json(result);
    } catch (error) {
      return Response.json({ detail: (error as Error).message }, {
        status: error instanceof PublicationAccessDenied ? 403 : error instanceof AccessPolicyError ? error.status : 500,
      });
    }
  };
  return {
    adminRoute: (_request: Request, handler: (deps: unknown) => Promise<unknown>) => route(true, handler),
    publicationRoute: (_request: Request, handler: (deps: unknown) => Promise<unknown>) => route(false, handler),
    jsonBody: (request: Request) => request.json(),
  };
});

let server: MongoMemoryReplSet;
let client: MongoClient;
let db: Db;
const admin: Principal = { id: "operator", email: "operator@example.test", role: "admin" };
const owner: Principal = { id: "owner", email: "owner@example.test", role: "owner" };
const journalist: Principal = { id: "journalist", email: "journalist@example.test", role: "editor" };
const publicationId = "publication-route";
const supportContext = { params: Promise.resolve({ publicationId }) };
const settingsContext = { params: Promise.resolve({ channelId: publicationId }) };
const supportUrl = `https://fixture.test/api/admin/publications/${publicationId}/support`;

beforeAll(async () => {
  server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  client = await MongoClient.connect(server.getUri());
  db = client.db("support-routes");
});
beforeEach(async () => {
  vi.stubEnv("NEWSBEE_OWNER_EMAIL", owner.email);
  await db.dropDatabase();
  state.db = db;
  state.principal = admin;
  await db.collection("journalist_admins").insertMany([owner, admin, journalist].map((principal) => ({
    principalId: principal.id, email: principal.email, role: principal.role, enabled: true,
  })));
  await db.collection(COLLECTIONS.outputChannels).insertOne({
    _id: publicationId, name: "Route Weekly", owner_id: "publication-owner", enabled: true, publication_scope_version: 1,
    members: [{ principal_id: journalist.id, role: "editor" }], selected_location_ids: [],
  });
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { await client?.close(); await server?.stop(); });

function patch(expectedRevision = 0) {
  return patchSettings(new Request(`https://fixture.test/api/admin/output-channels/${publicationId}/settings`, {
    method: "PATCH", body: JSON.stringify({ profile: {
      expected_revision: expectedRevision,
      values: { display_name: "Explicit support update", description: null, homepage_url: null, logo_url: null },
    } }),
  }), settingsContext);
}

it("requires deliberate support at write routes, then invalidates elevation on exit", async () => {
  expect((await patch()).status).toBe(403);
  const entered = await enterSupport(new Request(supportUrl, {
    method: "POST", body: JSON.stringify({ reason: "Repair a reported publication profile issue" }),
  }), supportContext);
  expect(entered.status).toBe(200);
  expect(await entered.json()).toMatchObject({ support: { publicationId, reason: "Repair a reported publication profile issue" } });
  expect((await supportState(new Request(supportUrl), supportContext)).status).toBe(200);
  expect((await patch()).status).toBe(200);
  expect((await exitSupport(new Request(supportUrl, { method: "DELETE" }), supportContext)).status).toBe(200);
  expect((await patch(1)).status).toBe(403);
  expect(await db.collection(COLLECTIONS.outputChannels).findOne({ _id: publicationId }))
    .toMatchObject({ profile: { revision: 1 } });
  expect(await db.collection(COLLECTIONS.publicationAccessAudit).countDocuments({ action: "privileged_write_access" })).toBe(1);
});

it("permits assigned journalist writes without admitting journalists to support or global audit, and denies suspended operators", async () => {
  state.principal = journalist;
  expect((await patch()).status).toBe(200);
  expect((await enterSupport(new Request(supportUrl, {
    method: "POST", body: JSON.stringify({ reason: "Try to obtain global operator support" }),
  }), supportContext)).status).toBe(403);
  expect((await audit(new Request("https://fixture.test/api/admin/audit"))).status).toBe(403);
  state.principal = admin;
  expect((await audit(new Request("https://fixture.test/api/admin/audit"))).status).toBe(403);
  await db.collection("journalist_admins").updateOne({ principalId: admin.id }, { $set: { enabled: false } });
  expect((await supportState(new Request(supportUrl), supportContext)).status).toBe(401);
  state.principal = owner;
  const response = await audit(new Request("https://fixture.test/api/admin/audit?limit=1"));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ integrityScope: "per_entry", timeUnit: "milliseconds" });
  expect((await audit(new Request("https://fixture.test/api/admin/audit?limit=10000"))).status).toBe(400);
});
