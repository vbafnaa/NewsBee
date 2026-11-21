import { newsroomScopedRoute } from "@/lib/admin-api";
import { isDeployed, sourceRunsIsolated } from "@/pipeline/core/run-options";
import { resolveExecutionProviderPolicy, userDefaultOptions } from "@/pipeline/accounts/execution";

export const dynamic = "force-dynamic";

/** What the kick-off panel needs: the defaults, which paid services have keys (never the keys), and whether source runs are in test mode. */
export async function GET(request: Request) {
  return newsroomScopedRoute(request, async (deps, scope) => {
    // Journalists see the managed services of the newsroom they work from; operators as before.
    const policy = await resolveExecutionProviderPolicy(deps.db, deps.settings, deps.principal!,
      { kind: "platform", ...(scope.operator ? {} : { publicationId: scope.publicationId ?? undefined }) });
    deps = { ...deps, settings: policy.settings };
    const keys = deps.settings.integrations;
    const providers = deps.settings.modelProviders;
    return {
      defaults: userDefaultOptions(deps.settings),
      deployed: isDeployed(),
      // Test mode: a source map run keeps its results to itself (NEWSBEE_SOURCE_RUNS_ISOLATED).
      isolated: sourceRunsIsolated(),
      // While on, no edition reads a proposed source: only what a person accepted (NEWSBEE_PROPOSED_UNTIL_APPROVED).
      proposed_until_approved: deps.settings.proposedUntilApproved,
      credentialSource: policy.source,
      configured: {
        model: providers.some((provider) => provider.kind !== "ollama" && provider.apiKey && provider.model),
        tavily: Boolean(deps.settings.tavilySearchApiKey),
        serpapi: Boolean(keys.serpapiKey),
        searchapi: Boolean(keys.searchapiKey),
        brightdata: Boolean(keys.brightdataKey && keys.brightdataZone),
        brightdata_open: Boolean(keys.brightdataKey && keys.brightdataUnlockerZone),
        exa: Boolean(keys.exaKey),
        scrapingbee: Boolean(keys.scrapingbeeKey),
        jev: Boolean(keys.typesafeKey || keys.openrouterKey),
        agent_model: providers.some((provider) => provider.kind !== "ollama" && provider.apiKey && provider.model),
        attom: Boolean(keys.attomKey),
      },
      local_model: providers.some((provider) => provider.kind === "ollama"),
      vision_model: providers.some(provider => provider.vision === true || provider.kind === "gemini" && provider.vision !== false),
    };
  });
}
