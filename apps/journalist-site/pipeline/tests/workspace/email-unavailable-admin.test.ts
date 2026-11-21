import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  collection: vi.fn(),
  resolve: vi.fn(),
  campaigns: vi.fn(),
  denied: false,
}));
vi.mock("@/lib/admin-api", () => {
  const route = async (_request: Request, handler: (deps: unknown) => Promise<unknown>) => {
    if (state.denied) return Response.json({ detail: "Unauthorized" }, { status: 401 });
    const result = await handler({
      db: { collection: state.collection },
      principal: { id: "owner", email: "owner@example.test", role: "owner" },
    });
    return result instanceof Response ? result : Response.json(result);
  };
  return { adminRoute: route, publicationRoute: route };
});
vi.mock("@/pipeline/orchestration/output-channels", () => ({ resolveOutputChannelForPrincipal: state.resolve }));
vi.mock("@/pipeline/email/campaigns", () => ({ listPublicationEmailCampaigns: state.campaigns }));
vi.mock("@/lib/release-video-usage", () => ({ releaseVideoStatus: vi.fn() }));

import { GET as history, POST as publicationPost } from "../../../app/api/admin/publications/[publicationId]/email/route";
import { POST as newsletterPost } from "../../../app/api/admin/newsletter/route";

const context = { params: Promise.resolve({ publicationId: "publication-1" }) };
beforeEach(() => {
  vi.clearAllMocks();
  state.denied = false;
  state.collection.mockImplementation(() => { throw new Error("Unavailable email must not access collections."); });
});

it.each(["preview", "send_test", "send_release", "continue", "retry_unknown", "fake_event"])(
  "rejects %s before campaign, outbox, suppression, or audit writes", async (action) => {
    const response = await publicationPost(new Request("https://newsbee.test/api/admin/publications/publication-1/email", {
      method: "POST", body: JSON.stringify({ action, release_id: "release-1", campaign_id: "campaign-1" }),
    }), context);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ detail: expect.stringContaining("has not launched") });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(state.collection).not.toHaveBeenCalled();
    expect(state.resolve).not.toHaveBeenCalled();
  },
);

it("keeps historical campaign GET readable and newsletter POST unavailable", async () => {
  state.resolve.mockResolvedValue({ context: { id: "publication-1" } });
  state.campaigns.mockResolvedValue([{ _id: "historical-campaign", state: "complete", counts: { accepted: 4 } }]);
  const response = await history(new Request("https://newsbee.test/api/admin/publications/publication-1/email"), context);
  expect(await response.json()).toMatchObject({ campaigns: [{ _id: "historical-campaign", counts: { accepted: 4 } }] });
  const blocked = await newsletterPost(new Request("https://newsbee.test/api/admin/newsletter", { method: "POST" }));
  expect(blocked.status).toBe(503);
  expect(state.collection).not.toHaveBeenCalled();
});

it("retains the authentication boundary for unavailable email actions", async () => {
  state.denied = true;
  const request = new Request("https://newsbee.test/api/admin/newsletter", { method: "POST" });
  expect((await newsletterPost(request)).status).toBe(401);
  expect((await publicationPost(request, context)).status).toBe(401);
  expect(state.collection).not.toHaveBeenCalled();
});
