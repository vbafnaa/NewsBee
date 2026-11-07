import { adminRoute } from "@/lib/admin-api";
import { isDeployed } from "@/pipeline/core/run-options";
import { effectiveCredentialProfile } from "@/pipeline/accounts/credentials";
import { personalSettings, userDefaultOptions } from "@/pipeline/accounts/execution";

export const dynamic = "force-dynamic";

/** What the kick-off panel needs: the defaults, and which paid services have keys. Never the keys. */
export async function GET(request: Request) {
  return adminRoute(request, async (deps) => {
    const profile = await effectiveCredentialProfile(deps.db, deps.principal!);
    if (profile && !profile.revoked) deps = { ...deps, settings: personalSettings(deps.settings, deps.principal!, profile) };
    const keys = deps.settings.integrations;
    const providers = deps.settings.modelProviders;
    return {
      defaults: userDefaultOptions(deps.settings),
      deployed: isDeployed(),
      credentialSource: profile?.source ?? "personal",
      configured: {
        gemini: providers.some((provider) => provider.kind === "gemini" && provider.apiKey),
        openai_compatible: providers.some((provider) => provider.kind === "openai" && provider.apiKey),
        tavily: Boolean(deps.settings.tavilySearchApiKey),
        serpapi: Boolean(keys.serpapiKey),
        searchapi: Boolean(keys.searchapiKey),
        brightdata: Boolean(keys.brightdataKey && keys.brightdataZone),
        exa: Boolean(keys.exaKey),
        scrapingbee: Boolean(keys.scrapingbeeKey),
        jev: Boolean(keys.typesafeKey || keys.openrouterKey),
        agent_model: providers.some((provider) => provider.kind !== "ollama" && provider.apiKey),
        attom: Boolean(keys.attomKey),
      },
      local_model: providers.some((provider) => provider.kind === "ollama"),
    };
  });
}
