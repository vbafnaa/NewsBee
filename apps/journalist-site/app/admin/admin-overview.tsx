import Link from "next/link";

export default function AdminOverview({ campaignLeads }: {
  campaignLeads: { total: number; recent: number };
}) {
  return <p className="admin-overview-summary">
    <Link href="/admin/campaigns">{campaignLeads.total.toLocaleString()} campaign leads</Link>
    <span>{campaignLeads.recent.toLocaleString()} new this week</span>
  </p>;
}
