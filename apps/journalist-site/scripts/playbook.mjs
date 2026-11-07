#!/usr/bin/env node
/**
 * `npm run playbook` rebuilds everything made from the playbook. With --check, which runs before
 * every production build, it changes nothing and fails if the playbook is invalid or anything made
 * from it is out of date, so a deployment can't carry rules nobody compiled.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compile, COMPILED_PATH, loadPlaybook, overview, OVERVIEW_PATH, ROOT, SKILL_PATH, skillSection, withSkillSection } from "./playbook-lib.mjs";

const check = process.argv.includes("--check");
try {
  const playbook = loadPlaybook();
  const skill = withSkillSection(readFileSync(SKILL_PATH, "utf8"), skillSection(playbook));
  const compiled = compile(playbook, skill);
  const outputs = [[SKILL_PATH, skill], [COMPILED_PATH, `${JSON.stringify(compiled, null, 1)}\n`], [OVERVIEW_PATH, overview(compiled)]];
  const stale = outputs.filter(([file, text]) => !existsSync(file) || readFileSync(file, "utf8").replace(/\r\n/g, "\n") !== text).map(([file]) => path.relative(ROOT, file));
  if (check && stale.length) throw new Error(`Out of date: ${stale.join(", ")}. Run \`npm run playbook\` in apps/journalist-site and commit the result.`);
  if (!check) for (const [file, text] of outputs) writeFileSync(file, text);
  console.log(`Playbook ${compiled.version}: ${compiled.rules.length} rules${check ? ", up to date" : stale.length ? `, updated ${stale.join(", ")}` : ", nothing to update"}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
