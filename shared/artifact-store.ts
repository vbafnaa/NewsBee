/** MongoDB collection that holds editions and run artifacts when NEWSBEE_ARTIFACT_STORE=mongo. */
export const ARTIFACTS_COLLECTION = "artifacts";

/** Deployments without a Google Shared drive keep editions in MongoDB; both apps read this. */
export function usesMongoArtifacts(env: Record<string, string | undefined> = process.env) {
  return env.NEWSBEE_ARTIFACT_STORE?.trim().toLowerCase() === "mongo";
}
