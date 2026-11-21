import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ denied: false, list: vi.fn(), review: vi.fn(), guard: vi.fn() }));
vi.mock("@/lib/admin-api", () => ({ adminRoute: async (request: Request, handler: (deps: unknown) => Promise<unknown>) => {
  state.guard(request);
  if (state.denied) return Response.json({ detail: "Sign in" }, { status: 401 });
  const result = await handler({ db: {}, principal: { email: "reviewer@example.test" } });
  return result instanceof Response ? result : Response.json(result);
} }));
vi.mock("../../../../reader-site/src/lib/community-intake-storage", () => ({ listCommunityIntake: state.list, reviewCommunityIntake: state.review }));
import { GET, POST } from "../../../app/api/admin/community-intake/route";
const id = "8363d441-7c7e-4402-ab0a-e14a633989b0";
const request = (body: unknown) => new Request("https://newsbee.test/api/admin/community-intake", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://newsbee.test" }, body: JSON.stringify(body) });
beforeEach(() => { vi.resetAllMocks(); state.denied = false; state.list.mockResolvedValue({ items: [], total: 0, page: 1, pages: 1 }); state.review.mockResolvedValue({ _id: id, status: "in_review" }); });

it("uses the admin gate for reads and writes and reveals no inquiries when denied", async () => {
  state.denied = true;
  expect((await GET(new Request("https://newsbee.test/api/admin/community-intake"))).status).toBe(401);
  expect((await POST(request({ id, status: "closed" }))).status).toBe(401);
  expect(state.guard).toHaveBeenCalledTimes(2);
  expect(state.list).not.toHaveBeenCalled(); expect(state.review).not.toHaveBeenCalled();
});
it("validates review filters and disallows approval or role-granting decisions", async () => {
  expect((await GET(new Request("https://newsbee.test/api/admin/community-intake?status=approved"))).status).toBe(422);
  expect((await GET(new Request("https://newsbee.test/api/admin/community-intake?page=0"))).status).toBe(422);
  expect((await POST(request({ id, status: "approved", role: "owner" }))).status).toBe(422);
  expect(state.review).not.toHaveBeenCalled();
});
it("passes only the safe review decision and authenticated reviewer into storage", async () => {
  const response = await POST(request({ id, status: "in_review", note: "Contact applicant", role: "owner", location_id: "new-branch" }));
  expect(response.status).toBe(200);
  expect(state.review).toHaveBeenCalledWith({}, id, "in_review", "Contact applicant", "reviewer@example.test");
});
