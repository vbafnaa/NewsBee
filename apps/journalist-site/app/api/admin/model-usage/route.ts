import { adminRoute } from "@/lib/admin-api";
import { lightSettings } from "@/pipeline/core/config";
import { detailedModelUsage, modelPriceOverrides } from "@/pipeline/model/usage";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return adminRoute(request, async ({ db, settings }) => {
    const params = new URL(request.url).searchParams;
    const days = Number(params.get("days") ?? "7");
    if (days !== 1 && days !== 7 && days !== 30) return Response.json({ detail: "Choose a 1, 7 or 30 day usage window." }, { status: 400 });
    const location = params.get("location") || undefined;
    if (location && location.length > 200) return Response.json({ detail: "Invalid location filter." }, { status: 400 });
    const providers = [...settings.modelProviders, ...lightSettings(settings).modelProviders];
    return Response.json(await detailedModelUsage(db, providers, {
      days, location, prices: modelPriceOverrides(process.env.NEWSBEE_MODEL_PRICING),
    }), { headers: { "Cache-Control": "private, no-store" } });
  });
}
