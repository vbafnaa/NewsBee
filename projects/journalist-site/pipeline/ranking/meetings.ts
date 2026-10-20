import { compareKeys, type Story } from "../editions/stories";

export const COUNCIL = /\b(city|town|village|borough|county|common) council\b|^council$/i;
export function isCouncil(body: string) { return COUNCIL.test(body); }
export function rank(stories: Story[]): Story[] {
  return [...stories].sort((a, b) => {
    const bodyA = String(a.facts.body || a.title);
    const bodyB = String(b.facts.body || b.title);
    return compareKeys(
      [!isCouncil(bodyA), a.first.event_date, -Number(a.facts.agenda_items || 0), a.title],
      [!isCouncil(bodyB), b.first.event_date, -Number(b.facts.agenda_items || 0), b.title],
    );
  });
}
