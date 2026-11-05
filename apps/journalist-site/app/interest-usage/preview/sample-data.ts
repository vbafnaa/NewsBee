import type { UsageRow, UsageSummary } from "@/pipeline/analytics/usage";

const communities: UsageRow[] = [
  { id: "sample-center", name: "Sample Seattle Center", latitude: 47.6062, longitude: -122.3321, onboarded: true, reads: 34, subscriptions: 8, interest: 12 },
  { id: "sample-coincident", name: "Sample Shared-coordinate Community", latitude: 47.6062, longitude: -122.3321, onboarded: false, reads: 11, subscriptions: 3, interest: 7 },
  { id: "sample-pike", name: "Sample Pike Market", latitude: 47.609, longitude: -122.342, onboarded: true, reads: 20, subscriptions: 4, interest: 6 },
  { id: "sample-south", name: "Sample South Seattle", latitude: 47.6035, longitude: -122.33, onboarded: true, reads: 15, subscriptions: 2, interest: 5 },
  { id: "sample-tacoma", name: "Sample Tacoma", latitude: 47.2529, longitude: -122.4443, onboarded: true, reads: 25, subscriptions: 6, interest: 9 },
  { id: "sample-portland", name: "Sample Portland", latitude: 45.5152, longitude: -122.6784, onboarded: false, reads: 8, subscriptions: 0, interest: 4 },
  { id: "sample-unmapped", name: "Sample Unmapped Request", latitude: null, longitude: null, onboarded: false, reads: 3, subscriptions: 1, interest: 10 },
  { id: "sample-missing-longitude", name: "Sample Missing Longitude", latitude: 47.6, longitude: null, onboarded: false, reads: 2, subscriptions: 0, interest: 3 },
];

export async function loadSampleUsage(range: string): Promise<UsageSummary> {
  const params = new URLSearchParams(range);
  const from = params.get("from"), to = params.get("to");
  const days = ["2026-10-01", "2026-10-02"].filter((date) => (!from || date >= from) && (!to || date <= to));
  const rows = days.length ? communities.map((row) => ({
    ...row, reads: row.reads * days.length, subscriptions: row.subscriptions * days.length, interest: row.interest * days.length,
  })) : [];
  return {
    rows,
    totals: rows.reduce((total, row) => ({ reads: total.reads + row.reads, subscriptions: total.subscriptions + row.subscriptions, interest: total.interest + row.interest }), { reads: 0, subscriptions: 0, interest: 0 }),
    history: { first_read: "2026-10-01T00:00:00Z", first_subscription: "2026-10-01T00:00:00Z", first_interest: "2026-10-01T00:00:00Z", unclassified_legacy_signups: 2 },
  };
}
