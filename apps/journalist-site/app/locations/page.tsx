import { redirect } from "next/navigation";
import { currentPrincipal } from "@/lib/admin-session";
import AdminShell from "../admin-shell";
import LocationDirectory from "./location-directory";

export default async function LocationsPage() {
  const principal = await currentPrincipal();
  if (!principal) redirect("/login");
  const email = principal.email;
  return <AdminShell email={email} page="locations" title="Overview"
    description="Your newsroom locations and their current source coverage.">
    <LocationDirectory owner={principal.role === "owner"} />
  </AdminShell>;
}
