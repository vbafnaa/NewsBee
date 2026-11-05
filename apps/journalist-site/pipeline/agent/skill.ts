/**
 * The mapping agent's research judgement lives in skills/map-sources/SKILL.md, so the pipeline
 * and a harness agent follow the same instructions. If the file isn't in a deployment's bundle,
 * the agent falls back to the short criteria below, and says so in its plan.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const FALLBACK = "Prefer original civic records, police and sheriff logs, school and athletics pages, funeral homes, venues, county assessor or recorder records, and first-party updates, over news that repeats them. A source may cover a whole city or county if each item can be filtered to the place. Look only for public local records and pages: never for login pages, admin pages or exposed files of personal data.";

let cached: { text: string; loaded: boolean } | null = null;

export function mappingSkill() {
  if (cached) return cached;
  for (const root of [process.cwd(), path.join(process.cwd(), ".."), path.join(process.cwd(), "..", "..")]) {
    try {
      // Only the instructions: the frontmatter means nothing to the model.
      const text = readFileSync(path.join(root, "skills", "map-sources", "SKILL.md"), "utf8").replace(/^---[\s\S]*?---\s*/, "").trim();
      if (text) { cached = { text, loaded: true }; return cached; }
    } catch { /* try the next root */ }
  }
  cached = { text: FALLBACK, loaded: false };
  return cached;
}
