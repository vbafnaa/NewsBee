import { redirect } from "next/navigation";
import { defaultPortal, requireSignedInPrincipal } from "@/lib/portal-access";

export default async function LocationsPage() {
  const principal = await requireSignedInPrincipal();
  redirect(defaultPortal(principal.role));
}
