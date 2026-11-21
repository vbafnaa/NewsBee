export class ExecutionBlocked extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionBlocked";
  }

}

export function executionBlock(error: unknown) {
  const details = error as { code?: string; scope?: string; resets_at?: number; cap?: number } | null;
  return {
    reason: error instanceof Error ? error.message : String(error),
    at: Date.now() / 1000,
    ...(typeof details?.code === "string" ? { code: details.code } : {}),
    ...(typeof details?.scope === "string" ? { scope: details.scope } : {}),
    ...(typeof details?.resets_at === "number" ? { resets_at: details.resets_at } : {}),
    ...(typeof details?.cap === "number" ? { cap: details.cap } : {}),
  };
}
