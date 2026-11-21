import { beforeEach, expect, it, vi } from "vitest";
const deps = vi.hoisted(() => ({ directoryTown: vi.fn(), readerDatabase: vi.fn(), saveCommunityIntake: vi.fn() }));
vi.mock("../../../../reader-site/src/lib/reader-data", () => ({ directoryTown: deps.directoryTown, readerDatabase: deps.readerDatabase }));
vi.mock("../../../../reader-site/src/lib/community-intake-storage", () => ({ saveCommunityIntake: deps.saveCommunityIntake }));
import { POST as contactPost } from "../../../../reader-site/src/pages/api/contact";
import { POST as applicationPost } from "../../../../reader-site/src/pages/api/editor-interest";
const valid = { submitter_name: "A Reader", submitter_email: "reader@example.test", consent: true, topic: "coverage", message: "Please consider including our local community in Newsbee coverage." };
const url = new URL("https://newsbee.test/reader/api/contact");
const request = (value: unknown, origin = url.origin, headers: Record<string, string> = {}) => ({ request: new Request(url, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", ...headers }, body: JSON.stringify(value) }), url }) as Parameters<typeof contactPost>[0];
beforeEach(() => { vi.resetAllMocks(); deps.readerDatabase.mockResolvedValue({}); deps.directoryTown.mockResolvedValue({ id: "town-wa", name: "Town, WA" }); deps.saveCommunityIntake.mockResolvedValue("a-private-receipt"); });

it("rejects cross-origin, non-JSON, oversized and unconsented forms before database writes", async () => {
  expect((await contactPost(request(valid, "https://elsewhere.test"))).status).toBe(403);
  expect((await contactPost(request(valid, url.origin, { "Content-Type": "text/plain" }))).status).toBe(415);
  expect((await contactPost(request({ ...valid, message: "x".repeat(17_000) }))).status).toBe(413);
  expect((await contactPost(request({ ...valid, consent: false }))).status).toBe(422);
  expect(deps.saveCommunityIntake).not.toHaveBeenCalled();
});
it("canonicalizes a selected community and returns only a private receipt", async () => {
  const response = await contactPost(request({ ...valid, location_id: "town-wa", community_name: "Forged name", status: "approved" }));
  expect(response.status).toBe(201);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toEqual({ status: "pending_review", receipt: "a-private-receipt" });
  expect(deps.saveCommunityIntake.mock.calls[0][1]).toMatchObject({ community_name: "Town, WA", kind: "contact" });
  expect(deps.saveCommunityIntake.mock.calls[0][1]).not.toHaveProperty("status");
});
it("rejects unknown selected communities but accepts a freeform branch application", async () => {
  deps.directoryTown.mockResolvedValueOnce(null);
  expect((await contactPost(request({ ...valid, location_id: "missing-wa" }))).status).toBe(404);
  const result = await applicationPost(request({ ...valid, community_name: "New Town, WA", intent: "start_branch", experience: "I have organized neighborhood events for several years.", motivation: "I want neighbors to have a dependable source of useful local stories and nearby events." }));
  expect(result.status).toBe(201);
  expect(deps.saveCommunityIntake.mock.calls[0][1]).toMatchObject({ kind: "editor_interest", location_id: null, intent: "start_branch" });
});
it("keeps the form retryable and does not disclose storage failures", async () => {
  deps.saveCommunityIntake.mockRejectedValue(new Error("Database credentials or private connection details"));
  const response = await contactPost(request(valid));
  expect(response.status).toBe(503);
  expect(JSON.stringify(await response.json())).not.toContain("credentials");
});
