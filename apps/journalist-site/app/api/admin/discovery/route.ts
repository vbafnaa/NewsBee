import { adminRoute, jsonBody } from "@/lib/admin-api";
import { getLocation, listLocations } from "@/pipeline/communities/locations";
import { Fetcher } from "@/pipeline/connectors/fetcher";
import { fetchTransport } from "@/pipeline/core/http";
import { publicOnlyTransport } from "@/pipeline/connectors/public-http";
import { logger } from "@/pipeline/core/log";
import { localToday } from "@/pipeline/core/time";
import { locationDiscovery, runMethod } from "@/pipeline/discovery/run";
import { withModelUsageContext } from "@/pipeline/model/runtime";

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
    const body = await jsonBody<{ location_id?: unknown; method?: unknown }>(request);
    if (typeof body.location_id !== "string" || typeof body.method !== "string") throw new Error("Invalid request: send location_id and method");
    const location = await getLocation(deps.db, body.location_id);
    const method = body.method;
    const transport = deps.transport ?? publicOnlyTransport(fetchTransport);
    return { state: await withModelUsageContext({ location_id: location.id }, () => runMethod({ db: deps.db, settings: deps.settings, transport, fetcher: new Fetcher(transport), location, today: localToday(location.state), log: logger(`discovery.${method}`), model: deps.discoveryModel ?? deps.lightModel ?? null }, method)) };
  });
}
