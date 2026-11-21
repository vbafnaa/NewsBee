import { operatorGuard } from "@/lib/admin-session";
import {
  campaignLeadCsv,
  CampaignLeadQueryError,
  parseCampaignLeadFilters,
} from "@/pipeline/campaigns/leads";
import { getDatabase } from "@/pipeline/storage/mongo";

export async function GET(request: Request) {
  const denied = await operatorGuard(request);
  if (denied) return denied;
  try {
    const filters = parseCampaignLeadFilters(new URL(request.url).searchParams);
    const csv = await campaignLeadCsv(await getDatabase(), { ...filters, page: 1 });
    return new Response(csv, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": 'attachment; filename="newsbee-campaign-leads.csv"',
        "Content-Type": "text/csv; charset=utf-8",
      },
    });
  } catch (error) {
    if (error instanceof CampaignLeadQueryError) {
      return Response.json({ detail: error.message }, { status: 400 });
    }
    throw error;
  }
}
