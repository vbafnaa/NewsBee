import { redirect } from "next/navigation";
import { currentPrincipal } from "@/lib/admin-session";
import { defaultPortal } from "@/lib/portal-access";

export default async function Home() {
  const principal = await currentPrincipal();
  redirect(principal ? defaultPortal(principal.role) : "/reader");
}
