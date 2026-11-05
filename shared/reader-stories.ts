/**
 * Stories neighbours submit on the reader site ("Share your story"). A submission is stored
 * as `pending`; an editor approves or rejects it in the journalist workspace; only approved
 * stories reach the community connector. The submitter's name and email are kept so the
 * editor can confirm details, and are never published.
 */
export const READER_STORIES_COLLECTION = "reader_story_submissions";
export const STORY_MIN = 80;
export const STORY_MAX = 2000;
export const HEADLINE_MAX = 120;
export const STORY_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export type ReaderStoryImage = {
  data: string;
  mime_type: "image/jpeg";
  caption: string;
  credit: string;
  permission_confirmed_at: string;
};
export const STORY_TOPICS = ["news", "event", "business", "schools", "people", "other"] as const;
export type StoryTopic = typeof STORY_TOPICS[number];

export type ReaderStoryStatus = "pending" | "approved" | "rejected";
export type ReaderStory = {
  _id: string;
  location_id: string;
  location_name: string;
  headline: string;
  story: string;
  topic: StoryTopic;
  /** Optional public link with more detail (an event page, a petition, photos). */
  link: string | null;
  /** Optional date the story is about (an upcoming event), YYYY-MM-DD. */
  event_date: string | null;
  submitter_name: string;
  submitter_email: string;
  /** How the submitter wants to be credited: by first name, or as "a neighbour". */
  credit: "name" | "anonymous";
  status: ReaderStoryStatus;
  submitted_at: string;
  decided_at?: string | null;
  decided_by?: string | null;
  reason?: string | null;
  /** Re-encoded photo, private until an editor approves the submission. */
  image?: ReaderStoryImage | null;
};
export type ReaderStoryInput = Pick<ReaderStory, "headline" | "story" | "topic" | "link" | "event_date" | "submitter_name" | "submitter_email" | "credit">;

const clean = (value: unknown, max: number) => typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/[ \t]+/g, " ").trim().slice(0, max + 1) : "";

/** Validated input, or the reason it cannot be accepted. */
export function validateReaderStory(value: unknown, today = new Date().toISOString().slice(0, 10)): { input: ReaderStoryInput } | { error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "Submission must be a JSON object" };
  const raw = value as Record<string, unknown>;
  const headline = clean(raw.headline, HEADLINE_MAX), story = clean(raw.story, STORY_MAX);
  const submitter_name = clean(raw.submitter_name, 120), submitter_email = clean(raw.submitter_email, 254).toLowerCase();
  const topic = STORY_TOPICS.find((item) => item === raw.topic) ?? null;
  const linkText = clean(raw.link, 2000), dateText = clean(raw.event_date, 10);
  if (headline.length < 8 || headline.length > HEADLINE_MAX) return { error: `Give your story a headline of 8-${HEADLINE_MAX} characters` };
  if (story.length < STORY_MIN || story.length > STORY_MAX) return { error: `Tell the story in ${STORY_MIN}-${STORY_MAX} characters` };
  if (!topic) return { error: "Choose what the story is about" };
  if (!submitter_name || submitter_name.length > 120) return { error: "Enter your name" };
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(submitter_email)) return { error: "Enter a valid email address so an editor can check details with you" };
  if (raw.credit !== "name" && raw.credit !== "anonymous") return { error: "Choose how you would like to be credited" };
  if (raw.consent !== true) return { error: "Confirm the story is accurate to your knowledge and that Newsbee may publish it after an editor reviews it" };
  let link: string | null = null;
  if (linkText) {
    try {
      const url = new URL(linkText);
      if (url.protocol !== "https:" || url.username || url.password) throw new Error();
      link = url.toString();
    } catch { return { error: "The optional link must be a public https:// address" }; }
  }
  let event_date: string | null = null;
  if (dateText) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText) || Number.isNaN(Date.parse(`${dateText}T00:00:00Z`))) return { error: "Use a valid date" };
    if (dateText < today) return { error: "The date should be today or later; leave it empty for news that already happened" };
    event_date = dateText;
  }
  return { input: { headline, story, topic, link, event_date, submitter_name, submitter_email, credit: raw.credit } };
}

/** The public credit line: the submitter's first name, or "a neighbour". */
export function creditLine(story: Pick<ReaderStory, "credit" | "submitter_name">) {
  const first = story.submitter_name.split(/\s+/)[0];
  return story.credit === "name" && first ? `${first}, a neighbour` : "a neighbour";
}

export function storyImageResponse(image: ReaderStoryImage) {
  const bytes = Uint8Array.from(atob(image.data), (character) => character.charCodeAt(0));
  return new Response(bytes, { headers: {
    "Content-Type": image.mime_type, "Content-Length": String(bytes.length),
    "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  } });
}
