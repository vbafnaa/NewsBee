import { describe, expect, it } from "vitest";
import { groupPrompt } from "./prompt";
import { InputError, postKey, validateGroup, validateReport } from "./validation";

const valid = () => ({
  runTime: "2026-10-29T16:00:00.000Z", windowStart: "2026-10-29T15:00:00.000Z", windowEnd: "2026-10-29T16:00:00.000Z", status: "partial",
  scans: [
    { sort: "CHRONOLOGICAL", status: "complete", reason: null, postRefs: ["p1"] },
    { sort: "RECENT_ACTIVITY", status: "partial", reason: "Only one available", postRefs: ["p1"] },
  ],
  posts: [{ ref: "p1", id: null, text: "An original post", permalink: null, sourceLinks: [], publishedAt: null,
    rawTime: "1h", observedAt: "2026-10-29T16:00:00.000Z", commentCount: null,
    reactions: { total: null, kinds: [], counts: {} }, contentVerified: true, truncated: false }],
  issues: ["Unknown time"],
});

describe("group and report validation", () => {
  it("accepts a Facebook group and canonicalizes its URL", () => {
    expect(validateGroup({ name: " Community ", url: "https://facebook.com/groups/1234/?ref=share" })).toEqual({ name: "Community", url: "https://www.facebook.com/groups/1234" });
  });
  it("rejects arbitrary URLs and invalid group paths", () => {
    expect(() => validateGroup({ name: "Fake", url: "https://facebook.com.evil.example/groups/1234" })).toThrow(InputError);
    expect(() => validateGroup({ name: "Fake", url: "https://www.facebook.com/profile.php" })).toThrow(InputError);
  });
  it("keeps unknown publication times unverified", () => {
    const report = validateReport(valid());
    expect(report.posts[0].publishedAt).toBeNull();
    expect(report.scans[1].postRefs).toEqual(["p1"]);
    expect(postKey(report.posts[0])).toBe(postKey(report.posts[0]));
  });
  it("rejects missing scans, unknown references and more than ten recent posts", () => {
    const missing = valid(); missing.scans.pop();
    expect(() => validateReport(missing)).toThrow(InputError);
    const unknown = valid(); unknown.scans[1].postRefs = ["not-supplied"];
    expect(() => validateReport(unknown)).toThrow(InputError);
    const tooMany = valid(); tooMany.scans[1].postRefs = Array.from({ length: 11 }, (_, n) => `p${n}`);
    expect(() => validateReport(tooMany)).toThrow(InputError);
  });
  it("rejects duplicate post identities even when their scan refs differ", () => {
    const report = valid();
    report.posts.push({ ...report.posts[0], ref: "p2" });
    report.scans[1].postRefs.push("p2");
    expect(() => validateReport(report)).toThrow(InputError);
  });
  it("does not allow a complete report to conceal a partial scan", () => {
    const report = valid(); report.status = "complete";
    expect(() => validateReport(report)).toThrow(InputError);
  });
  it("rejects invalid dates, counts and unsafe links", () => {
    const bad = valid(); bad.posts[0].commentCount = -1 as never;
    expect(() => validateReport(bad)).toThrow(InputError);
    const link = valid(); link.posts[0].permalink = "javascript:alert(1)" as never;
    expect(() => validateReport(link)).toThrow(InputError);
    const window = valid(); window.windowStart = window.windowEnd;
    expect(() => validateReport(window)).toThrow(InputError);
    const longerWindow = valid(); longerWindow.windowStart = "2026-10-29T14:00:00.000Z";
    expect(() => validateReport(longerWindow)).toThrow("exactly one hour");
    const mismatchedRun = valid(); mismatchedRun.runTime = "2026-10-29T17:00:00.000Z";
    expect(() => validateReport(mismatchedRun)).toThrow("ending at runTime");
  });
  it("provides the reporting endpoint and explicit collection caveat in the prompt", () => {
    const prompt = groupPrompt({ id: "abc", name: "Group", url: "https://www.facebook.com/groups/123", createdAt: "today" }, "https://receiver.test/api/groups/abc/reports");
    expect(prompt).toContain("https://receiver.test/api/groups/abc/reports");
    expect(prompt).toContain("web-search answer does NOT establish coverage");
  });
});
