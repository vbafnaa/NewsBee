import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  adminRoute: vi.fn(),
  ownerGuard: vi.fn(),
}));

vi.mock("@/lib/admin-api", () => ({
  adminRoute: mocks.adminRoute,
}));

vi.mock("@/lib/admin-session", () => ({
  ownerGuard: mocks.ownerGuard,
}));

import { DELETE } from "../../../app/api/admin/relaxed-content/route";

beforeEach(() => {
  vi.clearAllMocks();
});

it("denies admins before loading or clearing relaxed content", async () => {
  mocks.ownerGuard.mockResolvedValue(
    Response.json({ detail: "Owner access required" }, { status: 403 }),
  );

  const response = await DELETE(new Request(
    "https://fixture.example.test/api/admin/relaxed-content",
    { method: "DELETE" },
  ));

  expect(response.status).toBe(403);
  expect(mocks.adminRoute).not.toHaveBeenCalled();
});
