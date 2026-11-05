/**
 * Family-submitted death notices. The reader site stores a submission as `pending`; an
 * editor approves or rejects it in the journalist workspace; only approved notices reach
 * the remembrance connector. The submitter's name and email are kept for the editor to
 * confirm the notice and are never published.
 */
export const REMEMBRANCE_COLLECTION = "obituary_submissions";
export const NOTICE_MAX = 1500;

export type RemembranceStatus = "pending" | "approved" | "rejected";
export type RemembranceSubmission = {
  _id: string;
  location_id: string;
  location_name: string;
  /** The person who died, as the family wants them named. */
  person_name: string;
  notice: string;
  /** Optional public link (a funeral home page or service livestream). */
  link: string | null;
  submitter_name: string;
  submitter_email: string;
  relationship: string;
  status: RemembranceStatus;
  submitted_at: string;
  decided_at?: string | null;
  decided_by?: string | null;
  reason?: string | null;
};

export type RemembranceInput = Pick<RemembranceSubmission, "person_name" | "notice" | "link" | "submitter_name" | "submitter_email" | "relationship">;

const clean = (value: unknown, max: number) => typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/[ \t]+/g, " ").trim().slice(0, max + 1) : "";

/** Validated input, or the reason it cannot be accepted. */
export function validateRemembrance(value: unknown): { input: RemembranceInput } | { error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "Submission must be a JSON object" };
  const raw = value as Record<string, unknown>;
  const person_name = clean(raw.person_name, 120), notice = clean(raw.notice, NOTICE_MAX);
  const submitter_name = clean(raw.submitter_name, 120), relationship = clean(raw.relationship, 80);
  const submitter_email = clean(raw.submitter_email, 254).toLowerCase();
  const linkText = clean(raw.link, 2000);
  if (!person_name || person_name.length > 120) return { error: "Enter the name of the person who died (up to 120 characters)" };
  if (notice.length < 40 || notice.length > NOTICE_MAX) return { error: `Write a notice of 40-${NOTICE_MAX} characters` };
  if (!submitter_name || submitter_name.length > 120) return { error: "Enter your name" };
  if (!relationship || relationship.length > 80) return { error: "Say how you are related to them, or that you represent the family" };
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(submitter_email)) return { error: "Enter a valid email address so an editor can confirm the notice" };
  if (raw.consent !== true) return { error: "Confirm that you are family or authorised by the family, and agree to publication" };
  let link: string | null = null;
  if (linkText) {
    try {
      const url = new URL(linkText);
      if (url.protocol !== "https:" || url.username || url.password) throw new Error();
      link = url.toString();
    } catch { return { error: "The optional link must be a public https:// address" }; }
  }
  return { input: { person_name, notice, link, submitter_name, submitter_email, relationship } };
}
