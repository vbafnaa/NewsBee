import { adminRoute, jsonBody } from "@/lib/admin-api";
import { listLocations, onboardLocation } from "@/pipeline/communities/locations";
import { discoverGovernment, overrides } from "@/pipeline/connectors/meetings/discovery";
import { fetchTransport } from "@/pipeline/core/http";
import { ensureDirectories } from "@/pipeline/communities/bootstrap";

export const maxDuration = 300;

export async function GET(request: Request) {
  return adminRoute(request, async ({ db }) => ({ locations: await listLocations(db) }));
}

/** Onboard a Census place: find its libraries and local government, then save its profile. */
export async function POST(request: Request) {
  return adminRoute(request, async ({ db, settings }) => {
    const body = await jsonBody<{ place_id?: unknown }>(request);
    if (typeof body.place_id !== "string" || !body.place_id) throw new Error("Invalid place_id");
    await ensureDirectories(db);
    const governmentOverrides = await overrides(settings.root, db);
    return {
      location: await onboardLocation(db, fetchTransport, body.place_id, {
        settings,
        discoverGovernment: (profile) => discoverGovernment(fetchTransport, profile, governmentOverrides[profile.id] ?? null),
      }),
    };
  });
}
