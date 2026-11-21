import { cache } from "react";
import type { Db } from "mongodb";
import { COLLECTIONS } from "@/pipeline/storage/mongo";
import { notFound } from "next/navigation";
import { pipelineDeps } from "@/lib/pipeline";
import { requireSignedInPrincipal } from "@/lib/portal-access";
import {
  listOutputChannelDirectory,
  resolveOutputChannelForPrincipal,
} from "@/pipeline/orchestration/output-channels";

/** The signed-in principal and the newsroom they opened, read once per request. */
export const loadNewsroom = cache(async (publicationId: string) => {
  const principal = await requireSignedInPrincipal();
  const db = (await pipelineDeps()).db;
  const [publications, access] = await Promise.all([
    listOutputChannelDirectory(db, principal),
    resolveOutputChannelForPrincipal(db, principal, publicationId, "Open a publication in the Newsroom support view"),
  ]);
  if (!access) notFound();
  return { principal, db, publications, access, publication: access.channel };
});

/** The communities a newsroom covers, by name, in coverage order. */
export async function newsroomCommunities(db: Db, locationIds: string[]) {
  if (!locationIds.length) return [];
  const rows = await db.collection<{ _id: string; name?: string }>(COLLECTIONS.locations)
    .find({ _id: { $in: locationIds } }, { projection: { name: 1 } }).toArray();
  const names = new Map(rows.map((row) => [row._id, row.name ?? row._id]));
  return locationIds.map((id) => ({ id, name: names.get(id) ?? id }));
}
