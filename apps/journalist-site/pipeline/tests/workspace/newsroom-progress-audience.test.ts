import { Children, isValidElement, type ComponentProps, type ReactElement } from "react";
import { expect, it, vi } from "vitest";
import NewsroomLayout from "../../../app/newsroom/[publicationId]/layout";
import PublicationGeneration from "../../../app/publishing/publication-generation";
import AccountSettings from "../../../app/account/settings";

const state = vi.hoisted(() => ({ role: "editor" }));
vi.mock("@/lib/portal-access", () => ({
  requireSignedInPrincipal: async () => ({ id: "assigned", email: "assigned@example.test", role: state.role }),
}));
vi.mock("@/lib/pipeline", () => ({ pipelineDeps: async () => ({ db: {} }) }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), cache: <T,>(fn: T) => fn }));
vi.mock("@/pipeline/orchestration/output-channels", () => ({
  listOutputChannelDirectory: async () => [],
  resolveOutputChannelForPrincipal: async () => ({
    channel: { id: "weekly", name: "Weekly", enabled: true },
    context: { role: "editor" },
  }),
}));
vi.mock("../../../app/publishing/publication-generation", () => ({ default: () => null }));
vi.mock("../../../app/publishing/channels", () => ({ default: () => null }));
vi.mock("../../../app/publishing/publication-settings", () => ({ default: () => null }));
vi.mock("../../../app/publishing/source-feedback", () => ({ default: () => null }));
vi.mock("../../../app/newsroom/newsroom-shell", () => ({ default: () => null }));
vi.mock("../../../app/account/settings", () => ({ default: () => null }));
vi.mock("@/lib/display-name", () => ({ principalDisplayName: async () => ({ full: "Assigned", first: "Assigned", initials: "A" }) }));

it.each(["editor", "admin", "owner"])("uses the signed-in %s account, not editor publication membership, for progress diagnostics", async (role) => {
  state.role = role;
  const page = await NewsroomLayout({ params: Promise.resolve({ publicationId: "weekly" }), children: null });
  const generation = Children.toArray(page.props.children).find(
    (child): child is ReactElement<ComponentProps<typeof PublicationGeneration>> =>
      isValidElement(child) && child.type === PublicationGeneration,
  );
  expect(generation).toBeDefined();
  expect(generation!.props.operator).toBe(role !== "editor");
  expect(generation!.props.supportMode).toBe(false);
  expect(page.props.role).toBe(role);
});

it.each([
  ["editor", false, null],
  ["admin", true, false],
  ["owner", true, true],
] as const)("puts API keys in newsroom Settings by role: %s", async (role, keyEditor, ownerSettings) => {
  state.role = role;
  process.env.NEWSBEE_OWNER_EMAIL = "assigned@example.test";
  const layout = await NewsroomLayout({ params: Promise.resolve({ publicationId: "weekly" }), children: null });
  const elements: ReactElement[] = [];
  const walk = (node: unknown) => Children.forEach(node as never, (child) => {
    if (!isValidElement(child)) return;
    elements.push(child);
    walk((child.props as { children?: unknown }).children);
  });
  walk(layout.props.children);
  const keys = elements.find((element) => (element.props as { id?: string }).id === "api-keys")!;
  expect(keys).toBeDefined();
  const editor = elements.find((element) => element.type === AccountSettings);
  expect(Boolean(editor)).toBe(keyEditor);
  if (editor) expect((editor.props as { owner: boolean }).owner).toBe(ownerSettings);
  const text = JSON.stringify(keys.props, (_key, value) => typeof value === "function" ? undefined : value);
  expect(text.includes("Journalists don")).toBe(!keyEditor);
  delete process.env.NEWSBEE_OWNER_EMAIL;
});
