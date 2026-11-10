import { adminRoute } from "@/lib/admin-api";
import { getLocation } from "@/pipeline/communities/locations";
import { importPhotoCatalog, listPhotoCatalog } from "@/pipeline/images/catalog";

type Context = { params: Promise<{ locationId: string }> };
export const dynamic = "force-dynamic";

async function readManifest(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Invalid photo catalog: missing request body");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 256 * 1024) {
        await reader.cancel();
        throw new Error("Invalid photo catalog: request exceeds 256 KiB");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new Error("Invalid photo catalog: malformed JSON"); }
}

export async function GET(request: Request, context: Context) {
  const { locationId } = await context.params;
  const response = await adminRoute(request, async ({ db }) => {
    await getLocation(db, locationId, true);
    return { location_id: locationId, sources: await listPhotoCatalog(db, locationId) };
  });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export async function POST(request: Request, context: Context) {
  const { locationId } = await context.params;
  const response = await adminRoute(request, async ({ db }) => {
    await getLocation(db, locationId, true);
    const manifest = await readManifest(request);
    return importPhotoCatalog(db, manifest, locationId, new URL(request.url).searchParams.get("apply") === "true");
  });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
