import { adminRoute } from "@/lib/admin-api";
import { INTAKE_KINDS, INTAKE_STATUSES, CommunityIntakeError } from "../../../../../../shared/community-intake";
import { listCommunityIntake, reviewCommunityIntake } from "../../../../../reader-site/src/lib/community-intake-storage";

export const dynamic = "force-dynamic";

/** Private contact and editor-interest records; public submissions never grant access. */
export async function GET(request: Request) {
  return adminRoute(request, async ({ db }) => {
    const params = new URL(request.url).searchParams;
    const kind = params.get("kind") ?? "all", status = params.get("status") ?? "pending";
    const pageValue = params.get("page") ?? "1";
    if ((kind !== "all" && !INTAKE_KINDS.includes(kind as never)) || (status !== "all" && !INTAKE_STATUSES.includes(status as never))
      || !/^[1-9]\d{0,3}$/.test(pageValue)) {
      return Response.json({ detail: "Choose a valid inquiry filter and page." }, { status: 422 });
    }
    return listCommunityIntake(db, {
      kind: kind === "all" ? undefined : kind as typeof INTAKE_KINDS[number],
      status: status === "all" ? undefined : status as typeof INTAKE_STATUSES[number], page: Number(pageValue),
    });
  });
}

export async function POST(request: Request) {
  return adminRoute(request, async ({ db, principal }) => {
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ detail: "Send a review decision." }, { status: 400 });
    const raw = body as Record<string, unknown>;
    if (typeof raw.id !== "string" || !INTAKE_STATUSES.includes(raw.status as never)
      || (raw.note !== undefined && typeof raw.note !== "string")) {
      return Response.json({ detail: "Send an inquiry ID, review status, and optional note." }, { status: 422 });
    }
    try {
      return { item: await reviewCommunityIntake(db, raw.id, raw.status as typeof INTAKE_STATUSES[number], typeof raw.note === "string" ? raw.note : "", principal!.email) };
    } catch (error) {
      if (error instanceof CommunityIntakeError) return Response.json({ detail: error.message }, { status: error.status });
      throw error;
    }
  });
}
