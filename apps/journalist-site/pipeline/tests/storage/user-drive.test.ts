import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getToken } = vi.hoisted(() => ({ getToken: vi.fn() }));
vi.mock("next-auth/jwt", () => ({ getToken }));

describe("signed-in Google Drive channel folders", () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  const request = new Request("https://newsbee.test/api/admin/output-channels");
  const channelId = "a".repeat(32);

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("AUTH_SECRET", "fixture-auth-secret");
    vi.stubEnv("AUTH_GOOGLE_ID", "client-id");
    vi.stubEnv("AUTH_GOOGLE_SECRET", "client-secret");
    getToken.mockReset().mockResolvedValue({
      email: "editor@example.com",
      googleDriveRefreshToken: "user-drive-refresh-token",
      googleDriveAccountEmail: "editor@example.com",
      googleDriveScopes: ["https://www.googleapis.com/auth/drive"],
    });
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("only reports Drive authorization for the current account and granted scope", async () => {
    const { hasGoogleDriveAuthorization } = await import("../../storage/user-drive");
    await expect(hasGoogleDriveAuthorization(request, "editor@example.com")).resolves.toBe(true);
    expect(getToken).toHaveBeenCalledWith({ req: request, secret: "fixture-auth-secret" });
    await expect(hasGoogleDriveAuthorization(request, "another@example.com")).resolves.toBe(false);
    getToken.mockResolvedValueOnce({
      email: "editor@example.com",
      googleDriveRefreshToken: "user-drive-refresh-token",
      googleDriveAccountEmail: "editor@example.com",
      googleDriveScopes: [],
    });
    await expect(hasGoogleDriveAuthorization(request, "editor@example.com")).resolves.toBe(false);
  });

  it("creates the channel folder under the configured Shared Drive root with the user's OAuth token", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ access_token: "user-drive-access-token" }))
      .mockResolvedValueOnce(Response.json({ files: [] }))
      .mockResolvedValueOnce(Response.json({ id: "output-channels-folder" }))
      .mockResolvedValueOnce(Response.json({ files: [] }))
      .mockResolvedValueOnce(Response.json({ id: "channel-folder-id" }));
    const { createUserDriveChannelFolder } = await import("../../storage/user-drive");

    await expect(createUserDriveChannelFolder(request, "editor@example.com", "pipeline-root-id", channelId))
      .resolves.toBe("channel-folder-id");
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect((fetchMock.mock.calls[0][1]?.body as URLSearchParams).get("refresh_token")).toBe("user-drive-refresh-token");

    const folderCreates = fetchMock.mock.calls.slice(2).filter(([, init]) => init?.method === "POST");
    expect(folderCreates).toHaveLength(2);
    expect(folderCreates[0][1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: "Bearer user-drive-access-token" }),
      body: JSON.stringify({ name: "output-channels", mimeType: "application/vnd.google-apps.folder", parents: ["pipeline-root-id"] }),
    });
    expect(folderCreates[1][1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: "Bearer user-drive-access-token" }),
      body: JSON.stringify({ name: channelId, mimeType: "application/vnd.google-apps.folder", parents: ["output-channels-folder"] }),
    });
    for (const [url, init] of fetchMock.mock.calls.slice(1)) {
      expect(init?.headers).not.toHaveProperty("Authorization", "******");
      if (init?.method === "POST") {
        expect(new URL(String(url)).searchParams.get("supportsAllDrives")).toBe("true");
      } else {
        const query = new URL(String(url)).searchParams;
        expect(query.get("supportsAllDrives")).toBe("true");
        expect(query.get("includeItemsFromAllDrives")).toBe("true");
      }
    }
  });

  it("refuses to create a channel folder without the current account's Drive scope", async () => {
    getToken.mockResolvedValueOnce({
      email: "editor@example.com",
      googleDriveRefreshToken: "user-drive-refresh-token",
      googleDriveAccountEmail: "editor@example.com",
      googleDriveScopes: [],
    });
    const { createUserDriveChannelFolder } = await import("../../storage/user-drive");
    await expect(createUserDriveChannelFolder(request, "editor@example.com", "pipeline-root-id", channelId))
      .rejects.toThrow("Connect Google Drive");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reuses existing nested folders instead of creating duplicates", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ access_token: "access" }))
      .mockResolvedValueOnce(Response.json({ files: [{ id: "existing-output-folder" }] }))
      .mockResolvedValueOnce(Response.json({ files: [{ id: "existing-channel-folder" }] }));
    const { createUserDriveChannelFolder } = await import("../../storage/user-drive");

    await expect(createUserDriveChannelFolder(request, "editor@example.com", "pipeline-root-id", channelId))
      .resolves.toBe("existing-channel-folder");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.slice(1).some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("reserves a durable Drive identity and reuses it after a lost folder-create response", async () => {
    const { reserveUserDriveFolderId, provisionUserDriveChannelFolder } = await import("../../storage/user-drive");
    fetchMock
      .mockResolvedValueOnce(Response.json({ access_token: "access" }))
      .mockResolvedValueOnce(Response.json({ ids: ["reserved-folder-id"] }));
    await expect(reserveUserDriveFolderId(request, "editor@example.com")).resolves.toBe("reserved-folder-id");
    fetchMock
      .mockResolvedValueOnce(Response.json({ access_token: "access" }))
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockRejectedValueOnce(new Error("Lost response"))
      .mockResolvedValueOnce(Response.json({ access_token: "access" }))
      .mockResolvedValueOnce(Response.json({ id: "reserved-folder-id", mimeType: "application/vnd.google-apps.folder" }));
    await expect(provisionUserDriveChannelFolder(request, "editor@example.com", "pipeline-root-id", channelId, "reserved-folder-id"))
      .rejects.toThrow("Lost response");
    await provisionUserDriveChannelFolder(request, "editor@example.com", "pipeline-root-id", channelId, "reserved-folder-id");
    const folderWrites = fetchMock.mock.calls.filter(([url, init]) => String(url).includes("/drive/v3/files?") && init?.method === "POST");
    expect(folderWrites).toHaveLength(1);
    expect(JSON.parse(String(folderWrites[0][1]?.body))).toMatchObject({
      id: "reserved-folder-id", parents: ["pipeline-root-id"], name: `channel-${channelId}`,
    });
  });

  it("surfaces Shared Drive permission errors without falling back to another credential", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ access_token: "access" }))
      .mockResolvedValueOnce(new Response("", { status: 403 }));
    const { createUserDriveChannelFolder } = await import("../../storage/user-drive");
    await expect(createUserDriveChannelFolder(request, "editor@example.com", "pipeline-root-id", channelId))
      .rejects.toThrow("cannot create folders");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
