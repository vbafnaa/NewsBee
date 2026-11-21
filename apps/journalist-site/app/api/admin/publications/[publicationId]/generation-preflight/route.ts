import { publicationRoute } from "@/lib/admin-api";
import { resolveOutputChannelForPrincipal } from "@/pipeline/orchestration/output-channels";
import { callsToday, modelBudget, startOfDay } from "@/pipeline/model/budget";
import { capabilityReasons, resolveExecutionProviderPolicy, sharedGenerationAvailability, userDefaultOptions } from "@/pipeline/accounts/execution";
import { resolveRunOptions } from "@/pipeline/core/run-options";

type Context = { params: Promise<{ publicationId: string }> };

export async function GET(request: Request, context: Context) {
  const { publicationId } = await context.params;
  return publicationRoute(request, async (deps) => {
    const access = await resolveOutputChannelForPrincipal(
      deps.db, deps.principal!, publicationId, "Review generation funding and allowance",
    );
    if (!access) return Response.json({ detail: "Publication was not found." }, { status: 404 });
    const policy = await resolveExecutionProviderPolicy(deps.db, deps.settings, deps.principal!, { kind: "platform", publicationId });
    const input = new URL(request.url).searchParams.get("options");
    const options = input ? resolveRunOptions(JSON.parse(input)) : userDefaultOptions(policy.settings);
    const reasons = capabilityReasons(policy.settings, options, options.flow === "agentic", { source: policy.source });
    const allowance = policy.source === "platform" ? await modelBudget(deps.db, policy.settings) : null;
    const used = allowance ? 0 : (await callsToday(deps.db, { funding: policy.source, initiatorId: policy.principal.id })).total;
    const remaining = allowance?.remaining ?? Math.max(0, policy.settings.modelDailyCalls - used);
    const admission = await sharedGenerationAvailability(deps.db);
    return {
      remaining, exhausted: allowance?.exhausted ?? remaining === 0,
      resetsAt: allowance?.resets_at ?? startOfDay() + 86400,
      source: policy.source, reasons, admission,
    };
  });
}
