import { safeImageUrl, safePublicHttpsUrl } from "./story-image";

export const PUBLICATION_SETTINGS_SCHEMA_VERSION = 1 as const;
export const PUBLICATION_VOICES = ["neutral", "warm", "formal"] as const;
export const PUBLICATION_STORY_LENGTHS = ["brief", "standard", "detailed"] as const;
export const PUBLICATION_FRONT_DENSITIES = ["compact", "standard"] as const;
export const PUBLICATION_NEWSLETTER_LENGTHS = ["brief", "standard"] as const;
export const SPONSOR_SLOTS = ["home_after_top_news", "home_before_newsroom"] as const;

export type PublicationVoice = typeof PUBLICATION_VOICES[number];
export type PublicationStoryLength = typeof PUBLICATION_STORY_LENGTHS[number];
export type PublicationFrontDensity = typeof PUBLICATION_FRONT_DENSITIES[number];
export type PublicationNewsletterLength = typeof PUBLICATION_NEWSLETTER_LENGTHS[number];
export type SponsorSlot = typeof SPONSOR_SLOTS[number];

export type PublicationProfileValues = {
  display_name: string;
  description: string | null;
  homepage_url: string | null;
  logo_url: string | null;
};

export type PublicationGenerationPreferenceValues = {
  voice: PublicationVoice;
  story_length: PublicationStoryLength;
  front_summary_density: PublicationFrontDensity;
  newsletter_intro_length: PublicationNewsletterLength;
};

export type SponsorPlacement = {
  id: string;
  slot: SponsorSlot;
  sponsor_name: string;
  headline: string;
  body: string;
  landing_url: string;
  image_url: string | null;
  enabled: boolean;
};

export type VersionedPublicationSetting<T> = {
  schema_version: typeof PUBLICATION_SETTINGS_SCHEMA_VERSION;
  revision: number;
  values: T;
  updated_at: number | null;
  updated_by: string | null;
};

export type PublicationPreferenceSnapshot = {
  publication_id: string;
  schema_version: typeof PUBLICATION_SETTINGS_SCHEMA_VERSION;
  revision: number;
  explicit_values: PublicationGenerationPreferenceValues;
};

export type PublicationSettingsView = {
  profile: VersionedPublicationSetting<PublicationProfileValues>;
  generation_preferences: VersionedPublicationSetting<PublicationGenerationPreferenceValues>;
  sponsor_placements: VersionedPublicationSetting<SponsorPlacement[]>;
};

export type PublicationSettingsPatch = {
  profile?: { expected_revision: number; values: unknown };
  generation_preferences?: { expected_revision: number; values: unknown };
  sponsor_placements?: { expected_revision: number; values: unknown };
};

export const DEFAULT_GENERATION_PREFERENCES: PublicationGenerationPreferenceValues = {
  voice: "neutral",
  story_length: "standard",
  front_summary_density: "standard",
  newsletter_intro_length: "standard",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string) {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length) throw new Error(`${label} contains unsupported fields: ${unexpected.join(", ")}`);
}

function text(value: unknown, label: string, maximum: number, required = true) {
  const normalized = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "";
  if (required && !normalized) throw new Error(`${label} is required`);
  if (normalized.length > maximum) throw new Error(`${label} must be ${maximum} characters or fewer`);
  return normalized;
}

function optionalUrl(value: unknown, label: string, image = false) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = image ? safeImageUrl(value) : safePublicHttpsUrl(value);
  if (!normalized) throw new Error(`${label} must be a public HTTPS URL`);
  return normalized;
}

function choice<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (!allowed.includes(value as T)) throw new Error(`${label} must be one of: ${allowed.join(", ")}`);
  return value as T;
}

export function defaultPublicationSettings(name: string): PublicationSettingsView {
  return {
    profile: {
      schema_version: PUBLICATION_SETTINGS_SCHEMA_VERSION,
      revision: 0,
      values: { display_name: name, description: null, homepage_url: null, logo_url: null },
      updated_at: null,
      updated_by: null,
    },
    generation_preferences: {
      schema_version: PUBLICATION_SETTINGS_SCHEMA_VERSION,
      revision: 0,
      values: { ...DEFAULT_GENERATION_PREFERENCES },
      updated_at: null,
      updated_by: null,
    },
    sponsor_placements: {
      schema_version: PUBLICATION_SETTINGS_SCHEMA_VERSION,
      revision: 0,
      values: [],
      updated_at: null,
      updated_by: null,
    },
  };
}

export function parsePublicationProfile(value: unknown): PublicationProfileValues {
  if (!isRecord(value)) throw new Error("Publication profile must be an object");
  exactKeys(value, ["display_name", "description", "homepage_url", "logo_url"], "Publication profile");
  return {
    display_name: text(value.display_name, "Publication display name", 120),
    description: text(value.description, "Publication description", 500, false) || null,
    homepage_url: optionalUrl(value.homepage_url, "Publication homepage"),
    logo_url: optionalUrl(value.logo_url, "Publication logo", true),
  };
}

export function parseGenerationPreferences(value: unknown): PublicationGenerationPreferenceValues {
  if (!isRecord(value)) throw new Error("Generation preferences must be an object");
  exactKeys(value, ["voice", "story_length", "front_summary_density", "newsletter_intro_length"], "Generation preferences");
  return {
    voice: choice(value.voice, PUBLICATION_VOICES, "Voice"),
    story_length: choice(value.story_length, PUBLICATION_STORY_LENGTHS, "Story length"),
    front_summary_density: choice(value.front_summary_density, PUBLICATION_FRONT_DENSITIES, "Front summary density"),
    newsletter_intro_length: choice(value.newsletter_intro_length, PUBLICATION_NEWSLETTER_LENGTHS, "Newsletter intro length"),
  };
}

export function parseSponsorPlacements(value: unknown): SponsorPlacement[] {
  if (!Array.isArray(value) || value.length > SPONSOR_SLOTS.length) throw new Error(`Sponsor placements must contain at most ${SPONSOR_SLOTS.length} entries`);
  const slots = new Set<SponsorSlot>();
  const ids = new Set<string>();
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`Sponsor placement ${index + 1} must be an object`);
    exactKeys(entry, ["id", "slot", "sponsor_name", "headline", "body", "landing_url", "image_url", "enabled"], `Sponsor placement ${index + 1}`);
    const id = text(entry.id, `Sponsor placement ${index + 1} id`, 64);
    if (!/^[A-Za-z0-9_-]+$/.test(id) || ids.has(id)) throw new Error("Sponsor placement ids must be unique letters, numbers, underscores, or hyphens");
    ids.add(id);
    const slot = choice(entry.slot, SPONSOR_SLOTS, "Sponsor slot");
    if (slots.has(slot)) throw new Error(`Only one sponsor placement may use ${slot}`);
    slots.add(slot);
    if (typeof entry.enabled !== "boolean") throw new Error("Sponsor enabled state must be true or false");
    return {
      id,
      slot,
      sponsor_name: text(entry.sponsor_name, "Sponsor name", 120),
      headline: text(entry.headline, "Sponsor headline", 160),
      body: text(entry.body, "Sponsor body", 500),
      landing_url: optionalUrl(entry.landing_url, "Sponsor landing page")!,
      image_url: optionalUrl(entry.image_url, "Sponsor image", true),
      enabled: entry.enabled,
    };
  });
}

export function generationPreferenceInstruction(values: PublicationGenerationPreferenceValues) {
  const voice = {
    neutral: "Use a neutral, direct newsroom voice.",
    warm: "Use a warm but non-promotional community-news voice.",
    formal: "Use a formal, concise newspaper voice.",
  }[values.voice];
  const length = {
    brief: "Prefer 1 to 3 concise sentences when the evidence supports them.",
    standard: "Prefer 3 to 5 sentences, using fewer when the source is sparse.",
    detailed: "Use up to 5 information-dense sentences when the evidence supports the detail.",
  }[values.story_length];
  return `${voice} ${length}`;
}
