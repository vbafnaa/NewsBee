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
import { fill, regex, table, template } from "../playbook";
import { paidCall } from "../trace/gateway";
import { hostOf, type SourceTier } from "../sourcemap/store";

export type ClassifierInput = { url: string; title: string; snippet: string; query?: string; topic?: string | null; place: string; excerpt?: string };
export type Classification = { tier: SourceTier; fetch: number; local: number | null; decided_by: "rules" | "jev"; model: string | null; rules_tier: SourceTier; jev: Record<string, unknown> | null };

const NEWS = regex("general.evidence.tier_news_names");
const OFFICIAL_HOST = regex("general.evidence.tier_official_hosts");
const SCHOOL_HOST = regex("general.evidence.tier_school_hosts");
/** A parent group is a local organisation wherever it is hosted, and its "newsletter" is not a newsroom. */
const PARENT_GROUP_TITLE = regex("general.evidence.tier_parent_group_title");
const PARENT_GROUP_HOST = regex("general.evidence.tier_parent_group_host");
const NEWS_TITLE_EXCEPTION = regex("general.evidence.tier_news_title_exception");
const ORGANISATION_HOST = regex("general.evidence.tier_organisation_hosts");
const REPOST = regex("general.reject.repost_hosts");
const FETCH_ORDER = table<number>("general.evidence.fetch_order");

export function ruleTier(url: string, title = ""): SourceTier {
  const host = hostOf(url);
  if (REPOST.test(host) || aggregator(url)) return "repost";
  if (OFFICIAL_HOST.test(host) || SCHOOL_HOST.test(host)) return "official";
  if (PARENT_GROUP_TITLE.test(title) || PARENT_GROUP_HOST.test(host)) return "organisation";
  if (NEWS.test(host) || NEWS.test(title) && !NEWS_TITLE_EXCEPTION.test(host)) return "local_reporting";
  if (ORGANISATION_HOST.test(host)) return "organisation";
  return "business";
}

const CRITERIA = table("general.evidence.jev_tier_criteria");

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
          source_type: { type: "choice", instructions: template("general.evidence.jev_source_type"), criteria: CRITERIA },
          worth_fetching: { type: "noul", instructions: fill(template("general.evidence.jev_worth_fetching"), { place: input.place, topic_clause: input.topic ? fill(template("general.evidence.jev_topic_clause"), { topic: input.topic }) : "" }) },
          local: { type: "noul", instructions: fill(template("general.evidence.jev_local"), { place: input.place }) },
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
  const base: Classification = { tier: rules, fetch: FETCH_ORDER[rules] ?? FETCH_ORDER.default, local: null, decided_by: "rules", model: null, rules_tier: rules, jev: null };
  const mode = currentOptions().classifier;
  if (mode === "off") return base;
  const answer = await askJev(settings, transport, input).catch(() => null);
  if (!answer?.answers) return base;
  const jev = { source_type: answer.answers.source_type?.choice ?? null, confidence: answer.answers.source_type?.confidence ?? null, worth_fetching: answer.answers.worth_fetching?.noul ?? null, local: answer.answers.local?.noul ?? null };
  if (mode === "shadow") return { ...base, jev, model: answer.model ?? settings.integrations.jevModel };
  const tier = jev.source_type && jev.source_type !== "irrelevant" ? jev.source_type as SourceTier : rules;
  return { tier, fetch: jev.worth_fetching ?? base.fetch, local: jev.local, decided_by: "jev", model: answer.model ?? settings.integrations.jevModel, rules_tier: rules, jev };
}
