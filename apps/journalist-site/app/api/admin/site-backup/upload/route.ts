import { getMongoDatabase } from "@/auth";
import { currentAdmin, ownerGuard } from "@/lib/admin-session";
import { boundedJson } from "@/lib/bounded-json";
import { BACKUP_CHUNK_BYTES } from "@/lib/site-backup-transfer";
import { deleteBackupUpload, saveBackupChunk, startBackupUpload } from "@/pipeline/storage/site-backup-upload";
import { restoreDatabase } from "../../../../../../../shared/restore-maintenance";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(request: Request, action: (db: Awaited<ReturnType<typeof getMongoDatabase>>, owner: string) => Promise<Response>) {
  const denied = await ownerGuard(request);
  if (denied) return denied;
  const owner = await currentAdmin();
  if (!owner) return Response.json({ detail: "Sign in again before uploading a backup." }, { status: 401 });
  try { return await action(restoreDatabase(await getMongoDatabase()), owner); }
  catch (error) {
    const detail = error instanceof Error ? error.message : "Backup upload failed.";
    return Response.json({ detail },
      { status: /Invalid |Backup upload /.test(detail) ? 400 : 500, headers: { "Cache-Control": "private, no-store" } });
  }
}

export async function POST(request: Request) {
  return handle(request, async (db, owner) => {
    const body = await boundedJson(request);
    if (!body || typeof body !== "object" || !("bytes" in body) || typeof body.bytes !== "number") {
      throw new Error("Invalid backup file size.");
    }
    return Response.json(await startBackupUpload(db, owner, body.bytes), { headers: { "Cache-Control": "private, no-store" } });
  });
}

export async function PUT(request: Request) {
  return handle(request, async (db, owner) => {
    const url = new URL(request.url);
    const id = url.searchParams.get("id") ?? "";
    const rawPart = url.searchParams.get("part");
    const part = rawPart === null ? NaN : Number(rawPart);
    const reader = request.body?.getReader();
    if (!reader) throw new Error("Invalid backup chunk: missing body.");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > BACKUP_CHUNK_BYTES) {
          await reader.cancel();
          throw new Error("Invalid backup chunk: exceeds the 1 MB limit.");
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    await saveBackupChunk(db, owner, id, part, Buffer.concat(chunks));
    return Response.json({ success: true });
  });
}

export async function DELETE(request: Request) {
  return handle(request, async (db, owner) => {
    await deleteBackupUpload(db, owner, new URL(request.url).searchParams.get("id") ?? "");
    return Response.json({ success: true });
  });
}
