/**
 * Optional AI link discovery (NEWSBEE_AI_LINK_DISCOVERY). The model only *chooses* among
 * links actually present on a fetched page; it never invents URLs, and every pick is then
 * validated by the same rule-based connector code. The connector keeps whichever path
 * (rules or AI) yields more valid events.
 */
import { Parser } from "htmlparser2";
import type { Logger } from "../core/log";
import type { ModelRuntime } from "../model/runtime";
import { httpsLink } from "./common";
import type { CollectedSource } from "./types";

export const MAX_LINKS_OFFERED = 150;
export const MAX_LINKS_CHOSEN = 3;

export type PageLink = { url: string; text: string };

/** Every https anchor on a page, absolute and de-duplicated, in page order. */
export function pageLinks(html: string, pageUrl: string, limit = MAX_LINKS_OFFERED): PageLink[] {
  const links: PageLink[] = [];
  const seen = new Set<string>();
  let current: { href: string; text: string[] } | null = null;
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (name === "a" && attributes.href) current = { href: attributes.href, text: [] };
      },
      ontext(data) {
        current?.text.push(data);
      },
      onclosetag(name) {
        if (name !== "a" || !current) return;
        let absolute: string | null = null;
        try {
          absolute = httpsLink(new URL(current.href, pageUrl).toString().split("#")[0]);
        } catch {
          absolute = null;
        }
        if (absolute && !seen.has(absolute) && links.length < limit) {
          seen.add(absolute);
          links.push({ url: absolute, text: current.text.join(" ").replace(/\s+/g, " ").trim().slice(0, 120) });
        }
        current = null;
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  return links;
}

const CHOICE_SCHEMA = {
  type: "object",
  properties: { urls: { type: "array", items: { type: "string" }, maxItems: MAX_LINKS_CHOSEN } },
  required: ["urls"],
};

/**
 * Ask the model which offered links most likely lead to `purpose`. Returns only URLs that
 * were offered; any model failure returns [] so the rule-based path is unaffected.
 */
export async function chooseLinks(
  model: ModelRuntime,
  purpose: string,
  pageUrl: string,
  links: PageLink[],
  log?: Logger,
): Promise<string[]> {
  if (!links.length) return [];
  const offered = new Set(links.map((link) => link.url));
  const prompt = [
    `You help a community newsletter find ${purpose}.`,
    `These links appear on ${pageUrl}. Choose up to ${MAX_LINKS_CHOSEN} links most likely to lead to ${purpose}.`,
    "Only copy URLs exactly from the list. Return an empty list if none fit.",
    "",
    ...links.map((link) => `- ${link.url} | ${link.text || "(no text)"}`),
  ].join("\n");
  try {
    const generation = await model.generateStructured(prompt, CHOICE_SCHEMA, { numPredict: 512 });
    const parsed = JSON.parse(generation.response) as { urls?: unknown };
    const urls = Array.isArray(parsed.urls) ? parsed.urls : [];
    return [...new Set(urls.filter((url): url is string => typeof url === "string" && offered.has(url)))].slice(
      0,
      MAX_LINKS_CHOSEN,
    );
  } catch (error) {
    log?.warn("ai_link_discovery_failed", { page: pageUrl, error: String(error) });
    return [];
  }
}

/** Keep whichever run found more valid events; ties keep the rule-based run. */
export function moreEvents(rules: CollectedSource, ai: CollectedSource | null): CollectedSource {
  if (!ai || ai.events.length <= rules.events.length) {
    return { ...rules, result: { ...rules.result, link_discovery: rules.result.link_discovery ?? { method: "rules" } } };
  }
  return {
    ...ai,
    result: { ...ai.result, link_discovery: { method: "ai", detail: `AI found ${ai.events.length} vs rules ${rules.events.length}` } },
  };
}
