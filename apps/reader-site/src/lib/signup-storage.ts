import type { Db } from "mongodb";

/** One record per email/location, with the first observed timestamp for each explicit intent. */
export async function recordReaderSignup(db: Db, location: { id: string; name: string }, email: string, launchNotification: boolean) {
  const collection = db.collection("reader_interest_signups");
  await collection.createIndex({ location_id: 1, email: 1 }, { unique: true, name: "location_email_unique" });
  const metric = launchNotification ? "interest_signup_at" : "subscription_signup_at";
  await collection.updateOne({ location_id: location.id, email }, [{
    $set: {
      location_id: { $literal: location.id }, email: { $literal: email }, location_name: { $literal: location.name },
      legacy_signup: { $ifNull: ["$legacy_signup", { $ne: [{ $type: "$created_at" }, "missing"] }] },
      created_at: { $ifNull: ["$created_at", "$$NOW"] },
      [metric]: { $ifNull: [`$${metric}`, "$$NOW"] },
      consent_version: launchNotification ? "weekly-editions-v1" : "weekly-editions-v2",
      consented_at: "$$NOW", weekly_editions: true, launch_notification: launchNotification,
    },
  }], { upsert: true });
}
