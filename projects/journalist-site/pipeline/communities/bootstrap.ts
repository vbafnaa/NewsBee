import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { downloadCensusPlaces, importCensusPlaces } from "./census";
import { downloadLibraryDirectory, importLibraryDirectory } from "./directory";
import { fetchTransport, type HttpTransport } from "../core/http";
import { logger } from "../core/log";
import { COLLECTIONS } from "../storage/mongo";

const log = logger("communities.setup");
type SetupLease = { _id: string; owner: string; expires_at: number };

/** Load missing reference data once, with a cross-instance lease and explicit failure. */
export async function ensureDirectories(db: Db, transport: HttpTransport = fetchTransport) {
  const ready = async () => {
    const [place, system, outlet] = await Promise.all([
      db.collection(COLLECTIONS.places).findOne({}, { projection: { _id: 1 } }),
      db.collection(COLLECTIONS.libraryOutlets).findOne({ type: "system" }, { projection: { _id: 1 } }),
      db.collection(COLLECTIONS.libraryOutlets).findOne({ type: "outlet" }, { projection: { _id: 1 } }),
    ]);
    return { places: !!place, libraries: !!system && !!outlet };
  };
  const current = await ready();
  if (current.places && current.libraries) return;
  const leases = db.collection<SetupLease>(COLLECTIONS.directorySetup);
  const owner = randomUUID();
  const now = Date.now();
  try {
    const lease = await leases.findOneAndUpdate(
      { _id: "reference-directories", expires_at: { $lte: now } },
      { $set: { owner, expires_at: now + 300_000 } },
      { upsert: true, returnDocument: "after" },
    );
    if (lease?.owner !== owner) throw new Error("Location directory setup is already running. Please retry shortly.");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === 11000) {
      for (let attempt = 0; attempt < 240; attempt++) {
        const state = await ready();
        if (state.places && state.libraries) return;
        if (!(await leases.findOne({ _id: "reference-directories", expires_at: { $gt: Date.now() } }))) {
          throw new Error("Automatic location setup did not finish. Please retry the search.");
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw new Error("Automatic location setup is taking longer than expected. Please retry shortly.");
    }
    throw error;
  }
  try {
    const missing = await ready();
    log.info("reference_directory_setup_started", { census: !missing.places, libraries: !missing.libraries });
    if (!missing.places) await importCensusPlaces(db, await downloadCensusPlaces(transport));
    if (!missing.libraries) await importLibraryDirectory(db, await downloadLibraryDirectory(transport));
    log.info("reference_directory_setup_completed");
  } catch (error) {
    log.error("reference_directory_setup_failed", { error: String(error) });
    throw error;
  } finally {
    await leases.deleteOne({ _id: "reference-directories", owner });
  }
}
