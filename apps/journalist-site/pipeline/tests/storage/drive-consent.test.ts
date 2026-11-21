import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterEach, expect, it, vi } from "vitest";
import { editorDriveAccess, saveDriveConsent } from "../../storage/drive-consent";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("lets a queued job refresh only the approved editor's encrypted Drive consent", async () => {
  vi.stubEnv("AUTH_SECRET", "test-session-secret");
  vi.stubEnv("AUTH_GOOGLE_ID", "test-client");
  vi.stubEnv("AUTH_GOOGLE_SECRET", "test-client-secret");
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ access_token: "editor-access" }));
  vi.stubGlobal("fetch", fetchMock);

  const server = await MongoMemoryServer.create();
  const client = await MongoClient.connect(server.getUri());
  try {
    const db = client.db("drive-consent-test");
    const accounts = db.collection("journalist_admins");
    await accounts.insertMany([
      { email: "editor@example.test", enabled: true, principalId: "editor" },
      { email: "other@example.test", enabled: true, principalId: "other" },
    ]);
    await saveDriveConsent(db, "Editor@example.test", "editor-refresh");
    const saved = await db.collection<{ _id: string; credential: string }>("google_drive_consents")
      .findOne({ _id: "editor@example.test" });
    expect(saved?.credential).toBeTruthy();
    expect(saved?.credential).not.toContain("editor-refresh");
    await expect(editorDriveAccess(db, "other@example.test")).rejects.toThrow("Connect Google Drive as other@example.test");
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(editorDriveAccess(db, "editor@example.test")).resolves.toBe("editor-access");
    expect((fetchMock.mock.calls[0][1]?.body as URLSearchParams).get("refresh_token")).toBe("editor-refresh");

    await accounts.updateOne({ email: "editor@example.test" }, { $set: { enabled: false } });
    await expect(editorDriveAccess(db, "editor@example.test")).rejects.toThrow("approved journalist");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally {
    await client.close();
    await server.stop();
  }
});
