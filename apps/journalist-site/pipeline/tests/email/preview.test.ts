import { afterEach, describe, expect, it, vi } from "vitest";
import { previewContent } from "../../email/preview";

describe("email preview content", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("renders escaped HTML and text without sending", () => {
    vi.stubEnv("NEWSBEE_READER_SITE_URL", undefined);
    const preview = previewContent("Auburn, WA", "auburn-wa", { headline: "A < headline", intro: "Welcome <neighbors>.", email: { blurb: "See this week's stories." } });
    expect(preview.subject).toBe("A < headline");
    expect(preview.text).toContain("Read the full Auburn, WA edition: http://127.0.0.1:4321/reader/?location=auburn-wa");
    expect(preview.html).toContain("&lt; headline");
    expect(preview.html).toContain("&lt;neighbors&gt;");
  });

  it("links to the configured public reader path, not an internal service URL", () => {
    vi.stubEnv("NEWSBEE_READER_SITE_URL", "https://newsbee.example/reader");
    const preview = previewContent("Auburn, WA", "auburn-wa", { headline: "Local news", intro: "Welcome." });
    expect(preview.text).toContain("https://newsbee.example/reader/?location=auburn-wa");
    expect(preview.html).toContain('href="https://newsbee.example/reader/?location=auburn-wa"');
  });
});
