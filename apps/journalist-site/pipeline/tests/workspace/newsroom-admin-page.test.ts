import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";

const mocks = vi.hoisted(() => ({ loadNewsroom: vi.fn(), status: vi.fn() }));
vi.mock("../../../app/newsroom/[publicationId]/newsroom-context", () => ({ loadNewsroom: mocks.loadNewsroom }));
vi.mock("@/pipeline/publications/newsroom-admin-status", () => ({ newsroomServiceStatus: mocks.status }));

const params = Promise.resolve({ publicationId: "north-room" });

describe("Newsroom admin page", () => {
  beforeEach(async () => {
    mocks.status.mockResolvedValue([
      { id: "system", eyebrow: "Newsbee operations", title: "System", description: "Monitor.", docs: "https://github.com/g2minhle/Newsbee/blob/main/docs/operations-inventory.md",
        cards: [{ name: "Collector service", state: "active", detail: "Scheduler ran just now", href: "/health" }] },
      { id: "transfer", title: "Import & export", description: "Move.", docs: null, ownerOnly: true,
        cards: [{ name: "Import source map", state: "unchecked", detail: "Maintenance state unavailable", href: "/site-backup" }] },
    ]);
  });

  it.each([
    ["editor", { "Collector service": "locked:Admins only", "Import source map": "locked:Admins only" }],
    ["admin", { "Collector service": "/health", "Import source map": "locked:Owner only" }],
    ["owner", { "Collector service": "/health", "Import source map": "/site-backup" }],
  ] as const)("is read-only for everyone and locks what a %s can't open", async (role, expected) => {
    mocks.loadNewsroom.mockResolvedValue({ principal: { id: role, email: `${role}@example.test`, role }, db: {} });
    const { default: AdminPage } = await import("../../../app/newsroom/[publicationId]/admin/page");
    const { document } = parseHTML(renderToStaticMarkup(await AdminPage({ params })));
    const cards = [...document.querySelectorAll(".jw-service-card")];
    expect(Object.fromEntries(cards.map((item) => [item.querySelector("strong")?.textContent,
      item.tagName === "A" ? item.getAttribute("href") : `locked:${item.getAttribute("title")}`]))).toEqual(expected);
    expect(cards.map((item) => item.querySelector(".jw-status-pill, [class*='pill']")?.textContent)).toEqual(["Active", "Not checked"]);
    // Documentation shows only where a doc exists.
    expect([...document.querySelectorAll(".jw-admin-section")].map((section) => section.querySelector("a[target=_blank]")?.getAttribute("href") ?? null))
      .toEqual(["https://github.com/g2minhle/Newsbee/blob/main/docs/operations-inventory.md", null]);
    for (const locked of document.querySelectorAll(".jw-service-card.is-locked")) expect(locked.querySelector("a")).toBeNull();
  });
});

