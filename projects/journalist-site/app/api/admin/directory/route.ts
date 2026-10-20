import { adminRoute } from "@/lib/admin-api";
import { downloadCensusPlaces, importCensusPlaces } from "@/pipeline/communities/census";
import { downloadLibraryDirectory, importLibraryDirectory } from "@/pipeline/communities/directory";
import { fetchTransport } from "@/pipeline/core/http";
import { logger } from "@/pipeline/core/log";
import { COLLECTIONS } from "@/pipeline/storage/mongo";

export const maxDuration = 300;

/** How many Census places and IMLS library outlets are loaded for onboarding search. */
export async function GET(request: Request) {
  return adminRoute(request, async ({ db }) => ({
    places: await db.collection(COLLECTIONS.places).countDocuments(),
    library_outlets: await db.collection(COLLECTIONS.libraryOutlets).countDocuments({ type: "outlet" }),
  }));
}

/** Download and import the Census incorporated places and the IMLS public library directory. */
export async function POST(request: Request) {
  return adminRoute(request, async ({ db }) => {
    const log = logger("directory");
    const census = await importCensusPlaces(db, await downloadCensusPlaces(fetchTransport));
    log.info("census_places_imported", census);
    const libraries = await importLibraryDirectory(db, await downloadLibraryDirectory(fetchTransport));
    log.info("library_directory_imported", libraries);
    return { census, libraries };
  });
}
