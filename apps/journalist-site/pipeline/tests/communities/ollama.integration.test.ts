import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { loadSettings } from "../../core/config";
import { fetchTransport, type HttpTransport } from "../../core/http";
import { logger } from "../../core/log";
import { searchGeography } from "../../communities/geocoder";
import { onboardLocation } from "../../communities/locations";
import { addManualLink } from "../../connectors/manual-links";
import { CONNECTORS } from "../../connectors/registry";
import type { Connector, SourceType } from "../../connectors/types";
import { createRuntime } from "../../model/runtime";
import { startRun, tick, triggerStage } from "../../orchestration/orchestrator";
import { ensureJobIndexes } from "../../orchestration/jobs";
import { ensureRunIndexes, getRun } from "../../orchestration/runs";
import { LocalArtifacts } from "../../storage/artifacts";
import { COLLECTIONS } from "../../storage/mongo";
import { withMongo } from "../support/mongo";

const enabled = process.env.NEWSBEE_TEST_OLLAMA === "1";
// Opt-in live smoke: real Photon, publisher RSS, MongoDB, Ollama and local publication.
// Automatic sources are disabled so only the explicitly validated community feed runs.
const mongo = enabled ? withMongo() : null;
it.skipIf(!enabled)("publishes an uncataloged community through both editor gates using only local Ollama", async () => {
  const db = mongo!.db;
  const root = path.resolve(process.env.NEWSBEE_SMOKE_ROOT ?? ".local\\community-smoke");
  await mkdir(root, { recursive: true });
  const settings = loadSettings({ ...process.env, NEWSBEE_MODE: "local", NEWSBEE_ROOT: root, NEWSBEE_MODEL_PROVIDERS: "ollama",
    NEWSBEE_OLLAMA_MODEL: process.env.NEWSBEE_OLLAMA_MODEL ?? "qwen3:4b" });
  let modelCalls = 0;
  const transport: HttpTransport = async (request) => {
    if (request.method === "POST" && new URL(request.url).pathname === "/api/generate") modelCalls++;
    return fetchTransport(request);
  };
  const model = createRuntime(settings, transport, logger("community-smoke"));
  expect((await model.health()).status).toBe("ok");
  expect(settings.modelProviders.map((provider) => provider.kind)).toEqual(["ollama"]);
  await db.collection<{ _id: string; data: object }>("source_configs").insertOne({ _id: "communities", data: {} });
  const found = await searchGeography(db, "Wallingford, Seattle, Washington", transport);
  const place = found.find((result) => result.name === "Wallingford" && result.parent_name === "Seattle");
  expect(place).toBeDefined();
  // No reference directory is fabricated: absent branches remain a visible source gap.
  const location = await onboardLocation(db, transport, place!.id, { overrides: {}, discoverNews: async () =>
    ({ newsrooms: [], gaps: ["Smoke test uses an explicitly added, live community publisher feed."] }) });
  expect(location.community?.geography?.id).toBe(place!.id);
  const feed = await addManualLink(db, settings, location.id, {
    connector: "statenews", name: "Wallyhood (Wallingford community)", url: "https://www.wallyhood.org/feed/",
  }, transport);
  expect(feed.validated_events).toBeGreaterThan(0);
  await ensureJobIndexes(db);
  await ensureRunIndexes(db);
  const connectors = Object.fromEntries(Object.entries(CONNECTORS).map(([key, connector]) => [key, { ...connector, sources: () => [] }])) as Record<SourceType, Connector>;
  const deps = { db, settings, model, transport, connectors, store: new LocalArtifacts(root) };
  await db.collection(COLLECTIONS.outputChannels).insertOne({ _id: "community-smoke" as never, name: "Local community smoke",
    enabled: true, drive_folder_id: "channel", selected_location_ids: [location.id], published_location_ids: [] });
  const { run } = await startRun(deps, location.id, { kind: "manual", by: "local-smoke-editor" });
  for (let attempts = 0; attempts < 30; attempts++) {
    await tick(deps, { budgetMs: 300_000, concurrency: 1 });
    const current = (await getRun(db, run._id))!;
    if (current.status === "awaiting_authoring" || current.status === "awaiting_finish") {
      expect(await tick(deps)).toEqual({ executed: 0 });
      await triggerStage(deps, run._id, current.status === "awaiting_authoring" ? "authoring" : "finish", "local-smoke-editor");
    } else if (current.status === "published" || current.status === "failed") break;
    else if (current.last_error) throw new Error(current.last_error);
  }
  const final = await getRun(db, run._id);
  const evidence = { model: settings.modelProviders[0].model, model_calls: modelCalls, place, source: feed, run: final };
  await writeFile(path.join(root, "smoke-result.json"), JSON.stringify(evidence, null, 2));
  expect(modelCalls).toBeGreaterThan(0);
  expect(final?.status).toBe("published");
  expect(final?.sources.some((source) => source.event_count > 0)).toBe(true);
  expect(await db.collection(COLLECTIONS.editionEntries).countDocuments({})).toBeGreaterThan(0);
  console.info("COMMUNITY_SMOKE_RESULT", JSON.stringify({ model: evidence.model, model_calls: modelCalls, run_id: run._id, status: final?.status, artifacts: root }));
}, 900_000);
