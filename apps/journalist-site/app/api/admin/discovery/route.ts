import { adminRoute, jsonBody } from "@/lib/admin-api";
import { getLocation, listLocations } from "@/pipeline/communities/locations";
import { Fetcher } from "@/pipeline/connectors/fetcher";
import { fetchTransport } from "@/pipeline/core/http";
import { publicOnlyTransport } from "@/pipeline/connectors/public-http";
import { logger } from "@/pipeline/core/log";
import { localToday } from "@/pipeline/core/time";
import { locationDiscovery, runMethod } from "@/pipeline/discovery/run";
import { withModelUsageContext } from "@/pipeline/model/runtime";
import { personalRequestDeps } from "@/pipeline/accounts/runtime";
import { resolveRunOptions, withRunContext } from "@/pipeline/core/run-options";
import { randomUUID } from "node:crypto";
import { ExecutionBlocked } from "@/pipeline/core/execution-errors";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Every location's discovery methods: last run, sources found and kept, errors, when due. */
export async function GET(request: Request) {
  return adminRoute(request, async ({ db }) => {
    const locations = await listLocations(db);
    return { locations: await Promise.all(locations.map(async (location) => ({ location_id: location.id, location_name: location.name, methods: await locationDiscovery(db, location.id) }))) };
  });
}

/** Run one discovery method now: { location_id, method }. */
export async function POST(request: Request) {
  return adminRoute(request, async (deps) => {
    const body = await jsonBody<{ location_id?: unknown; method?: unknown; options?: unknown }>(request);
    if (typeof body.location_id !== "string" || typeof body.method !== "string") throw new Error("Invalid request: send location_id and method");
    const options = body.options === undefined ? undefined : resolveRunOptions(body.options);
    const personal = await personalRequestDeps(deps, deps.principal!, options, body.method === "dork", body.method === "llm");
    if (body.method === "homesales" && !personal.settings.integrations.attomKey) throw new ExecutionBlocked("Add your ATTOM API key in Environment & API settings to discover home sales.");
    deps = personal;
    const location = await getLocation(deps.db, body.location_id);
    const method = body.method;
    const transport = deps.transport ?? publicOnlyTransport(fetchTransport);
    const operationId = `discovery:${randomUUID()}`;
    return { state: await withRunContext({ db: deps.db, runId: operationId, locationId: location.id, sponsorId: deps.principal!.id, credentialVersion: personal.credentialVersion, options: personal.requestOptions, runKind: "map", startedAt: Date.now() / 1000 },
      () => withModelUsageContext({ location_id: location.id, sponsor_id: deps.principal!.id, credential_version: personal.credentialVersion },
        () => runMethod({ db: deps.db, settings: deps.settings, transport, fetcher: new Fetcher(transport), location, today: localToday(location.state), log: logger(`discovery.${method}`), model: deps.discoveryModel ?? deps.lightModel ?? null }, method))) };
  });
}
