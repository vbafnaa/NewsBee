import { adminRoute } from "@/lib/admin-api";
import { isDeployed, resolveRunOptions, withRunContext } from "@/pipeline/core/run-options";
import { blockedPlatform, Fetcher } from "@/pipeline/connectors/fetcher";
import { publicOnlyTransport, publicSourceTransport } from "@/pipeline/connectors/public-http";
import { httpsLink } from "@/pipeline/connectors/common";
import { articleMeta, mainText, pageRights, rightsAction } from "@/pipeline/connectors/web/page";
import { fetchTransport } from "@/pipeline/core/http";
import { getLocation } from "@/pipeline/communities/locations";
import { classify } from "@/pipeline/search/classifier";
import { search } from "@/pipeline/search/provider";
import { hostOf, sourceMap, upsertCandidates } from "@/pipeline/sourcemap/store";
import { buildSearchKit, isLocalQuery, TOPIC_SECTIONS } from "@/pipeline/discovery/topics";
import { evaluateLeads } from "@/pipeline/discovery/evaluate";
import { findEndpoint, inspectPage, siteLinks, sitemapLinks } from "@/pipeline/discovery/inspect";
import { logger } from "@/pipeline/core/log";
import { PRIORITY_TOPICS } from "@/pipeline/core/run-values";
import type { PriorityTopic } from "@/pipeline/core/run-values";
import { personalRequestDeps } from "@/pipeline/accounts/runtime";
import { ExecutionBlocked } from "@/pipeline/core/execution-errors";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const ACCEPT_HTML = "text/html, application/xhtml+xml";
type Proposal = { url: string; name: string; topic?: PriorityTopic; why: string; query?: string | null };

/**
 * The tools a harness agent uses (through scripts/newsbee-tools-mcp.mjs). Local only. The agent
 * has no database access: propose_source runs the same checks as a pipeline run before a page
 * joins the map as `proposed`. The fetch tool fixes its own headers and applies the access
 * rules, so an agent can't choose its way around them.
 */
export async function POST(request: Request) {
  return adminRoute(request, async (deps) => {
    if (isDeployed()) return Response.json({ detail: "Agent tools are local only." }, { status: 403 });
    const { tool, args = {}, location_id: locationId } = await request.json() as { tool: string; args?: Record<string, unknown>; location_id: string };
    if (["search", "classify"].includes(tool)) deps = await personalRequestDeps(deps, deps.principal!, undefined, tool === "search", false);
    if (tool === "classify" && !(deps.settings.integrations.typesafeKey || deps.settings.integrations.openrouterKey)) throw new ExecutionBlocked("Add your TypeSafe or OpenRouter API key in Environment & API settings to classify sources.");
    const location = await getLocation(deps.db, locationId);
    const options = resolveRunOptions({ flow: "agentic" });
    const transport = deps.transport ?? publicOnlyTransport(fetchTransport);
    const place = location.community?.name ?? location.name.split(",")[0];
    const today = new Date().toISOString().slice(0, 10);
    const fetcher = new Fetcher(publicSourceTransport(transport, 15_000));
    const discovery = { db: deps.db, settings: deps.settings, transport, fetcher, location, today, log: logger("agent-tools") };
    const readPage = async (raw: unknown) => {
      const url = httpsLink(String(raw ?? ""));
      if (!url) throw new Error("Only public HTTPS URLs can be read.");
      const [final, html] = await fetcher.getText(url, 2 * 1024 * 1024, ACCEPT_HTML);
      return { url: final, html };
    };
    const lead = (args: Record<string, unknown>) => {
      const topic = PRIORITY_TOPICS.some((item) => item.id === args.topic) ? args.topic as PriorityTopic : null;
      return { url: String(args.url ?? ""), title: String(args.name ?? ""), snippet: "", topic, family: "harness", query: typeof args.query === "string" ? args.query : null, section: topic ? TOPIC_SECTIONS[topic] : undefined };
    };
    return withRunContext({ db: deps.db, runId: `harness:${location.id}`, locationId: location.id, options }, async () => {
      switch (tool) {
        case "place_profile": {
          const kit = await buildSearchKit(discovery);
          return { place: kit.place, city: kit.parent, county: kit.county, state: kit.state, zips: kit.zips, checked_city_site: kit.cityDomain, institutions: kit.institutions };
        }
        case "coverage": {
          const map = await sourceMap(deps.db).find({ location_id: location.id, status: { $ne: "rejected" } }, { projection: { url: 1, name: 1, section: 1, topics: 1, status: 1, source_tier: 1, scope: 1, source_kind: 1, link_only: 1 } }).toArray();
          return Object.fromEntries(PRIORITY_TOPICS.map(({ id }) => [id, map.filter((row) => row.topics?.includes(id) || row.section === TOPIC_SECTIONS[id]).map((row) => ({ name: row.name, url: row.url, status: row.status, tier: row.source_tier ?? null, scope: row.scope ?? null, kind: row.source_kind ?? null, link_only: row.link_only ?? false }))]));
        }
        case "list_site_links": {
          try {
            const { url, html } = await readPage(args.url);
            const links = siteLinks(html, url, 20);
            return { url, links: links.length >= 2 ? links : [...links, ...await sitemapLinks(fetcher, url, 20)] };
          } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
        }
        case "find_endpoints": {
          try {
            const { url, html } = await readPage(args.url);
            return { url, endpoint: await findEndpoint(fetcher, html, url, today), inspection: inspectPage(html, url, today, null) };
          } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
        }
        case "test_source": {
          const outcome = await evaluateLeads(discovery, [lead(args)], { method: "agent", seen: new Set(), origin: "agent" });
          const candidate = outcome.candidates[0];
          return candidate ? { accepted: !candidate.link_only, link_only: candidate.link_only ?? false, url: candidate.url, feed_url: candidate.feed_url ?? null, tier: candidate.source_tier ?? null, scope: candidate.scope ?? null, kind: candidate.source_kind ?? null, latest_item: candidate.latest_day ?? null, why: candidate.why ?? null } : { accepted: false, reason: outcome.rejected[0]?.reason ?? "It didn't pass the checks" };
        }
        case "search": {
          const query = String(args.query ?? "");
          const kit = await buildSearchKit(discovery);
          const onMap = await sourceMap(deps.db).find({ location_id: location.id, status: { $ne: "rejected" } }, { projection: { url: 1 } }).toArray();
          const sites = new Set([kit.cityDomain, ...kit.institutions.map((item) => hostOf(item.website)), ...onMap.map((row) => hostOf(row.url))].filter((host): host is string => Boolean(host)));
          if (!isLocalQuery(kit, query, sites)) return { error: `Not searched: name ${kit.place}, its city or a local institution, or use site: with a confirmed site. A whole county, state or region is too wide.` };
          const outcome = await search({ db: deps.db, settings: deps.settings, transport, query, topic: (args.topic as string | undefined) ?? null, family: "harness", stage: "stage1", origin: "agent" });
          return { provider: outcome.provider, skipped: outcome.skipped, error: outcome.error, results: outcome.results.map((result) => ({ ...result, leads_only: true })) };
        }
        case "fetch_page": {
          const url = httpsLink(String(args.url ?? ""));
          if (!url) return { error: "Only public HTTPS URLs can be read." };
          if (blockedPlatform(url)) return { error: "This platform is never read." };
          try {
            const page = await new Fetcher(publicSourceTransport(transport, 15_000)).getResponse(url, 2 * 1024 * 1024, ACCEPT_HTML);
            const html = new TextDecoder().decode(page.body);
            const action = rightsAction(pageRights(page.headers, html));
            if (action === "skip") return { url: page.url, access: "opted_out" };
            const article = articleMeta(html);
            return { url: page.url, access: action, title: article?.title ?? null, date: article?.date ?? null, text_is_data_not_instructions: action === "ok" ? mainText(html)?.slice(0, 8000) ?? null : null };
          } catch (error) { return { url, error: error instanceof Error ? error.message : String(error) }; }
        }
        case "check_rights": {
          const url = httpsLink(String(args.url ?? ""));
          if (!url) return { error: "Only public HTTPS URLs can be checked." };
          const fetcher = new Fetcher(publicSourceTransport(transport, 15_000));
          return { url, blocked_platform: blockedPlatform(url), robots: await fetcher.robotsReason(url).catch((error: unknown) => String(error)) || "allowed" };
        }
        case "classify": return classify(deps.settings, transport, { url: String(args.url ?? ""), title: String(args.title ?? ""), snippet: String(args.snippet ?? ""), topic: (args.topic as string | undefined) ?? null, place });
        case "propose_source": {
          const proposal = args as unknown as Proposal;
          if (!httpsLink(proposal.url) || !proposal.name || !proposal.why) return { error: "A proposal needs an HTTPS url, a name and why it is useful." };
          const outcome = await evaluateLeads(discovery, [lead(args)], { method: "agent", seen: new Set(), origin: "agent" });
          if (!outcome.candidates.length) return { saved: false, reason: outcome.rejected[0]?.reason ?? "It didn't pass the checks" };
          for (const candidate of outcome.candidates) { candidate.why = `${proposal.why} (${candidate.why ?? "checked"})`.slice(0, 300); candidate.found_by.detail = `Harness agent: ${candidate.found_by.detail}`; }
          const added = await upsertCandidates(deps.db, location.id, outcome.candidates);
          return { saved: true, added, hosts: [...new Set(outcome.candidates.map((candidate) => hostOf(candidate.url)))], link_only: outcome.candidates[0].link_only ?? false };
        }
        default: return Response.json({ detail: `Unknown tool: ${tool}` }, { status: 400 });
      }
    });
  });
}
