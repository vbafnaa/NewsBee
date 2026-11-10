/**
 * Isolated real Next UI + Mongo fixture. No Google login, external requests or worker scheduling.
 * Open /fixture/session?as=owner|editor|other. Spending endpoints below are deliberately mocked.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { encode, decode } from "next-auth/jwt";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appPort = Number(process.env.FIXTURE_APP_PORT ?? 3007), previewPort = Number(process.env.FIXTURE_PREVIEW_PORT ?? 3010);
const secret = randomBytes(32).toString("base64");
const memory = await MongoMemoryServer.create({ instance: { ip: "127.0.0.1" } });
const mongo = await MongoClient.connect(memory.getUri());
const db = mongo.db("isolated-account-ui");
const principals = Object.fromEntries(["owner", "editor", "other"].map((id) => [id, { id: `fixture-${id}`, email: `${id}@example.test`, role: id === "owner" ? "owner" : "editor" }]));
await db.collection("journalist_admins").insertMany(Object.values(principals).map((principal) => ({ email: principal.email, principalId: principal.id, role: principal.role, enabled: true })));
await db.collection("locations").insertMany(["one", "two"].map((id) => ({ _id: `fixture-${id}`, id: `fixture-${id}`, name: `Fixture ${id}`, state: "WA", systems: [], government: null })));
for (const id of ["one", "two"]) {
  const at = new Date("2099-01-01T00:00:00Z"), location_id = `fixture-${id}`;
  await db.collection("reader_engagement").insertMany(["view", "open", "share"].map((action) => ({
    location_id, action, at, edition_id: `fixture-${id}-edition`, story_ids: ["fixture-story"],
  })));
  const signup = { location_id, location_name: `Fixture ${id}`, created_at: at, weekly_editions: true };
  await db.collection("reader_interest_signups").insertMany([
    { ...signup, email: "interest@example.test", interest_signup_at: at, legacy_signup: false, launch_notification: true },
    { ...signup, email: "subscriber@example.test", subscription_signup_at: at, legacy_signup: false, launch_notification: false },
    { ...signup, email: "both@example.test", interest_signup_at: at, subscription_signup_at: at, legacy_signup: false, launch_notification: true },
    { ...signup, email: "legacy@example.test", legacy_signup: true, launch_notification: true },
  ]);
}
const tokens = Object.fromEntries(await Promise.all(Object.entries(principals).map(async ([name, principal]) => [name, await encode({ token: { sub: principal.id, email: principal.email, name: `Fixture ${name}` }, secret, salt: "authjs.session-token", maxAge: 86400 })])));
const env = Object.fromEntries(["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA"].filter((name) => process.env[name]).map((name) => [name, process.env[name]]));
Object.assign(env, {
  NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1", NEWSBEE_MODE: "cloud",
  MONGODB_URI: memory.getUri(), MONGODB_DATABASE: "isolated-account-ui",
  AUTH_SECRET: secret, AUTH_TRUST_HOST: "true", AUTH_URL: `http://127.0.0.1:${previewPort}`,
  AUTH_GOOGLE_ID: "fixture-google-id", AUTH_GOOGLE_SECRET: "fixture-not-a-google-secret",
  NEWSBEE_OWNER_EMAIL: principals.owner.email,
  NEWSBEE_INTERNAL_PASSWORD: "fixture-maps-only",
  NEWSBEE_CREDENTIAL_ACTIVE_KEY: "fixture",
  NEWSBEE_CREDENTIAL_KEYS: JSON.stringify({ fixture: randomBytes(32).toString("base64") }),
  ...(process.argv.includes("--deployment-defaults") ? {
    NEWSBEE_MODEL_PROVIDERS: "fixture",
    NEWSBEE_LLM_FIXTURE_BASE_URL: "https://provider-fixture.invalid/v1",
    NEWSBEE_LLM_FIXTURE_MODEL: "fixture-deployment-model",
    NEWSBEE_LLM_FIXTURE_API_KEY: "fixture-not-a-live-deployment-key",
    NEWSBEE_SERPAPI_API_KEY: "fixture-not-a-live-search-key",
  } : {}),
  NODE_OPTIONS: `--require ${JSON.stringify(path.join(root, "scripts", "fixture-network-guard.cjs"))}`,
});
const next = spawn(process.execPath, [path.join(root, "node_modules", "next", "dist", "bin", "next"), "dev", "--hostname", "127.0.0.1", "--port", String(appPort)], { cwd: root, env, stdio: "inherit" });
if (process.argv.includes("--workspace-review")) {
  const stamp = Date.now() / 1000;
  await db.collection("pipeline_runs").insertOne({
    _id: "fixture-review-run", kind: "edition", location_id: "fixture-one", location_name: "Fixture one",
    trigger: { by: principals.editor.email, kind: "manual" },
    execution: { sponsorId: principals.editor.id, initiatedBy: principals.editor.id, credentialVersion: 1, source: "personal", planHash: "fixture-plan" },
    status: "published", created_at: stamp - 600, updated_at: stamp, completed_at: stamp,
    sources: [], today: "2099-01-01", window: ["2099-01-01", "2099-01-08"], draft_id: null,
    edition_id: null, published: { items: 0, held: 0, held_reasons: {}, artifacts: {} }, error: null, authoring_started_at: stamp - 300,
  });
  await db.collection("journalist_funding_audit").insertMany([
    { run_id: "fixture-review-run", funding: "personal", provider: "fixture-personal", model: "fixture-model", ok: false, reason: null, at: stamp - 120 },
    { run_id: "fixture-review-run", funding: "personal", provider: "fixture-personal", model: "fixture-model", ok: true, reason: null, at: stamp - 100 },
  ]);
}
const json = (response, status, value) => { response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end(JSON.stringify(value)); };
async function actor(request) {
  const token = /(?:^|;\s*)authjs\.session-token=([^;]+)/.exec(request.headers.cookie ?? "")?.[1];
  if (!token) return null;
  const session = await decode({ token, secret, salt: "authjs.session-token" });
  return Object.values(principals).find((principal) => principal.email === session?.email) ?? null;
}
async function bodyOf(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}
async function effectiveProfile(request) {
  const response = await fetch(`http://127.0.0.1:${appPort}/api/account/settings`, { headers: { cookie: request.headers.cookie ?? "", host: `127.0.0.1:${previewPort}` } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail ?? "Fixture account metadata unavailable.");
  return data.profile;
}
function mockPlan(locationId, kind, choices, profile) {
  // Full panel options only: match production serialization without running an orchestrator.
  const values = { ...choices, rebuild: choices.rebuild === true, story_limit: Number(choices.story_limit) > 0 ? Math.floor(Number(choices.story_limit)) : null };
  const options = Object.fromEntries(["rebuild", "mode", "flow", "map_flow", "guardrails", "guardrails_off", "access", "access_ignore", "count_history", "paid", "external_off", "search_provider", "classifier", "topics", "story_limit"].map((key) => [key, values[key]]));
  if (kind === "map") options.flow = options.map_flow ?? options.flow;
  const plan = { locationId, kind, options, credentialVersion: profile?.version ?? 0, source: profile?.source ?? "personal" };
  return { options, planHash: createHash("sha256").update(JSON.stringify(plan)).digest("hex") };
}
const preview = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://127.0.0.1:${previewPort}`);
    if (url.pathname === "/fixture/session") {
      const name = url.searchParams.get("as") ?? "owner";
      if (!tokens[name]) return json(response, 400, { detail: "Choose owner, editor or other." });
      response.writeHead(302, { "Set-Cookie": `authjs.session-token=${tokens[name]}; HttpOnly; Path=/; SameSite=Lax`, Location: url.searchParams.get("next") ?? "/account" }); response.end(); return;
    }
    if (url.pathname === "/fixture/reset") {
      await db.collection("pipeline_runs").deleteMany({});
      response.writeHead(302, { Location: "/locations" }); response.end(); return;
    }
    const bytes = await bodyOf(request);
    const spendStart = url.pathname.match(/^\/api\/admin\/locations\/([^/]+)\/(ingestion|map-run)$/);
    const spendExisting = url.pathname.match(/^\/api\/admin\/runs\/([^/]+)\/(restart|resume|authoring|finish|actions|jobs\/[^/]+\/retry)$/);
    if (request.method === "POST" && (spendStart || spendExisting || url.pathname === "/api/admin/execution")) {
      const principal = await actor(request);
      if (!principal || !await db.collection("journalist_admins").findOne({ principalId: principal.id, enabled: true })) return json(response, 403, { detail: "Fixture account is disabled." });
      const body = bytes.length ? JSON.parse(bytes.toString()) : {};
      if (spendStart) {
        const blocker = await db.collection("pipeline_runs").findOne({ status: { $in: ["mapping", "collecting", "awaiting_authoring", "authoring", "awaiting_finish", "finishing", "publishing"] } });
        if (blocker) return json(response, 409, { detail: `Mock newsroom busy: ${blocker.location_name}.` });
        const profile = await effectiveProfile(request);
        if (profile?.revoked) return json(response, 403, { detail: "Fixture profile is revoked." });
        const runId = randomUUID(), stamp = Date.now() / 1000;
        const kind = spendStart[2] === "map-run" ? "map" : "edition";
        const normalized = mockPlan(spendStart[1], kind, { ...body.options, rebuild: body.rebuild ?? body.options?.rebuild }, profile);
        const options = normalized.options;
        const run = { _id: runId, admission: "newsroom", kind: spendStart[2] === "map-run" ? "map" : "edition", location_id: spendStart[1], location_name: `Fixture ${spendStart[1]}`, trigger: { by: principal.email, kind: "manual" }, options,
          execution: { sponsorId: principal.id, initiatedBy: principal.id, credentialVersion: profile?.version ?? 0, source: profile?.source ?? "personal", planHash: normalized.planHash },
          status: "awaiting_authoring", created_at: stamp, updated_at: stamp, completed_at: null, sources: [], today: "2099-01-01", window: ["2099-01-01", "2099-01-08"], draft_id: null, edition_id: null, published: null, error: null, authoring_started_at: null };
        await db.collection("pipeline_runs").insertOne(run);
        console.log("UI mock admitted run; no job scheduled:", runId);
        return json(response, 200, { run_id: runId, started: true, mock: true });
      }
      const runId = spendExisting?.[1] ?? body.runId;
      const run = await db.collection("pipeline_runs").findOne({ _id: runId });
      if (spendExisting?.[2] === "restart") return json(response, 200, { run_id: runId, mock: true, detail: "Mocked restart: no new run, worker or provider invoked." });
      if (!run || run.execution?.sponsorId !== principal.id) return json(response, 403, { detail: "Only the person who started this run can trigger more paid work." });
      if (url.pathname === "/api/admin/execution") {
        const profile = await effectiveProfile(request);
        if (!profile || profile.revoked) return json(response, 403, { detail: "Configure an active execution profile before reconnecting." });
        await db.collection("pipeline_runs").updateOne({ _id: runId }, { $set: {
          "execution.credentialVersion": profile.version, "execution.source": profile.source,
          "execution.planHash": mockPlan(run.location_id, run.kind ?? "edition", run.options, profile).planHash,
        }, $unset: { execution_blocked: "" } });
        console.log("UI mock reconnect; no job scheduled:", runId);
        return json(response, 200, { run_id: runId, reconnected: true, mock: true });
      }
      if (run.execution_blocked) return json(response, 403, { detail: run.execution_blocked.reason });
      return json(response, 200, { run_id: runId, mock: true, detail: "Mocked action: no worker, provider or publisher invoked." });
    }
    const headers = { ...request.headers, host: `127.0.0.1:${previewPort}`, "x-forwarded-host": `127.0.0.1:${previewPort}`, "x-forwarded-proto": "http" };
    delete headers.connection;
    const upstream = await fetch(`http://127.0.0.1:${appPort}${url.pathname}${url.search}`, { method: request.method, headers, ...(bytes.length ? { body: bytes } : {}), redirect: "manual" });
    const outgoing = Object.fromEntries(upstream.headers);
    delete outgoing["content-encoding"]; delete outgoing["content-length"]; delete outgoing["transfer-encoding"];
    response.writeHead(upstream.status, outgoing); response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) { console.error("Fixture request failed:", error.message); json(response, 500, { detail: "Fixture request failed; inspect local fixture output." }); }
});
preview.listen(previewPort, "127.0.0.1", () => console.log(`Isolated account UI: http://127.0.0.1:${previewPort}/fixture/session?as=owner (also editor, other). All pipeline starts/reconnects/paid run actions are mocked; external fetch blocked.`));
async function close() { preview.close(); next.kill(); await mongo.close(); await memory.stop(); }
process.once("SIGINT", () => void close().finally(() => process.exit()));
process.once("SIGTERM", () => void close().finally(() => process.exit()));
