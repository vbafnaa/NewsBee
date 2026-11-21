export const LOCATION_PREPARATION_STATES = ["available", "requested", "preparing", "ready", "blocked"] as const;
export type LocationPreparationState = typeof LOCATION_PREPARATION_STATES[number];
export type StoredLocationPreparationState = Extract<LocationPreparationState, "preparing" | "ready" | "blocked">;

export type LocationPreparation = {
  state: StoredLocationPreparationState;
  updated_at: string;
  updated_by: string;
  updated_by_email: string;
  reason: string | null;
};

export type LocationReadinessInput = {
  onboarded: boolean;
  demand: number;
  preparation?: Pick<LocationPreparation, "state"> | null;
  source_map_at?: number | null;
  source_coverage?: { status: "ready" | "partial" | "no_local_sources"; gaps?: string[] } | null;
  active_source_count?: number;
  published?: boolean;
};

export type LocationReadiness = {
  state: LocationPreparationState;
  ready: boolean;
  can_mark_ready: boolean;
  compatibility_ready: boolean;
  missing_prerequisites: string[];
  stored_state: StoredLocationPreparationState | null;
};

/** One readiness decision shared by the reader search and newsroom operations queue. */
export function calculateLocationReadiness(input: LocationReadinessInput): LocationReadiness {
  const missing: string[] = [];
  if (!input.onboarded) {
    missing.push("Onboard the location.");
  } else {
    // The count uses current eligible source-map evidence; coverage gaps and map-run dates are diagnostics.
    if ((input.active_source_count ?? 0) < 1) missing.push("Accept or resume at least one usable source in the location source map.");
  }
  const storedState = input.preparation?.state ?? null;
  const canMarkReady = input.onboarded && missing.length === 0;
  const compatibilityReady = Boolean(input.published && !storedState && canMarkReady);
  const ready = compatibilityReady || (storedState === "ready" && canMarkReady);
  const state: LocationPreparationState = ready ? "ready"
    : storedState === "blocked" ? "blocked"
      : input.onboarded ? "preparing"
        : input.demand > 0 ? "requested" : "available";
  return {
    state,
    ready,
    can_mark_ready: canMarkReady,
    compatibility_ready: compatibilityReady,
    missing_prerequisites: [...new Set(missing)],
    stored_state: storedState,
  };
}
