import { auth, isAdminEmail } from "@/auth";
import { redirect } from "next/navigation";
import AdminShell from "../admin-shell";
import OutputChannelManagement from "./output-channel-management";

export default async function OutputChannelPage() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email || !(await isAdminEmail(email))) redirect("/login");

  return (
    <AdminShell email={email} page="output-channel" title="Output channel"
      description="Manage the Newsbee reader site and control whether it serves published editions.">
      <OutputChannelManagement />
    </AdminShell>
  );
}
