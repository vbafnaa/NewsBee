import type { Db } from "mongodb";
import { canAddAcceptedSources } from "../orchestration/map-stage-availability";
import { runs } from "../orchestration/runs";
import { locationSources, pageDecisions, pageKey, runSources, type SourceRecord } from "./store";

type SourceIdentity = Pick<SourceRecord, "location_id" | "source_id" | "url">;
type PartialSource = SourceRecord & { partial_run_id: string; location_name: string };

export async function sourceInventory(db: Db, locationId: string) {
  const live = await locationSources(db, locationId);
  const partial = await partialInventorySources(db, live, locationId);
  return [...live.map((source) => ({ ...source, partial_run_id: undefined })), ...partial];
}

export async function partialInventorySources(db: Db, live: SourceIdentity[], locationId?: string): Promise<PartialSource[]> {
  const history = await runs(db).find({
    ...(locationId ? { location_id: locationId } : {}),
    kind: "map", isolated: true,
    $or: [{ status: "failed" }, { "stage_transitions.2": { $exists: true } }, { status: "mapping", "stage_transitions.1": { $exists: true } }],
  }, { projection: { location_id: 1, location_name: 1, status: 1, isolated: 1, stage_transitions: 1 } }).sort({ created_at: -1, _id: -1 }).toArray();
  const idOf = (source: SourceIdentity) => `${source.location_id}:${source.source_id}`;
  const pageOf = (source: SourceIdentity) => `${source.location_id}:${pageKey(source)}`;
  const seenIds = new Set(live.map(idOf));
  const seenPages = new Set(live.map(pageOf));
  const sources: PartialSource[] = [];
  for (const run of history.filter(canAddAcceptedSources)) {
    const saved = await runSources(db, run._id).find({ location_id: run.location_id }).sort({ _id: 1 }).toArray();
    for (const source of saved) {
      const id = idOf(source), key = pageOf(source);
      if (seenIds.has(id) || seenPages.has(key)) continue;
      seenIds.add(id);
      seenPages.add(key);
      sources.push({ ...source, partial_run_id: run._id, location_name: run.location_name, status: "proposed", review: undefined });
    }
  }
  if (!sources.length) return sources;
  const decisions = await pageDecisions(db).find({ _id: { $in: sources.map(pageOf) } }).toArray();
  const byPage = new Map(decisions.map((decision) => [decision._id, decision]));
  for (const source of sources) {
    const decision = byPage.get(pageOf(source));
    if (!decision) continue;
    if (decision.decision === "reject") source.status = "rejected";
    source.review = {
      decision: decision.decision, reason_code: decision.reason_code, reason: decision.reason,
      by: decision.by, at: decision.at, initial_status: "proposed",
    };
  }
  return sources;
}
