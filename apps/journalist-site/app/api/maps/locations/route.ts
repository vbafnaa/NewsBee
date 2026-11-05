import { internalRoute } from "@/lib/admin-api";
import { COLLECTIONS } from "@/pipeline/storage/mongo";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return internalRoute(request, async ({ db }) => ({
    locations: (await db.collection<{ _id: string; name: string }>(COLLECTIONS.locations)
      .find({}, { projection: { _id: 1, name: 1 } }).sort({ name: 1 }).toArray())
      .map((location) => ({ id: location._id, name: location.name })),
  }));
}
