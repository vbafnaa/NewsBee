import { auth, isAdminEmail, listConfiguredSources } from "@/auth";

export async function GET() {
  const session = await auth();
  if (!(await isAdminEmail(session?.user?.email))) {
    return Response.json(
      { detail: "Sign in as an authorized administrator" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const sources = await listConfiguredSources();
  return Response.json(
    { sources },
    { headers: { "Cache-Control": "no-store" } },
  );
}
