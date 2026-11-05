/**
 * Public data APIs (NWS, Overpass, Wikidata and others), called the same way onboarding
 * calls Photon and the Census: HTTPS only, an identifying User-Agent, a size limit and a
 * timeout, and no robots.txt check (each API's own usage policy governs). Callers keep to
 * those policies by caching results (Overpass every 90 days, Wikidata every two weeks) and
 * calling at most once per location per run. Website content goes through the Fetcher.
 */
import { HttpStatusError, type HttpTransport } from "../core/http";
import { COMMUNITY_USER_AGENT } from "../../../../shared/geography";

export async function publicApiGet(transport: HttpTransport, url: string, accept: string, maxBytes = 4 * 1024 * 1024, timeoutMs = 25_000): Promise<Uint8Array> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error(`Refusing non-HTTPS URL: ${url}`);
  const response = await transport({ url, headers: { "User-Agent": COMMUNITY_USER_AGENT, Accept: accept }, maxBytes, timeoutMs });
  if (response.status >= 400) throw new HttpStatusError(response.status, url);
  return response.body;
}
