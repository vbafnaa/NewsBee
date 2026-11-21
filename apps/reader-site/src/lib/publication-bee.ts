import { createHash } from "node:crypto";
import type { BeePuzzle } from "../../../../shared/save-the-bee";
import { BeeError, type BeeGame, type BeeGameAccess } from "../../../journalist-site/pipeline/games/save-the-bee";
import { loadReaderPublication } from "./reader-data";
import { fetchPublicationPreview } from "./publication-preview";

function snapshotGame(scope: string[], puzzle: BeePuzzle, closesAt: number): BeeGame {
  return {
    _id: createHash("sha256").update(JSON.stringify(["publication-bee", ...scope])).digest("hex"),
    publication_id: scope[0],
    locationId: scope[0], editionId: scope[1], version: 1, revision: 0,
    ...puzzle, status: "published", closesAt, shoutouts: [], shoutoutsReviewed: true,
  };
}

export function publicationBeeAccess(request: Request, publicationId: string, releaseId: string,
  preview?: { draftId: string; revision: string | null }): BeeGameAccess {
  return async (at) => {
    if (preview) {
      const loaded = await fetchPublicationPreview(request, publicationId, preview.draftId, preview.revision);
      if (!loaded.snapshot.save_the_bee) throw new BeeError("Save the Bee is not included in this draft revision.", 404);
      const game = snapshotGame([publicationId, preview.draftId, String(loaded.snapshot.draft_revision), "preview"],
        loaded.snapshot.save_the_bee, Number.MAX_SAFE_INTEGER);
      return { game, rankedOpen: true };
    }
    const loaded = await loadReaderPublication(publicationId, releaseId);
    if (!loaded || loaded.entry.withdrawn || !loaded.release.save_the_bee) {
      throw new BeeError("Save the Bee is not available for this release.", 404);
    }
    const game = snapshotGame([publicationId, loaded.release.release_id], loaded.release.save_the_bee,
      loaded.release.published_at * 1000 + 7 * 86400_000);
    return { game, rankedOpen: loaded.manifest.latest?.release_id === loaded.release.release_id && at < game.closesAt! };
  };
}
