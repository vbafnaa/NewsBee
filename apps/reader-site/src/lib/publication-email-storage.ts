export {
  PublicationEmailTokenError,
  PublicationEmailValidationError,
  confirmPublicationEmail,
  publicationEmailConfirmationToken,
  publicationEmailSubscriptionForConfirmationToken,
  publicationEmailSubscriptionForToken,
  recordPublicationEmailConsent,
  unsubscribePublicationEmail,
  updatePublicationEmailPreferences,
} from "../../../journalist-site/pipeline/email/subscriptions";

export function maskedEmail(email: string) {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "your email address";
  return `${local.slice(0, 1)}${"*".repeat(Math.max(2, Math.min(local.length - 1, 6)))}@${domain}`;
}
