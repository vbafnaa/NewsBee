import { getMongoDatabase } from "@/auth";
import { adminGuard } from "@/lib/admin-session";
import { createSiteBackup, replaceSiteBackup, SITE_BACKUP_MAX_BYTES } from "@/pipeline/storage/site-backup";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  const denied = await adminGuard(request);
  if (denied) return denied;
  try {
    const backup = await createSiteBackup(await getMongoDatabase());
    const body = JSON.stringify(backup);
    if (Buffer.byteLength(body) > SITE_BACKUP_MAX_BYTES) {
      return Response.json({ detail: "The complete backup exceeds the 250 MB download limit." }, { status: 413 });
    }
    return new Response(body, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="newsbee-backup-${new Date().toISOString().slice(0, 10)}.json"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return Response.json({ detail: error instanceof Error ? error.message : "Could not create site backup." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const denied = await adminGuard(request);
  if (denied) return denied;
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > SITE_BACKUP_MAX_BYTES) {
    return Response.json({ detail: "The backup exceeds the 250 MB upload limit." }, { status: 413 });
  }
  try {
    const body = await request.text();
    if (Buffer.byteLength(body) > SITE_BACKUP_MAX_BYTES) {
      return Response.json({ detail: "The backup exceeds the 250 MB upload limit." }, { status: 413 });
    }
    let payload: unknown;
    try { payload = JSON.parse(body); }
    catch { return Response.json({ detail: "The uploaded file is not valid JSON." }, { status: 400 }); }
    if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      (payload as { confirm?: unknown }).confirm !== "REPLACE ALL SITE DATA") {
      return Response.json({ detail: 'Type "REPLACE ALL SITE DATA" in the confirmation field before importing.' }, { status: 400 });
    }
    const result = await replaceSiteBackup(await getMongoDatabase(), (payload as { archive?: unknown }).archive);
    return Response.json({ success: true, ...result }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Could not import site backup.";
    const status = /Unsupported backup|Backup |Archive |invalid |Invalid |maximum |match |Configure /.test(detail) ? 400 : 500;
    return Response.json({ detail }, { status, headers: { "Cache-Control": "private, no-store" } });
  }
}
