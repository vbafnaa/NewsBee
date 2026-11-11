/** Public attribution shared by authoring and the reader; old editions need only one link. */
export type StorySource = { name: string; url: string };
export function storySources(values: StorySource[]): StorySource[] {
  const seen = new Set<string>();
  return values.flatMap((source) => {
    try {
      const url = new URL(source.url);
      if (url.protocol !== "https:" || url.username || url.password) return [];
      url.hash = "";
      for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/.test(key)) url.searchParams.delete(key);
      const key = url.href;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ name: source.name?.trim() || url.hostname, url: key }];
    } catch { return []; }
  });
}
