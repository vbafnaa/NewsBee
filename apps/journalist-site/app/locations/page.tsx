import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/admin-session";
import AdminShell from "../admin-shell";
import LocationDirectory from "./location-directory";

export default async function LocationsPage() {
  const email = await currentAdmin();
  if (!email) redirect("/login");
  return <AdminShell email={email} page="locations" title="Location workspaces"
    description="Choose a community desk or onboard a new location. Each desk connects its inputs, source review, staged pipeline and editions.">
    <LocationDirectory />
  </AdminShell>;
}
