/** Private reader inquiries and applications. Review never grants workspace access. */
export const COMMUNITY_INTAKE_COLLECTION = "community_intake";
export const INTAKE_KINDS = ["contact", "editor_interest"] as const;
export const INTAKE_STATUSES = ["pending", "in_review", "closed"] as const;
export const CONTACT_TOPICS = ["question", "coverage", "partnership", "other"] as const;
export const EDITOR_INTENTS = ["contribute", "lead", "start_branch"] as const;
export type IntakeKind = typeof INTAKE_KINDS[number];
export type IntakeStatus = typeof INTAKE_STATUSES[number];
export type ContactTopic = typeof CONTACT_TOPICS[number];
export type EditorIntent = typeof EDITOR_INTENTS[number];
export type CommunityIntakeInput = {
  kind: IntakeKind; submitter_name: string; submitter_email: string;
  location_id: string | null; community_name: string | null;
  topic: ContactTopic | null; message: string | null;
  intent: EditorIntent | null; experience: string | null; motivation: string | null;
};
export type CommunityIntake = CommunityIntakeInput & {
  _id: string; status: IntakeStatus; submitted_at: string; consented_at: string; consent_version: "community-intake-v1";
  dedupe_key: string; reviewed_at?: string; reviewed_by?: string; review_note?: string;
  review_history?: { status: IntakeStatus; note: string; at: string; by: string }[];
};
const clean = (value: unknown) => typeof value === "string"
  ? value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim() : "";

export function validateCommunityIntake(kind: IntakeKind, value: unknown): { input: CommunityIntakeInput } | { error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "Send a complete form." };
  const raw = value as Record<string, unknown>;
  if (raw.website !== undefined && (typeof raw.website !== "string" || raw.website.trim())) return { error: "This submission could not be accepted. Please try again." };
  const submitter_name = clean(raw.submitter_name), submitter_email = clean(raw.submitter_email).toLowerCase();
  if (submitter_name.length < 2 || submitter_name.length > 120) return { error: "Enter your name in 2–120 characters." };
  if (submitter_email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(submitter_email)) return { error: "Enter a valid email address so we can reply." };
  if (raw.consent !== true) return { error: "Agree that Newsbee may save this inquiry and contact you about it." };
  const location_id = clean(raw.location_id) || null, community_name = clean(raw.community_name) || null;
  if (location_id && !/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,119}$/.test(location_id)) return { error: "Choose a valid community, or enter its name." };
  if (community_name && (community_name.length < 2 || community_name.length > 160)) return { error: "Enter the community name in 2–160 characters." };
  const common = { kind, submitter_name, submitter_email, location_id, community_name };
  if (kind === "contact") {
    const topic = CONTACT_TOPICS.find(item => item === raw.topic), message = clean(raw.message);
    if (!topic) return { error: "Choose what your message is about." };
    if (message.length < 20 || message.length > 4000) return { error: "Write your message in 20–4,000 characters." };
    return { input: { ...common, topic, message, intent: null, experience: null, motivation: null } };
  }
  const intent = EDITOR_INTENTS.find(item => item === raw.intent), experience = clean(raw.experience), motivation = clean(raw.motivation);
  if (!location_id && !community_name) return { error: "Choose a community or enter the community you would like to cover." };
  if (!intent) return { error: "Choose how you would like to get involved." };
  if (experience.length < 20 || experience.length > 3000) return { error: "Describe your experience in 20–3,000 characters. Community experience counts too." };
  if (motivation.length < 40 || motivation.length > 3000) return { error: "Tell us why this community matters to you in 40–3,000 characters." };
  return { input: { ...common, intent, experience, motivation, topic: null, message: null } };
}

export class CommunityIntakeError extends Error {
  constructor(message: string, public readonly status = 422) { super(message); }
}
