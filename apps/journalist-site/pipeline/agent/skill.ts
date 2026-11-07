/**
 * The mapping agent's research judgement lives in skills/map-sources/SKILL.md, so the pipeline and
 * a harness agent follow the same instructions. Its text is compiled into the playbook bundle with
 * its generated category section, so a deployment can't run without it.
 */
import { PLAYBOOK_SKILL } from "../playbook";

export function mappingSkill() {
  return { text: PLAYBOOK_SKILL, loaded: true };
}
