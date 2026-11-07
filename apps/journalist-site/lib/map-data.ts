import type { Db } from "mongodb";
import { getLocation } from "@/pipeline/communities/locations";
import { locationDiscovery } from "@/pipeline/discovery/run";
import { sourceMap, locationSources, METHOD_LABELS, type SourceRecord } from "@/pipeline/sourcemap/store";
import { SECTIONS } from "@/pipeline/sourcemap/sections";
import { CONNECTORS, windowOf } from "@/pipeline/connectors/registry";
import { describeWindow } from "@/pipeline/sourcemap/windows";

/** Source review never returns connector parameters, which can contain private configuration. */
/** Password-only viewers share one login, so reviewers' email addresses are left out. */
export async function sourceInventory(db: Db, locationId?: string) {
  if (!locationId) {
    const sources = await sourceMap(db).aggregate<Omit<SourceRecord, "params"> & { location_name: string }>([
      { $lookup: { from: "locations", localField: "location_id", foreignField: "_id", as: "location" } },
      { $set: { location_name: { $ifNull: [{ $arrayElemAt: ["$location.name", 0] }, "$location_id"] } } },
      { $project: { location: 0, params: 0, "review.by": 0 } },
      { $sort: { location_name: 1, section: 1, name: 1 } },
    ]).toArray();
    return { sections: SECTIONS, sources: sources.map((source) => ({
      ...source, found_by_label: METHOD_LABELS[source.found_by.method] ?? source.found_by.method, window_label: null,
    })), discovery: [] };
  }
  await getLocation(db, locationId);
  const sources = (await locationSources(db, locationId)).map(({ params, ...source }) => {
    const connector = CONNECTORS[source.reader];
    return { ...source, ...(source.review ? { review: { ...source.review, by: undefined } } : {}), found_by_label: METHOD_LABELS[source.found_by.method] ?? source.found_by.method,
      window_label: connector ? describeWindow(windowOf(connector, { type: source.reader, source_id: source.source_id, name: source.name, params: { ...params, ...(source.window ? { window: source.window } : {}) } })) : null };
  });
  return { sections: SECTIONS, sources, discovery: await locationDiscovery(db, locationId) };
}
