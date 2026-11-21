export type DiscoveryDisabledReason = "overpass_off" | "llm_off" | "attom_unconfigured";
export type DiscoveryOutcomeFields = { outcome?: "succeeded" | "failed" | "disabled"; reason?: DiscoveryDisabledReason };
type DiscoveryEvidence = DiscoveryOutcomeFields & { method?: string; never_run?: boolean; ok?: boolean; detail?: string };

const DISABLED_EXPLANATIONS: Record<DiscoveryDisabledReason, string> = {
  overpass_off: "Overpass (OpenStreetMap) was switched off for this run.",
  llm_off: "Model discovery was disabled in the saved configuration.",
  attom_unconfigured: "ATTOM discovery was unavailable because no key was configured.",
};
const LEGACY_OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const LEGACY_OVERPASS_ATTEMPTS = new Set(LEGACY_OVERPASS_ENDPOINTS.map((endpoint) => `${endpoint}: Error: overpass is switched off for this run`));

function disabledReason(state: DiscoveryEvidence): DiscoveryDisabledReason | null {
  if (state.outcome !== undefined) {
    return state.outcome === "disabled" && state.reason && Object.hasOwn(DISABLED_EXPLANATIONS, state.reason) ? state.reason : null;
  }
  if (state.detail === "LLM discovery is off (NEWSBEE_LLM_DISCOVERY)") return "llm_off";
  if (state.detail === "No ATTOM key set") return "attom_unconfigured";
  // Only the institutions producer saved this aggregate. Every endpoint must be an
  // exact policy denial; HTTP, cooldown, network and unknown attempts stay failures.
  const prefix = "Error: Overpass unavailable; ";
  if (state.method !== "institutions" || !state.detail?.startsWith(prefix)) return null;
  const attempts = state.detail.slice(prefix.length).split("; ");
  return attempts.length <= LEGACY_OVERPASS_ATTEMPTS.size
    && new Set(attempts).size === attempts.length
    && attempts.every((attempt) => LEGACY_OVERPASS_ATTEMPTS.has(attempt)) ? "overpass_off" : null;
}

export function discoveryDisabledExplanation(state: DiscoveryEvidence) {
  const reason = disabledReason(state);
  return reason ? DISABLED_EXPLANATIONS[reason] : null;
}

export const DISCOVERY_DISABLED_GUIDANCE = "Re-running does not enable a service. Review configuration and next-run settings before a deliberate refresh, or use eligible sources. This saved result does not establish current configuration.";

export function discoveryOutcome(state: DiscoveryEvidence) {
  if (state.never_run) return "not_attempted";
  if (disabledReason(state)) return "disabled";
  if (state.outcome !== undefined) return state.outcome === "succeeded" ? "succeeded" : "failed";
  return state.ok ? "succeeded" : "failed";
}
