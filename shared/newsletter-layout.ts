/** Used by publication and the reader, including editions written before sectioning existed. */
export function isUpcoming(kind: string | undefined) {
  return kind === "event" || kind === "meeting_preview";
}

export function newsletterOrder(a: { kind?: string; local?: boolean; rank: number | null }, b: { kind?: string; local?: boolean; rank: number | null }) {
  return Number(isUpcoming(a.kind)) - Number(isUpcoming(b.kind))
    || Number(a.local === false) - Number(b.local === false)
    || (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER);
}

export function newsletterSections<T extends { kind?: string; local?: boolean; rank: number | null }>(items: T[]) {
  const ordered = [...items].sort(newsletterOrder);
  return { news: ordered.filter((item) => !isUpcoming(item.kind)), upcoming: ordered.filter((item) => isUpcoming(item.kind)) };
}
