import { adminRoute } from "@/lib/admin-api";
import { releaseVideoStatus } from "@/lib/release-video-usage";
import { COLLECTIONS } from "@/pipeline/storage/mongo";
import { newsletterStatus } from "../../../../../reader-site/src/lib/newsletter";
import { emailUnavailableResponse } from "../../../../../../shared/email-availability";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function publicationStatus(db: Parameters<typeof newsletterStatus>[0]) {
  const [subscriptions, campaigns, deliveries, outbox] = await Promise.all([
    db.collection(COLLECTIONS.publicationEmailSubscriptions).aggregate<{ _id: string; count: number }>([
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]).toArray(),
    db.collection(COLLECTIONS.publicationEmailCampaigns).countDocuments(),
    db.collection(COLLECTIONS.publicationEmailDeliveries).aggregate<{ _id: string; count: number }>([
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]).toArray(),
    db.collection(COLLECTIONS.publicationEmailOutbox).countDocuments(),
  ]);
  return {
    subscriptions: Object.fromEntries(subscriptions.map((row) => [row._id, row.count])),
    campaigns,
    deliveries: Object.fromEntries(deliveries.map((row) => [row._id, row.count])),
    localOutbox: outbox,
  };
}

export async function GET(request: Request) {
  return adminRoute(request, async (deps) => {
    const { db } = deps;
    const status = await newsletterStatus(db);
    const publication = await publicationStatus(db);
    const response = { ...status, publication, releaseVideo: await releaseVideoStatus(deps) };
    return response;
  });
}
export async function POST(request: Request) {
  return adminRoute(request, async () => emailUnavailableResponse());
}
