import { adminRoute } from "@/lib/admin-api";
import { defaultRunOptions, isDeployed } from "@/pipeline/core/run-options";

export const dynamic = "force-dynamic";

/** What the kick-off panel needs: the defaults, and which paid services have keys. Never the keys. */
export async function GET(request: Request) {
  return adminRoute(request, async (deps) => {
    const keys = deps.settings.integrations;
    const providers = deps.settings.modelProviders;
    return {
      defaults: defaultRunOptions(),
      deployed: isDeployed(),
      configured: {
        gemini: providers.some((provider) => provider.kind === "gemini" && provider.apiKey),
        openai_compatible: providers.some((provider) => provider.kind === "openai"),
        tavily: Boolean(deps.settings.tavilySearchApiKey),
        serpapi: Boolean(keys.serpapiKey),
        searchapi: Boolean(keys.searchapiKey),
        brightdata: Boolean(keys.brightdataKey && keys.brightdataZone),
        exa: Boolean(keys.exaKey),
        scrapingbee: Boolean(keys.scrapingbeeKey),
        jev: Boolean(keys.typesafeKey || keys.openrouterKey),
        agent_model: providers.some((provider) => provider.kind !== "ollama" && (provider.apiKey || provider.kind === "openai")),
        attom: Boolean(keys.attomKey),
      },
      local_model: providers.some((provider) => provider.kind === "ollama"),
    };
  });
}
