/**
 * Sorting search results, pages and items into source tiers. Rules always run. Jev (TypeSafe's
 * typed classifier) can run alongside them in `shadow` mode, recording scores that change
 * nothing, or in `jev` mode, where its answers set the tier and fetch order. A score moves a
 * result in the queue; it never deletes one, and never sets `inside_area`. With no key or a
 * failed call the run continues on rules alone.
 *
 * Jev answers questions about the JSON it is sent and does not browse, so it gets the URL,
 * title, snippet, query and topic, plus an excerpt once a page has been fetched. Only public
 * content is sent. Endpoint: TYPESAFE_API_KEY -> https://api.typesafe.ai/v1/systemone, or
 * OPENROUTER_API_KEY -> https://openrouter.ai/api/v1/systemone.
 */
import type { Settings } from "../core/config";
import type { HttpTransport } from "../core/http";
import { currentOptions } from "../core/run-options";
import { aggregator } from "../connectors/newssearch";
import { paidCall } from "../trace/gateway";
import { hostOf, type SourceTier } from "../sourcemap/store";

export type ClassifierInput = { url: string; title: string; snippet: string; query?: string; topic?: string | null; place: string; excerpt?: string };
export type Classification = { tier: SourceTier; fetch: number; local: number | null; decided_by: "rules" | "jev"; model: string | null; rules_tier: SourceTier; jev: Record<string, unknown> | null };

const NEWS = /news|times|herald|gazette|tribune|journal|post|blog|press|courier|chronicle|observer|sentinel|examiner|weekly|daily|patch\.com/i;
const REPOST = /newsbreak|msn\.com|yahoo\.com|ground\.news|flipboard|aol\.com|smartnews|newsbreakapp/i;

export function ruleTier(url: string, title = ""): SourceTier {
  const host = hostOf(url);
  if (REPOST.test(host) || aggregator(url)) return "repost";
  if (/\.gov$|\.gov\.|\.us$|\.mil$|^(data|city|county)\./.test(host) || /\.k12\.|\.edu$/.test(host)) return "official";
  if (NEWS.test(host) || NEWS.test(title) && !/\.org$/.test(host)) return "local_reporting";
  if (/\.org$|\.church$|\.foundation$/.test(host)) return "organisation";
  return "business";
}

const CRITERIA = {
  official: "A government agency, public school, court or public body publishing its own records",
  organisation: "A local nonprofit, association, league, club or community group publishing its own updates",
  business: "A local business, venue or funeral home publishing its own updates",
  local_reporting: "A local news outlet doing its own original reporting",
  repost: "A site that rewrites or aggregates other sources, or a national site",
  irrelevant: "Not related to this place",
};

async function askJev(settings: Settings, transport: HttpTransport, input: ClassifierInput) {
  const { typesafeKey, typesafeBase, openrouterKey, jevModel } = settings.integrations;
  const direct = Boolean(typesafeKey);
  const key = typesafeKey ?? openrouterKey;
  if (!key) return null;
  const url = direct ? `${typesafeBase}/v1/systemone` : "https://openrouter.ai/api/v1/systemone";
  const outcome = await paidCall("jev", async () => {
    const response = await transport({
      url, method: "POST", timeoutMs: 20_000, headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: jevModel,
        state: { url: input.url, title: input.title, snippet: input.snippet, query: input.query ?? null, topic: input.topic ?? null, place: input.place, page_excerpt: input.excerpt?.slice(0, 2000) ?? null },
        questions: {
          source_type: { type: "choice", instructions: "What kind of source published this page?", criteria: CRITERIA },
          worth_fetching: { type: "noul", instructions: `Is this page likely to give original, recent local information about ${input.place}${input.topic ? ` on the topic ${input.topic}` : ""}?` },
          local: { type: "noul", instructions: `Does this page explicitly concern ${input.place}?` },
        },
      }),
    });
    if (response.status >= 400) throw new Error(`Jev returned HTTP ${response.status}`);
    return JSON.parse(new TextDecoder().decode(response.body)) as { model?: string; answers?: Record<string, { choice?: string; noul?: number; confidence?: number }>; usage?: { cost?: number } };
  }, (value) => value.usage?.cost ?? null);
  return outcome.value;
}

export async function classify(settings: Settings, transport: HttpTransport, input: ClassifierInput): Promise<Classification> {
  const rules = ruleTier(input.url, input.title);
  const base: Classification = { tier: rules, fetch: rules === "repost" ? 0.1 : rules === "official" ? 0.9 : 0.6, local: null, decided_by: "rules", model: null, rules_tier: rules, jev: null };
  const mode = currentOptions().classifier;
  if (mode === "off") return base;
  const answer = await askJev(settings, transport, input).catch(() => null);
  if (!answer?.answers) return base;
  const jev = { source_type: answer.answers.source_type?.choice ?? null, confidence: answer.answers.source_type?.confidence ?? null, worth_fetching: answer.answers.worth_fetching?.noul ?? null, local: answer.answers.local?.noul ?? null };
  if (mode === "shadow") return { ...base, jev, model: answer.model ?? settings.integrations.jevModel };
  const tier = jev.source_type && jev.source_type !== "irrelevant" ? jev.source_type as SourceTier : rules;
  return { tier, fetch: jev.worth_fetching ?? base.fetch, local: jev.local, decided_by: "jev", model: answer.model ?? settings.integrations.jevModel, rules_tier: rules, jev };
}
