import { adminGuard } from "@/lib/admin-session";
import { loadSettings } from "@/pipeline/core/config";
import { driveFolderDetails, driveServiceAccountEmail, testDriveUpload } from "@/pipeline/storage/drive";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = await adminGuard(request);
  if (denied) return denied;
  const settings = loadSettings();
  let serviceAccountEmail: string | null = null;
  let identityError: string | null = null;
  let folder: Awaited<ReturnType<typeof driveFolderDetails>> | null = null;
  let folderError: string | null = null;
  if (settings.mode === "cloud") {
    try { serviceAccountEmail = driveServiceAccountEmail(); }
    catch (error) { identityError = error instanceof Error ? error.message : String(error); }
    if (settings.pipelineDriveFolderId && !identityError) {
      try { folder = await driveFolderDetails(settings.pipelineDriveFolderId); }
      catch (error) { folderError = error instanceof Error ? error.message : String(error); }
    }
  }
  return Response.json({
    mode: settings.mode,
    serviceAccountEmail,
    identityError,
    folderId: settings.pipelineDriveFolderId,
    folder,
    folderError,
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const denied = await adminGuard(request);
  if (denied) return denied;
  const settings = loadSettings();
  if (settings.mode !== "cloud" || !settings.pipelineDriveFolderId) {
    return Response.json({ detail: "Configure NEWSBEE_PIPELINE_DRIVE_FOLDER_ID in cloud mode first" }, { status: 400 });
  }
  try {
    return Response.json(await testDriveUpload(settings.pipelineDriveFolderId),
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ detail: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
