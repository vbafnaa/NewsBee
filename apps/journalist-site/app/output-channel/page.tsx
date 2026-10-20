import { currentAdmin } from "@/lib/admin-session";
import { redirect } from "next/navigation";
import AdminShell from "../admin-shell";
import OutputChannelManagement from "./output-channel-management";

export default async function OutputChannelPage() {
  const email = await currentAdmin();
  if (!email) redirect("/login");

  return (
    <AdminShell email={email} page="output-channel" title="Output channel"
      description="Create destinations, select sources, and run channel-specific aggregation and publishing.">
      <OutputChannelManagement />
    </AdminShell>
  );
}
