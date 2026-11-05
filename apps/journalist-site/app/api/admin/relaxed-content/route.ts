import { adminRoute } from "@/lib/admin-api";
import { COLLECTED_ITEMS } from "@/pipeline/editions/assemble";
import { ITEM_TEXTS } from "@/pipeline/editions/details";
import { sourceMap } from "@/pipeline/sourcemap/store";

export const dynamic = "force-dynamic";

/** Deletes everything collected by skipping an access rule: stored text, items and proposed sources. */
export async function DELETE(request: Request) {
  return adminRoute(request, async ({ db }) => {
    const texts = await db.collection(ITEM_TEXTS).deleteMany({ relaxed: true });
    const items = await db.collection(COLLECTED_ITEMS).deleteMany({ "access_overrides.0": { $exists: true } });
    const sources = await sourceMap(db).deleteMany({ status: "proposed", "access_overrides.0": { $exists: true } });
    return { texts: texts.deletedCount, items: items.deletedCount, sources: sources.deletedCount };
  });
}
