import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), headers: vi.fn(), database: vi.fn(), principal: vi.fn(), create: vi.fn(), replace: vi.fn(),
  startUpload: vi.fn(), saveChunk: vi.fn(), readUpload: vi.fn(), deleteUpload: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: mocks.auth, getMongoDatabase: mocks.database }));
vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("@/pipeline/accounts/identity", () => ({
  isOperator: (principal: { role: string }) => principal.role === "owner" || principal.role === "admin",
  principalForEmail: mocks.principal,
  principalById: mocks.principal,
  principalForSession: mocks.principal,
}));
vi.mock("@/pipeline/storage/site-backup", () => ({
  createSiteBackup: mocks.create,
  replaceSiteBackup: mocks.replace,
  SITE_BACKUP_MAX_BYTES: 250 * 1024 * 1024,
}));
vi.mock("@/pipeline/storage/site-backup-upload", () => ({
  startBackupUpload: mocks.startUpload, saveBackupChunk: mocks.saveChunk,
  readBackupUpload: mocks.readUpload, deleteBackupUpload: mocks.deleteUpload,
}));

import { GET, POST } from "../../../app/api/admin/site-backup/route";
import { POST as startUpload, PUT as saveChunk, DELETE as deleteUpload } from "../../../app/api/admin/site-backup/upload/route";
import { BACKUP_CHUNK_BYTES, BACKUP_STREAM_TYPE, readBackupTransfer } from "../../../lib/site-backup-transfer";

const url = "https://workspace.example.test/api/admin/site-backup";
const upload = () => new Request(url, {
  method: "POST",
  headers: { origin: "https://workspace.example.test", "Content-Type": "application/json" },
  body: JSON.stringify({ confirm: "REPLACE ALL SITE DATA", governanceConfirmation: "ROLL BACK ACCOUNTS AND GOVERNANCE", archive: { format: "fixture" } }),
});

describe("site backup access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { email: "owner@example.test", newsbeePrincipalId: "owner-fixture" } });
    mocks.headers.mockResolvedValue(new Headers({ host: "workspace.example.test" }));
    mocks.principal.mockResolvedValue({ id: "owner-fixture", email: "owner@example.test", role: "owner" });
    mocks.database.mockResolvedValue({});
    mocks.create.mockResolvedValue({ format: "fixture" });
    mocks.replace.mockResolvedValue({ collections: 1, documents: 2, artifactFiles: 3 });
    mocks.startUpload.mockResolvedValue({ uploadId: "upload-fixture", chunkBytes: BACKUP_CHUNK_BYTES });
    mocks.saveChunk.mockResolvedValue(undefined);
    mocks.readUpload.mockResolvedValue({ format: "fixture" });
    mocks.deleteUpload.mockResolvedValue(undefined);
  });

  it("allows only the configured owner to download and import", async () => {
    const download = await GET(new Request(url));
    expect(download.status).toBe(200);
    expect(await download.json()).toEqual({ format: "fixture" });
    const imported = await POST(upload());
    expect(imported.status).toBe(200);
    expect(await imported.json()).toMatchObject({ success: true, collections: 1 });
    expect(mocks.principal).toHaveBeenCalledWith({}, "owner-fixture", undefined, undefined);
    expect(mocks.replace).toHaveBeenCalledWith({}, { format: "fixture" }, expect.objectContaining({
      owner: { id: "owner-fixture", email: "owner@example.test", role: "owner" },
      governanceConfirmation: "ROLL BACK ACCOUNTS AND GOVERNANCE",
    }));
  });

  it.each(["admin", "editor"])("denies %s access to export and restore", async (role) => {
    mocks.principal.mockResolvedValue({ id: `${role}-fixture`, email: `${role}@example.test`, role });
    mocks.auth.mockResolvedValue({ user: { email: `${role}@example.test`, newsbeePrincipalId: `${role}-fixture` } });
    expect((await GET(new Request(url))).status).toBe(403);
    expect((await POST(upload())).status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("rejects a signed-in account without approved access", async () => {
    mocks.principal.mockResolvedValueOnce(null);
    expect((await GET(new Request(url))).status).toBe(401);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("rejects unsigned and cross-origin requests before reading or replacing data", async () => {
    mocks.auth.mockResolvedValueOnce(null);
    expect((await GET(new Request(url))).status).toBe(401);
    const foreign = new Request(url, {
      method: "POST",
      headers: { origin: "https://evil.example.test", "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "REPLACE ALL SITE DATA", archive: { format: "fixture" } }),
    });
    expect((await POST(foreign)).status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("streams export progress and archive chunks for the backup UI", async () => {
    mocks.create.mockImplementationOnce(async (_db, options) => {
      options.onProgress("Exporting fixture...");
      return { format: "fixture", payload: "x".repeat(6 * 1024 * 1024) };
    });
    const response = await GET(new Request(url, { headers: { Accept: BACKUP_STREAM_TYPE } }));
    const parts: string[] = [];
    const progress = vi.fn();
    await readBackupTransfer(response, progress, (data) => { parts.push(data); });
    expect(JSON.parse(parts.join("")).payload).toHaveLength(6 * 1024 * 1024);
    expect(progress).toHaveBeenCalledWith("Exporting fixture...");
    expect(mocks.create).toHaveBeenCalledWith({}, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("imports a staged archive only after explicit same-origin confirmation", async () => {
    const response = await POST(new Request(url, {
      method: "POST",
      headers: { origin: "https://workspace.example.test", "Content-Type": "application/json", Accept: BACKUP_STREAM_TYPE },
      body: JSON.stringify({ confirm: "REPLACE ALL SITE DATA", governanceConfirmation: "ROLL BACK ACCOUNTS AND GOVERNANCE", uploadId: "upload-fixture" }),
    }));
    await expect(readBackupTransfer(response, vi.fn())).resolves.toEqual({ collections: 1, documents: 2, artifactFiles: 3 });
    expect(mocks.readUpload).toHaveBeenCalledWith({}, "owner@example.test", "upload-fixture");
    expect(mocks.replace).toHaveBeenCalledWith({}, { format: "fixture" }, expect.objectContaining({
      signal: expect.any(AbortSignal), owner: expect.objectContaining({ role: "owner" }),
      governanceConfirmation: "ROLL BACK ACCOUNTS AND GOVERNANCE",
    }));
    expect(mocks.deleteUpload).toHaveBeenCalledWith({}, "owner@example.test", "upload-fixture");
  });

  it("never starts replacement if the staged upload is incomplete", async () => {
    mocks.readUpload.mockRejectedValueOnce(new Error("Backup upload is incomplete."));
    const response = await POST(new Request(url, {
      method: "POST",
      headers: { origin: "https://workspace.example.test", Accept: BACKUP_STREAM_TYPE },
      body: JSON.stringify({ confirm: "REPLACE ALL SITE DATA", governanceConfirmation: "ROLL BACK ACCOUNTS AND GOVERNANCE", uploadId: "upload-fixture" }),
    }));
    await expect(readBackupTransfer(response, vi.fn())).rejects.toThrow("incomplete");
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.deleteUpload).not.toHaveBeenCalled();
  });

  it.each([undefined, BACKUP_STREAM_TYPE])("rejects governance-unconfirmed import before reading either transport (%s)", async (accept) => {
    const response = await POST(new Request(url, {
      method: "POST",
      headers: { origin: "https://workspace.example.test", ...(accept ? { accept } : {}) },
      body: JSON.stringify({ confirm: "REPLACE ALL SITE DATA", uploadId: "upload-fixture", archive: {} }),
    }));
    expect(response.status).toBe(400);
    expect(mocks.readUpload).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("bounds chunk bodies even without Content-Length and enforces the upload guard", async () => {
    const headers = { origin: "https://workspace.example.test" };
    const response = await startUpload(new Request(`${url}/upload`, {
      method: "POST", headers, body: JSON.stringify({ bytes: 6 * 1024 * 1024 }),
    }));
    expect(response.status).toBe(200);
    const chunk = await saveChunk(new Request(`${url}/upload?id=upload-fixture&part=0`, {
      method: "PUT", headers, body: new Uint8Array(BACKUP_CHUNK_BYTES + 1),
    }));
    expect(chunk.status).toBe(400);
    expect(mocks.saveChunk).not.toHaveBeenCalled();
    const foreign = await deleteUpload(new Request(`${url}/upload?id=upload-fixture`, {
      method: "DELETE", headers: { origin: "https://evil.example.test" },
    }));
    expect(foreign.status).toBe(403);
    expect(mocks.deleteUpload).not.toHaveBeenCalled();
  });
});
