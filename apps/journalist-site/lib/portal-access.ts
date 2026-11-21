import { redirect } from "next/navigation";
import { currentPrincipal } from "./admin-session";
import type { Principal } from "@/pipeline/accounts/identity";
import { headers } from "next/headers";
import { loginDestination } from "./login-destination";

export function defaultPortal(role: Principal["role"]) {
  return role === "editor" ? "/newsroom" : "/admin";
}

export function canAccessAdmin(role: Principal["role"]) {
  return role === "owner" || role === "admin";
}

export async function requireSignedInPrincipal() {
  const principal = await currentPrincipal();
  if (!principal) {
    const destination = loginDestination((await headers()).get("x-newsbee-return-to"));
    redirect(destination === "/" ? "/login" : `/login?${new URLSearchParams({ callbackUrl: destination })}`);
  }
  return principal;
}

export async function requireOperatorPrincipal() {
  const principal = await requireSignedInPrincipal();
  if (!canAccessAdmin(principal.role)) redirect("/newsroom");
  return principal;
}

export async function requireOwnerPrincipal() {
  const principal = await requireSignedInPrincipal();
  if (principal.role !== "owner") redirect(defaultPortal(principal.role));
  return principal;
}
