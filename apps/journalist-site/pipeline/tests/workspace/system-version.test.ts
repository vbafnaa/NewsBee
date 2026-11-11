import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({ currentAdmin: vi.fn() }));
vi.mock("@/lib/admin-session", () => ({ currentAdmin: mocks.currentAdmin }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: ReactNode }) => createElement("a", { href }, children) }));
vi.mock("../../../app/admin-shell", () => ({ default: ({ children }: { children: ReactNode }) => createElement("main", null, children) }));
vi.mock("../../../app/health/health-dashboard", () => ({ default: () => createElement("div", null, "Pipeline dashboard") }));
vi.mock("../../../app/model-usage/model-usage-dashboard", () => ({ default: () => createElement("div", null, "Usage dashboard") }));

import SystemPage from "../../../app/health/page";

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("System running commit", () => {
  it.each([undefined, "usage"])("shows the build commit in the %s view", async (view) => {
    mocks.currentAdmin.mockResolvedValue("editor@example.test");
    vi.stubEnv("NEWSBEE_BUILD_COMMIT_SHA", "a".repeat(40));
    const page = await SystemPage({ searchParams: Promise.resolve({ view }) });
    const html = renderToStaticMarkup(page);
    expect(html).toContain(`Running commit: <code>${"a".repeat(40)}</code>`);
  });

  it("indicates when the build commit is unavailable", async () => {
    mocks.currentAdmin.mockResolvedValue("editor@example.test");
    vi.stubEnv("NEWSBEE_BUILD_COMMIT_SHA", "");
    const html = renderToStaticMarkup(await SystemPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("unavailable (build commit metadata not provided)");
  });

  it("does not reveal the commit to unauthenticated visitors", async () => {
    mocks.currentAdmin.mockResolvedValue(null);
    await expect(SystemPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("redirect:/login");
  });

  it("uses Vercel's deployed commit for the build", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "b".repeat(40));
    vi.resetModules();
    const { default: config } = await import("../../../next.config");
    expect(config.env?.NEWSBEE_BUILD_COMMIT_SHA).toBe("b".repeat(40));
  });
});
