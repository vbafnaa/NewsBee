import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getToken } = vi.hoisted(() => ({ getToken: vi.fn() }));
vi.mock("next-auth/jwt", () => ({ getToken }));

describe("YouTube publishing connector", () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("AUTH_GOOGLE_ID", "client-id");
    vi.stubEnv("AUTH_GOOGLE_SECRET", "client-secret");
    getToken.mockReset().mockResolvedValue({
      email: "editor@example.com",
      youtubeRefreshToken: "user-refresh-token",
      youtubeAccountEmail: "editor@example.com",
      youtubeScopes: ["https://www.googleapis.com/auth/youtube"],
    });
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("reports an authorized YouTube connection only for the signed-in Google account", async () => {
    const { youtubeConnection } = await import("../../connectors/youtube");
    await expect(youtubeConnection(new Request("https://newsbee.test/api"), "editor@example.com"))
      .resolves.toEqual({ connected: true, email: "editor@example.com", scope: "https://www.googleapis.com/auth/youtube" });
    await expect(youtubeConnection(new Request("https://newsbee.test/api"), "other@example.com"))
      .resolves.toMatchObject({ connected: false, email: null });
  });

  it("refreshes the current user's token and uploads the reviewed video metadata", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ access_token: "user-access-token" }))
      .mockResolvedValueOnce(new Response(null, {
        status: 200,
        headers: { location: "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=test" },
      }))
      .mockResolvedValueOnce(Response.json({ id: "youtube-video-123", snippet: { channelId: "channel-123" } }));

    const { publishVideoToYouTube } = await import("../../connectors/youtube");
    await expect(publishVideoToYouTube(
      new Request("https://newsbee.test/api"),
      "editor@example.com",
      new Uint8Array([1, 2, 3]),
      { title: "Local update", description: "Reviewed description", tags: ["local news"] },
      "private",
    )).resolves.toEqual({
      videoId: "youtube-video-123",
      url: "https://www.youtube.com/watch?v=youtube-video-123",
      channelId: "channel-123",
    });

    const [refreshUrl, refreshInit] = fetchMock.mock.calls[0];
    expect(refreshUrl).toBe("https://oauth2.googleapis.com/token");
    expect((refreshInit?.body as URLSearchParams).get("refresh_token")).toBe("user-refresh-token");
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer user-access-token", "X-Upload-Content-Length": "3" }),
      body: JSON.stringify({
        snippet: { title: "Local update", description: "Reviewed description", tags: ["local news"], categoryId: "25" },
        status: { privacyStatus: "private", selfDeclaredMadeForKids: false },
      }),
    });
    expect(fetchMock.mock.calls[2][1]).toMatchObject({
      method: "PUT",
      headers: expect.objectContaining({ Authorization: "Bearer user-access-token", "Content-Type": "video/mp4" }),
    });
  });

  it("rejects a resumable upload URL outside Google's API host", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ access_token: "user-access-token" }))
      .mockResolvedValueOnce(new Response(null, { status: 200, headers: { location: "https://attacker.example/upload" } }));
    const { publishVideoToYouTube } = await import("../../connectors/youtube");
    await expect(publishVideoToYouTube(
      new Request("https://newsbee.test/api"),
      "editor@example.com",
      new Uint8Array([1]),
      { title: "Local update", description: "Reviewed description", tags: [] },
      "private",
    )).rejects.toThrow("unexpected upload URL");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("requires a user-specific refresh token and rejects invalid privacy values", async () => {
    getToken.mockResolvedValueOnce({
      email: "other@example.com",
      youtubeRefreshToken: "another-user-token",
      youtubeAccountEmail: "other@example.com",
      youtubeScopes: ["https://www.googleapis.com/auth/youtube"],
    });
    const { publishVideoToYouTube } = await import("../../connectors/youtube");
    await expect(publishVideoToYouTube(
      new Request("https://newsbee.test/api"),
      "editor@example.com",
      new Uint8Array([1]),
      { title: "Local update", description: "Reviewed description", tags: [] },
      "private",
    )).rejects.toThrow("Connect YouTube");
    await expect(publishVideoToYouTube(
      new Request("https://newsbee.test/api"),
      "editor@example.com",
      new Uint8Array([1]),
      { title: "Local update", description: "Reviewed description", tags: [] },
      "friends",
    )).rejects.toThrow("valid YouTube visibility");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lists channels and only playlists that belong to the selected channel", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ access_token: "user-access-token" }))
      .mockResolvedValueOnce(Response.json({ items: [
        { id: "channel-123", snippet: { title: "Newsbee Local" } },
        { id: "channel-456", snippet: { title: "Newsbee Shorts" } },
      ] }))
      .mockResolvedValueOnce(Response.json({ access_token: "user-access-token" }))
      .mockResolvedValueOnce(Response.json({ items: [
        { id: "channel-123", snippet: { title: "Newsbee Local" } },
        { id: "channel-456", snippet: { title: "Newsbee Shorts" } },
      ] }))
      .mockResolvedValueOnce(Response.json({ access_token: "user-access-token" }))
      .mockResolvedValueOnce(Response.json({
        items: [
          { id: "playlist-1", snippet: { title: "Moses Lake Updates", channelId: "channel-123" } },
          { id: "playlist-other", snippet: { title: "Other channel", channelId: "channel-456" } },
        ],
      }));

    const { listYouTubeChannels, listYouTubePlaylists } = await import("../../connectors/youtube");
    const request = new Request("https://newsbee.test/api");
    await expect(listYouTubeChannels(request, "editor@example.com")).resolves.toEqual([
      { id: "channel-123", title: "Newsbee Local" },
      { id: "channel-456", title: "Newsbee Shorts" },
    ]);
    await expect(listYouTubePlaylists(request, "editor@example.com", "channel-123")).resolves.toEqual([
      { id: "playlist-1", title: "Moses Lake Updates" },
    ]);
    expect(String(fetchMock.mock.calls[1][0])).toContain("channels?part=id%2Csnippet&mine=true");
    expect(String(fetchMock.mock.calls[5][0])).toContain("playlists?part=id%2Csnippet&channelId=channel-123");
  });

  it("adds a successfully uploaded video to the chosen playlist", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ access_token: "user-access-token" }))
      .mockResolvedValueOnce(Response.json({ kind: "youtube#playlistItem" }));
    const { addYouTubeVideoToPlaylist } = await import("../../connectors/youtube");
    await expect(addYouTubeVideoToPlaylist(
      new Request("https://newsbee.test/api"),
      "editor@example.com",
      "playlist-1",
      "video-123",
    )).resolves.toEqual({ kind: "youtube#playlistItem" });
    expect(fetchMock.mock.calls[1]).toMatchObject([
      "https://www.googleapis.com/youtube/v3/playlistItems?part=snippet",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ snippet: { playlistId: "playlist-1", resourceId: { kind: "youtube#video", videoId: "video-123" } } }),
      }),
    ]);
  });
});
