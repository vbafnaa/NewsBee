import { currentAdmin } from "@/lib/admin-session";
import { listConfiguredSources } from "@/auth";

/** Legacy reviewed configuration is read-only; portal additions are validated, location-scoped links. */
export async function GET() {
  if (!(await currentAdmin())) return Response.json({ detail: "Sign in as an authorized administrator" }, { status: 401 });
  return Response.json({ sources: await listConfiguredSources() });
}
