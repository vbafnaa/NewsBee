import { describe, expect, it } from "vitest";
import { previewContent } from "../../email/preview";

describe("email preview content", () => {
  it("renders escaped HTML and text without sending", () => {
    const preview = previewContent("Auburn, WA", "auburn-wa", { headline: "A < headline", intro: "Welcome <neighbors>.", email: { blurb: "See this week's stories." } });
    expect(preview.subject).toBe("A < headline");
    expect(preview.text).toContain("Read the full Auburn, WA edition: http://127.0.0.1:4321/?location=auburn-wa");
    expect(preview.html).toContain("&lt; headline");
    expect(preview.html).toContain("&lt;neighbors&gt;");
  });
});
