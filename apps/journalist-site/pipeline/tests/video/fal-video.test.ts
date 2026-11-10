import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("fal.ai video connector", () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("FAL_KEY", "test-fal-key");
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("submits portrait video with audio to the configured model", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ request_id: "fal-request-1" }));
    const { submitFalVideo } = await import("../../connectors/fal-video");
    await expect(submitFalVideo("A reviewed Newsbee prompt", "test-personal-key")).resolves.toBe("fal-request-1");

    expect(fetchMock).toHaveBeenCalledWith("https://queue.fal.run/minimax/h3-max/text-to-video", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Key test-personal-key" }),
      body: JSON.stringify({
        prompt: "A reviewed Newsbee prompt",
        aspect_ratio: "9:16",
        duration: 15,
        resolution: "768P",
        enable_safety_checker: true,
        prompt_expansion_mode: "disabled",
      }),
    }));
  });

  it("uses a supplied personal key instead of the deployment key", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ request_id: "personal-fal-request" }));
    const { submitFalVideo } = await import("../../connectors/fal-video");
    await expect(submitFalVideo("Personal key prompt", "personal-fal-key")).resolves.toBe("personal-fal-request");
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Key personal-fal-key" });
  });

  it("checks queue status and returns a bounded MP4 result", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ status: "COMPLETED" }))
      .mockResolvedValueOnce(Response.json({ video: { url: "https://storage.googleapis.com/falserverless/example_outputs/video.mp4", content_type: "video/mp4" } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([0, 1, 2]), { headers: { "content-type": "video/mp4", "content-length": "3" } }));
    const { falVideoStatus, falVideoResult } = await import("../../connectors/fal-video");
    await expect(falVideoStatus("request-1", "test-personal-key")).resolves.toEqual({ status: "COMPLETED", error: null });
    await expect(falVideoResult("request-1", "test-personal-key")).resolves.toMatchObject({
      content: new Uint8Array([0, 1, 2]),
      mimeType: "video/mp4",
    });
  });

  it("rejects media URLs outside fal.ai's media domain", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ video: { url: "https://storage.googleapis.com/other/video.mp4" } }));
    const { falVideoResult } = await import("../../connectors/fal-video");
    await expect(falVideoResult("request-1", "test-personal-key")).rejects.toThrow("outside its media domain");
  });

  it.each([undefined, null, "", " "])("blocks missing personal key %s despite FAL_KEY in the environment", async (key) => {
    const { falVideoConfigured, submitFalVideo, falVideoStatus, falVideoResult } = await import("../../connectors/fal-video");
    expect(falVideoConfigured(key)).toBe(false);
    await expect(submitFalVideo("prompt", key)).rejects.toThrow("personal fal.ai API key");
    await expect(falVideoStatus("request-1", key)).rejects.toThrow("personal fal.ai API key");
    await expect(falVideoResult("request-1", key)).rejects.toThrow("personal fal.ai API key");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
