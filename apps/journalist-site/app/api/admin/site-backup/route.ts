import { getMongoDatabase } from "@/auth";
import { currentPrincipal, currentRestoreGeneration, ownerGuard } from "@/lib/admin-session";
import { backupStream, backupTextChunks } from "@/lib/site-backup-response";
import { BACKUP_STREAM_TYPE } from "@/lib/site-backup-transfer";
import { createSiteBackup, replaceSiteBackup, SITE_BACKUP_MAX_BYTES } from "@/pipeline/storage/site-backup";
import { deleteBackupUpload, readBackupUpload } from "@/pipeline/storage/site-backup-upload";
import {
  enterMaintenance, maintenanceState, MaintenanceError, readRestoreEvidence, reopenMaintenance, restoreDatabase,
} from "../../../../../../shared/restore-maintenance";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  const denied = await ownerGuard(request);
  if (denied) return denied;
  if (new URL(request.url).searchParams.has("maintenance")) {
    const db = await getMongoDatabase();
    const state = await maintenanceState(db);
    const evidence = await readRestoreEvidence(db);
    return Response.json({ ...state, evidence }, { headers: { "Cache-Control": "private, no-store" } });
  }
  if (request.headers.get("accept")?.includes(BACKUP_STREAM_TYPE)) {
    return backupStream(request, async (options, emit) => {
      const backup = await createSiteBackup(await getMongoDatabase(), options);
      const body = JSON.stringify(backup);
      if (Buffer.byteLength(body) > SITE_BACKUP_MAX_BYTES) throw new Error("The complete backup exceeds the 250 MB download limit.");
      options.signal?.throwIfAborted();
      options.onProgress?.("Transferring the complete backup...");
      for (const data of backupTextChunks(body)) emit({ type: "chunk", data });
      emit({ type: "complete" });
    });
  }
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
  const denied = await ownerGuard(request);
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
    const owner = await currentPrincipal();
    if (!owner) return Response.json({ detail: "Sign in again before importing a backup." }, { status: 401 });
    const expectedIdentityGeneration = await currentRestoreGeneration();
    const action = (payload as { maintenance?: unknown } | null)?.maintenance;
    if (action === "close" || action === "open") {
      const db = await getMongoDatabase();
      if (action === "close") await enterMaintenance(db, owner);
      else await reopenMaintenance(db, owner);
      return Response.json(await maintenanceState(db), { headers: { "Cache-Control": "private, no-store" } });
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      (payload as { confirm?: unknown }).confirm !== "REPLACE ALL SITE DATA") {
      return Response.json({ detail: 'Type "REPLACE ALL SITE DATA" in the confirmation field before importing.' }, { status: 400 });
    }
    const governanceConfirmation = (payload as { governanceConfirmation?: unknown }).governanceConfirmation;
    if (governanceConfirmation !== "ROLL BACK ACCOUNTS AND GOVERNANCE") {
      return Response.json({ detail: "Separately confirm rollback of accounts, roles, credentials, publications and audit history." }, { status: 400 });
    }
    if (request.headers.get("accept")?.includes(BACKUP_STREAM_TYPE)) {
      const uploadId = (payload as { uploadId?: unknown }).uploadId;
      if (typeof uploadId !== "string") return Response.json({ detail: "Upload the backup file before importing." }, { status: 400 });
      return backupStream(request, async (options, emit) => {
        const db = await getMongoDatabase();
        const archive = await readBackupUpload(restoreDatabase(db), owner.email, uploadId);
        options.signal?.throwIfAborted();
        const result = await replaceSiteBackup(db, archive, { ...options, owner, governanceConfirmation, expectedIdentityGeneration });
        options.signal?.throwIfAborted();
        await deleteBackupUpload(restoreDatabase(db), owner.email, uploadId);
        emit({ type: "complete", result });
      });
    }
    const result = await replaceSiteBackup(await getMongoDatabase(), (payload as { archive?: unknown }).archive, {
      owner, governanceConfirmation, expectedIdentityGeneration,
    });
    return Response.json({ success: true, ...result }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Could not import site backup.";
    const status = error instanceof MaintenanceError ? 503
      : /Unsupported backup|Backup |Archive |invalid |Invalid |maximum |match |Configure /.test(detail) ? 400 : 500;
    return Response.json({ detail }, { status, headers: { "Cache-Control": "private, no-store" } });
  }
}
