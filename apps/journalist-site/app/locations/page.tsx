import { redirect } from "next/navigation";
import { currentPrincipal } from "@/lib/admin-session";
import AdminShell from "../admin-shell";
import LocationDirectory from "./location-directory";

export default async function LocationsPage() {
  const principal = await currentPrincipal();
  if (!principal) redirect("/login");
  const email = principal.email;
  return <AdminShell email={email} page="locations" title="Overview"
    description="Current runs across your newsroom, followed by locations and their source coverage.">
    <LocationDirectory owner={principal.role === "owner"} />
  </AdminShell>;
}
