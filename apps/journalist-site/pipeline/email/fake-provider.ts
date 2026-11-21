import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { COLLECTIONS } from "../storage/mongo";
import type { EmailProvider, EmailProviderMessage, EmailProviderResult } from "./provider";

type FakeOutboxDocument = EmailProviderMessage & {
  _id: string;
  provider: "fake";
  idempotency_key: string;
  publication_id: string;
  result: EmailProviderResult;
  created_at: number;
};

function configuredResult(to: string): EmailProviderResult {
  const local = to.split("@")[0].toLowerCase();
  if (local.includes("unknown")) return { status: "unknown", detail: "Fake provider returned an ambiguous timeout." };
  if (local.includes("retryable")) return { status: "retryable_failed", detail: "Fake provider is temporarily unavailable.", retryAfterSeconds: 1 };
  if (local.includes("permanent")) return { status: "permanent_failed", detail: "Fake provider rejected this recipient." };
  return { status: "accepted", providerMessageId: `fake-${randomUUID()}` };
}

export function fakeEmailProvider(db: Db): EmailProvider {
  const outbox = db.collection<FakeOutboxDocument>(COLLECTIONS.publicationEmailOutbox);
  return {
    name: "fake",
    async send(message) {
      const existing = await outbox.findOne({ idempotency_key: message.idempotencyKey });
      if (existing) return existing.result;
      const result = configuredResult(message.to);
      try {
        await outbox.insertOne({
          _id: randomUUID(),
          provider: "fake",
          idempotency_key: message.idempotencyKey,
          publication_id: message.publicationId,
          ...message,
          result,
          created_at: Date.now(),
        });
        return result;
      } catch (error) {
        if ((error as { code?: number }).code !== 11000) throw error;
        const raced = await outbox.findOne({ idempotency_key: message.idempotencyKey });
        if (raced) return raced.result;
        throw error;
      }
    },
  };
}
