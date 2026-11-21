import AdminShell from "@/app/admin-shell";
import Link from "next/link";
import PublishingChannels from "@/app/publishing/channels";
import { requireOperatorPrincipal } from "@/lib/portal-access";

export default async function AdminPublicationSupportPage({
  params,
}: {
  params: Promise<{ publicationId: string }>;
}) {
  const principal = await requireOperatorPrincipal();
  const { publicationId } = await params;
  return <AdminShell
    email={principal.email}
    page="output-channels"
    title="Newsroom maintenance"
    description="Delivery and storage settings. Inspection is read-only unless you have direct access or deliberate support."
  >
    <p><Link href="/admin/publications">Back to newsrooms</Link>{" · "}
      <Link href={`/admin/publication-governance?publicationId=${encodeURIComponent(publicationId)}`}>Activity &amp; governance</Link></p>
    <PublishingChannels
      channelId={publicationId}
      email={principal.email}
      surface="admin"
      canDelete={principal.role === "owner"}
    />
  </AdminShell>;
}
