import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/admin-session", () => ({ adminGuard: vi.fn() }));
vi.mock("@/pipeline/core/config", () => ({ loadSettings: vi.fn() }));
vi.mock("@/pipeline/storage/drive", () => ({
  driveServiceAccountEmail: vi.fn(), driveFolderDetails: vi.fn(), testDriveUpload: vi.fn(),
}));

import { adminGuard } from "@/lib/admin-session";
import { loadSettings } from "@/pipeline/core/config";
import { driveServiceAccountEmail, driveFolderDetails, testDriveUpload } from "@/pipeline/storage/drive";
import { GET, POST } from "@/app/api/admin/drive-diagnostics/route";

describe("admin Drive diagnostics", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(adminGuard).mockResolvedValue(null);
    vi.mocked(loadSettings).mockReturnValue({ mode: "cloud", pipelineDriveFolderId: "pipeline-folder-123" } as never);
    vi.mocked(driveServiceAccountEmail).mockReturnValue("writer@example.iam.gserviceaccount.com");
    vi.mocked(driveFolderDetails).mockResolvedValue({ id: "pipeline-folder-123", name: "Pipeline" });
    vi.mocked(testDriveUpload).mockResolvedValue({ uploaded: false, error: "Google Drive file upload failed (403)", cleanupError: null });
  });

  it("never reveals account or folder data to an unauthenticated request", async () => {
    vi.mocked(adminGuard).mockResolvedValue(Response.json({ detail: "Unauthorized" }, { status: 401 }));
    expect((await GET(new Request("https://portal.example/api/admin/drive-diagnostics"))).status).toBe(401);
    expect((await POST(new Request("https://portal.example/api/admin/drive-diagnostics", { method: "POST" }))).status).toBe(401);
    expect(loadSettings).not.toHaveBeenCalled();
    expect(testDriveUpload).not.toHaveBeenCalled();
  });

  it("reports the active identity and folder, then returns the upload failure and cleanup result", async () => {
    const url = "https://portal.example/api/admin/drive-diagnostics";
    const info = await GET(new Request(url));
    expect(info.headers.get("Cache-Control")).toBe("no-store");
    expect(await info.json()).toMatchObject({
      serviceAccountEmail: "writer@example.iam.gserviceaccount.com",
      folderId: "pipeline-folder-123", folder: { name: "Pipeline" },
    });
    const trial = await POST(new Request(url, { method: "POST" }));
    expect(await trial.json()).toMatchObject({ uploaded: false, error: "Google Drive file upload failed (403)", cleanupError: null });
    expect(testDriveUpload).toHaveBeenCalledWith("pipeline-folder-123");
  });
});
