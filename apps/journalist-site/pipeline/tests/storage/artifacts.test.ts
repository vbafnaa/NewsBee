import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactStore } from "../../storage/artifacts";
import { runFolder } from "../../storage/artifacts";

function driveStore(): ArtifactStore {
  return {
    kind: "drive",
    ensureFolder: vi.fn(async (parentId, name) => `${parentId}/${name}`),
    saveJson: vi.fn(async (parentId, name) => `${parentId}/${name}`),
    saveText: vi.fn(async (parentId, name) => `${parentId}/${name}`),
    readJson: vi.fn(),
    readText: vi.fn(),
    list: vi.fn(),
    findFolder: vi.fn(),
    removeFile: vi.fn(),
  };
}

describe("journalist Drive workspace", () => {
  beforeEach(() => {
    vi.stubEnv("NEWSBEE_PIPELINE_DRIVE_FOLDER_ID", "pipeline-root");
  });

  it("stores run artifacts directly beneath the configured Drive root", async () => {
    const store = driveStore();

    await expect(runFolder(store, "editions", "kent")).resolves.toBe(
      "pipeline-root/.newsbee-pipeline/editions/kent",
    );
  });

  it("requires the configured Drive root for cloud artifact storage", async () => {
    vi.stubEnv("NEWSBEE_PIPELINE_DRIVE_FOLDER_ID", "");

    await expect(runFolder(driveStore(), "editions", "kent")).rejects.toThrow(
      "NEWSBEE_PIPELINE_DRIVE_FOLDER_ID is not configured",
    );
  });
});
