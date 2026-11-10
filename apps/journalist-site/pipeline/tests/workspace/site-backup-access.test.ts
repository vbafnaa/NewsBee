import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), headers: vi.fn(), database: vi.fn(), principal: vi.fn(), create: vi.fn(), replace: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mocks.auth, getMongoDatabase: mocks.database }));
vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("@/pipeline/accounts/identity", () => ({ principalForEmail: mocks.principal }));
vi.mock("@/pipeline/storage/site-backup", () => ({
  createSiteBackup: mocks.create,
  replaceSiteBackup: mocks.replace,
  SITE_BACKUP_MAX_BYTES: 250 * 1024 * 1024,
}));

import { GET, POST } from "../../../app/api/admin/site-backup/route";

const url = "https://workspace.example.test/api/admin/site-backup";
const upload = () => new Request(url, {
  method: "POST",
  headers: { origin: "https://workspace.example.test", "Content-Type": "application/json" },
  body: JSON.stringify({ confirm: "REPLACE ALL SITE DATA", archive: { format: "fixture" } }),
});

describe("site backup access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { email: "editor@example.test" } });
    mocks.headers.mockResolvedValue(new Headers({ host: "workspace.example.test" }));
    mocks.principal.mockResolvedValue({ id: "editor-fixture", email: "editor@example.test", role: "editor" });
    mocks.database.mockResolvedValue({});
    mocks.create.mockResolvedValue({ format: "fixture" });
    mocks.replace.mockResolvedValue({ collections: 1, documents: 2, artifactFiles: 3 });
  });

  it("allows an approved signed-in editor to download and import", async () => {
    const download = await GET(new Request(url));
    expect(download.status).toBe(200);
    expect(await download.json()).toEqual({ format: "fixture" });
    const imported = await POST(upload());
    expect(imported.status).toBe(200);
    expect(await imported.json()).toMatchObject({ success: true, collections: 1 });
    expect(mocks.principal).toHaveBeenCalledWith({}, "editor@example.test");
    expect(mocks.replace).toHaveBeenCalledWith({}, { format: "fixture" });
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
});
