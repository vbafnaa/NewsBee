import { NextResponse } from "next/server";
import { operatorGuard } from "@/lib/admin-session";
import {
  CampaignLeadQueryError,
  listCampaignLeads,
  parseCampaignLeadFilters,
} from "@/pipeline/campaigns/leads";
import { getDatabase } from "@/pipeline/storage/mongo";

export async function GET(request: Request) {
  const denied = await operatorGuard(request);
  if (denied) return denied;
  try {
    const result = await listCampaignLeads(
      await getDatabase(),
      parseCampaignLeadFilters(new URL(request.url).searchParams),
    );
    return NextResponse.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof CampaignLeadQueryError) {
      return NextResponse.json({ detail: error.message }, { status: 400 });
    }
    throw error;
  }
}
