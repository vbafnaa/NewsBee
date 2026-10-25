import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactStore } from "../../storage/artifacts";
import { runFolder } from "../../storage/artifacts";
import { createChannelFolder, readerDriveFolderId } from "../../orchestration/publish";

function driveStore(): ArtifactStore {
  return {
    kind: "drive",
    ensureFolder: vi.fn(async (parentId, name) => `${parentId}/${name}`),
    saveJson: vi.fn(async (parentId, name) => `${parentId}/${name}`),
    saveText: vi.fn(async (parentId, name) => `${parentId}/${name}`),
    readJson: vi.fn(),
    readText: vi.fn(),
    list: vi.fn(),
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

  it("creates output channels beneath the configured Drive root", async () => {
    const store = driveStore();

    await expect(createChannelFolder(store, "pipeline-root", "reader-site")).resolves.toBe(
      "pipeline-root/output-channels/reader-site",
    );
    expect(store.saveJson).toHaveBeenCalledWith(
      "pipeline-root/output-channels/reader-site",
      "locations.json",
      { locations: [] },
    );
    expect(store.ensureFolder).not.toHaveBeenCalledWith("pipeline-root", "newsbee");
  });

  it("requires the configured Drive root for cloud artifact storage", async () => {
    vi.stubEnv("NEWSBEE_PIPELINE_DRIVE_FOLDER_ID", "");

    await expect(runFolder(driveStore(), "editions", "kent")).rejects.toThrow(
      "NEWSBEE_PIPELINE_DRIVE_FOLDER_ID is not configured",
    );
  });
});

describe("default reader channel folder", () => {
  it("uses the configured folder for a new deployment", () => {
    expect(readerDriveFolderId({ NEWSBEE_READER_DRIVE_FOLDER_ID: " abc_DEF-123 " })).toBe("abc_DEF-123");
  });
  it("rejects a value that is not a Drive folder ID", () => {
    expect(() => readerDriveFolderId({ NEWSBEE_READER_DRIVE_FOLDER_ID: "https://drive.google.com/x" })).toThrow("not a Drive folder ID");
  });
  it("falls back to the legacy folder when unset", () => {
    expect(readerDriveFolderId({})).toBe("1S2uePphOd_25yandeFtQJ6iZvSz2ydYw");
  });
});
