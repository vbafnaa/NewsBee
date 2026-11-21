import { Children, isValidElement, createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Principal } from "../../accounts/identity";

const mocks = vi.hoisted(() => ({
  principal: vi.fn<() => Promise<Principal | null>>(),
  headers: new Headers(),
  signIn: vi.fn(),
}));
vi.mock("@/auth", () => ({ signIn: mocks.signIn }));
vi.mock("@/lib/admin-session", () => ({ currentPrincipal: mocks.principal }));
vi.mock("next/headers", () => ({ headers: async () => mocks.headers }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));

import Home from "../../../app/page";
import Login from "../../../app/login/page";
import CredentialLogin from "../../../app/login/credential-login";
import { AdminNavigation, AdminSectionNavigation } from "../../../app/admin-navigation";
import { requireOperatorPrincipal, requireSignedInPrincipal } from "../../../lib/portal-access";
import { loginDestination } from "../../../lib/login-destination";
import { middleware } from "../../../middleware";

type Props = { children?: ReactNode; destination?: string; action?: () => Promise<void> };
function elements(node: ReactNode): ReactElement<Props>[] {
  return Children.toArray(node).flatMap((child) => isValidElement<Props>(child)
    ? [child, ...elements(child.props.children)] : []);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.headers = new Headers({ host: "newsbee.test", "x-forwarded-proto": "https" });
  mocks.principal.mockResolvedValue(null);
});

describe("real portal entry and login boundaries", () => {
  it.each([
    [null, "/reader"],
    ["owner", "/admin"],
    ["admin", "/admin"],
    ["editor", "/newsroom"],
  ] as const)("sends root role %s to %s without provider configuration", async (role, destination) => {
    if (role) mocks.principal.mockResolvedValue({ id: "principal", email: "fixture@newsbee.test", role });
    await expect(Home()).rejects.toThrow(`redirect:${destination}`);
  });

  it.each([
    [undefined, "/"],
    ["/reader?edition=latest#story", "/reader?edition=latest#story"],
    ["/reader?q=town%20hall#story", "/reader?q=town%20hall#story"],
    ["https://newsbee.test/newsroom/assigned?draft=revision#editions", "/newsroom/assigned?draft=revision#editions"],
    ["https://elsewhere.test/reader", "/"],
    ["/login?callbackUrl=/login", "/"],
  ])("passes the same safe destination %s to password and Google sign-in", async (callbackUrl, destination) => {
    const tree = elements(await Login({ searchParams: Promise.resolve({ callbackUrl }) }));
    expect(tree.find((element) => element.type === CredentialLogin)?.props.destination).toBe(destination);
    const action = tree.find((element) => element.type === "form")?.props.action;
    expect(action).toBeTypeOf("function");
    await action!();
    expect(mocks.signIn).toHaveBeenCalledWith("google", { redirectTo: destination });
  });

  it("preserves the actual protected deep link and overwrites a forged return-path header", async () => {
    const request = new NextRequest("https://newsbee.test/newsroom/assigned?draft=revision", {
      headers: { "x-newsbee-return-to": "https://elsewhere.test" },
    });
    const response = middleware(request);
    const path = response.headers.get("x-middleware-request-x-newsbee-return-to");
    expect(path).toBe("/newsroom/assigned?draft=revision");
    mocks.headers.set("x-newsbee-return-to", path!);
    await expect(requireSignedInPrincipal()).rejects.toThrow(
      "redirect:/login?callbackUrl=%2Fnewsroom%2Fassigned%3Fdraft%3Drevision",
    );
  });

  it("does not grant a journalist provider settings through a return link", async () => {
    mocks.principal.mockResolvedValue({ id: "journalist", email: "journalist@newsbee.test", role: "editor" });
    await expect(requireOperatorPrincipal()).rejects.toThrow("redirect:/newsroom");
  });

  it.each([
    "//elsewhere.test/path", "/\\elsewhere.test", "/%5celsewhere.test", "/%2f%2felsewhere.test",
    "javascript:alert(1)", "/api/auth/signin", "/%6cogin", "/reader%0aevil", "/reader\nbad",
  ])("rejects unsafe or looping return destination %s", (value) => {
    expect(loginDestination(value, "https://newsbee.test")).toBe("/");
  });

  it.each([true, false])("puts truthful owner=%s provider settings in primary navigation", (owner) => {
    const markup = renderToStaticMarkup(createElement(AdminNavigation, { page: "account", owner }));
    const label = owner ? "Environment &amp; API settings" : "Personal API keys";
    expect(markup).toContain(`href="/account">${label}</a>`);
    expect(markup).toContain('href="/admin/video-campaigns">Marketing</a>');
    expect(markup).not.toContain('href="/video-studio"');
    expect(markup).not.toContain("Legacy video studio");
    expect(markup).toContain('aria-current="page"');
  });

  it("only exposes the local article evaluator when the server explicitly enables it", () => {
    const deployed = renderToStaticMarkup(createElement(AdminNavigation, { page: "locations", owner: true }));
    expect(deployed).not.toContain('href="/article-review"');
    expect(deployed).toContain('href="/inbox">Inbox</a>');
    expect(deployed.match(/href="\/admin\/video-campaigns"/g)).toHaveLength(1);
    const deployedSystem = renderToStaticMarkup(createElement(AdminSectionNavigation, { page: "health", owner: true }));
    expect(deployedSystem).not.toContain('href="/article-review"');
    const local = renderToStaticMarkup(createElement(AdminSectionNavigation, { page: "health", owner: true, localArticleReview: true }));
    expect(local).toContain('href="/article-review">Article generation review (local)</a>');
    const adminLocal = renderToStaticMarkup(createElement(AdminSectionNavigation, { page: "health", owner: false, localArticleReview: true }));
    expect(adminLocal).not.toContain('href="/article-review"');
  });
});
