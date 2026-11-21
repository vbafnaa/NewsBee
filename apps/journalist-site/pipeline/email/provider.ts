import type { Db } from "mongodb";
import { fakeEmailProvider } from "./fake-provider";

export type EmailProviderResult =
  | { status: "accepted"; providerMessageId: string }
  | { status: "retryable_failed"; detail: string; retryAfterSeconds?: number }
  | { status: "permanent_failed"; detail: string }
  | { status: "unknown"; detail: string };

export type EmailProviderMessage = {
  publicationId: string;
  campaignId: string;
  deliveryId: string;
  idempotencyKey: string;
  to: string;
  subject: string;
  html: string;
  text: string;
};

export interface EmailProvider {
  readonly name: string;
  send(message: EmailProviderMessage): Promise<EmailProviderResult>;
}

export const EMAIL_ACTIVATION_BLOCKERS = [
  "Select and contract a production email service provider.",
  "Configure and verify the publication sending domain.",
  "Publish and validate DKIM and SPF records.",
  "Implement authenticated provider event webhooks.",
  "Configure one shared email-management token secret in the Journalist and Reader deployments.",
  "Complete legal, consent, and deliverability compliance review.",
] as const;

export class EmailActivationBlocked extends Error {
  constructor() {
    super(`Live email delivery is disabled. ${EMAIL_ACTIVATION_BLOCKERS.join(" ")}`);
  }
}

export function configuredEmailProvider(db: Db): EmailProvider {
  const provider = (process.env.NEWSBEE_EMAIL_PROVIDER ?? "fake").trim().toLowerCase();
  const mode = (process.env.NEWSBEE_MODE ?? "local").trim().toLowerCase();
  if (provider === "fake" && mode !== "cloud") return fakeEmailProvider(db);
  throw new EmailActivationBlocked();
}
