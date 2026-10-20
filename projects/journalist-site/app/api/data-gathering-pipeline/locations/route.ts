import { auth, isAdminEmail } from "@/auth";
import { readLocationIndex } from "@/data-gathering-pipeline/drive";

export const runtime = "nodejs";

export async function GET() {
  try {
    const session = await auth();
    if (!(await isAdminEmail(session?.user?.email))) {
      return Response.json({ detail: "Sign in as an authorized administrator" }, { status: 401 });
    }
    return Response.json({ locations: await readLocationIndex() }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("Pipeline location index could not be loaded", error);
    return Response.json({ detail: "Could not load locations.json from the shared pipeline Drive folder" }, { status: 503 });
  }
}
