import Link from "next/link";
import AdminShell from "@/app/admin-shell";
import { requireOperatorPrincipal } from "@/lib/portal-access";
import {
  CAMPAIGN_ATTRIBUTION_KEYS,
  CAMPAIGN_INTERESTS,
  CAMPAIGN_ROLES,
  CAMPAIGNS,
  CampaignLeadQueryError,
  listCampaignLeads,
  parseCampaignLeadFilters,
} from "@/pipeline/campaigns/leads";
import { getDatabase } from "@/pipeline/storage/mongo";

type Query = Record<string, string | string[] | undefined>;

export const dynamic = "force-dynamic";

function paramsFromQuery(query: Query) {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      params.append(name, item);
    }
  }
  return params;
}

function withPage(params: URLSearchParams, page: number) {
  const next = new URLSearchParams(params);
  next.set("page", String(page));
  return `/admin/campaigns?${next.toString()}`;
}

function campaignLabel(value: string) {
  return value.split("-").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
}

export default async function CampaignsPage({ searchParams }: { searchParams: Promise<Query> }) {
  const principal = await requireOperatorPrincipal();

  const rawParams = paramsFromQuery(await searchParams);
  let data;
  let error: string | null = null;
  try {
    data = await listCampaignLeads(await getDatabase(), parseCampaignLeadFilters(rawParams));
  } catch (caught) {
    if (!(caught instanceof CampaignLeadQueryError)) throw caught;
    error = caught.message;
  }

  const exportParams = new URLSearchParams(rawParams);
  exportParams.delete("page");
  const campaign = rawParams.get("campaign") ?? "";
  const role = rawParams.get("role") ?? "";
  const interest = rawParams.get("interest") ?? "";

  return (
    <AdminShell email={principal.email} page="campaigns" title="Campaign requests"
      description="Review early-access and pilot requests. This workspace is read-only and restricted to Newsbee operators.">
      <section className="panel">
        <p>Incoming early-access and pilot leads. <Link href="/admin/video-campaigns">Create a promotional video campaign</Link> separately.</p>
        <p>Marketing landing pages: <a href="/reader/campaign/newsroom">Newsroom</a> · <a href="/reader/campaign/college-journalism">College journalism</a> · <a href="/reader/campaign/high-school-journalism">High-school journalism</a> · <a href="/reader/campaign/branded-news">Branded news</a></p>
        <form className="filters campaign-filters" method="get">
          <label>Campaign
            <select name="campaign" defaultValue={campaign}>
              <option value="">All campaigns</option>
              {CAMPAIGNS.map((value) => <option key={value} value={value}>{campaignLabel(value)}</option>)}
            </select>
          </label>
          <label>Role
            <select name="role" defaultValue={role}>
              <option value="">All roles</option>
              {CAMPAIGN_ROLES.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label>Interest
            <select name="interest" defaultValue={interest}>
              <option value="">All interests</option>
              {CAMPAIGN_INTERESTS.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label>UTM source
            <input name="utm_source" defaultValue={rawParams.get("utm_source") ?? ""} maxLength={100} />
          </label>
          <label>From
            <input type="date" name="from" defaultValue={rawParams.get("from") ?? ""} />
          </label>
          <label>To
            <input type="date" name="to" defaultValue={rawParams.get("to") ?? ""} />
          </label>
          <button type="submit">Apply filters</button>
          <Link className="button secondary" href="/admin/campaigns">Reset</Link>
          {!error && (
            <a className="button secondary" href={`/api/admin/campaigns/export?${exportParams.toString()}`}>
              Export matching CSV
            </a>
          )}
        </form>
      </section>

      {error ? (
        <section className="panel" role="alert">
          <h2>Campaign filters need attention</h2>
          <p>{error}. Reset the filters or choose valid values and try again.</p>
        </section>
      ) : (
        <section className="panel campaign-results" aria-live="polite">
          <div className="campaign-results-heading">
            <div>
              <p className="eyebrow">Matching leads</p>
              <h2>{data!.total.toLocaleString()} requests</h2>
            </div>
            <p>Page {data!.page} of {Math.max(data!.pages, 1)} · 50 rows per page</p>
          </div>
          {data!.leads.length === 0 ? (
            <p>No campaign requests match these filters.</p>
          ) : (
            <ul className="campaign-lead-list" aria-label="Campaign requests">
              {data!.leads.map((lead) => (
                <li className="campaign-lead-card" key={`${lead.campaign}:${lead.email}`}>
                  <div className="campaign-lead-summary">
                    <h3>{lead.email}</h3>
                    <p>{campaignLabel(lead.campaign)}</p>
                    <p>Signed up <time dateTime={lead.createdAt}>{new Date(lead.createdAt).toLocaleDateString("en-US")}</time></p>
                  </div>
                  <dl className="campaign-lead-context">
                    <div><dt>Context</dt><dd>{lead.context}</dd></div>
                    <div><dt>Role</dt><dd>{lead.role}</dd></div>
                    <div><dt>Interest</dt><dd>{lead.interest}</dd></div>
                  </dl>
                  <details className="campaign-attribution">
                    <summary>Attribution details for {lead.email}</summary>
                    <dl>
                      {CAMPAIGN_ATTRIBUTION_KEYS.map((key) => <div key={key}>
                        <dt>{key.replace("utm_", "UTM ")}</dt><dd>{lead.attribution[key] || "Not set"}</dd>
                      </div>)}
                    </dl>
                  </details>
                </li>
              ))}
            </ul>
          )}
          {data!.pages > 1 && (
            <nav className="campaign-pagination" aria-label="Campaign lead pages">
              {data!.page > 1
                ? <Link className="button secondary" href={withPage(rawParams, data!.page - 1)}>Previous</Link>
                : <span />}
              <span>Page {data!.page} of {data!.pages}</span>
              {data!.page < data!.pages
                ? <Link className="button secondary" href={withPage(rawParams, data!.page + 1)}>Next</Link>
                : <span />}
            </nav>
          )}
        </section>
      )}
    </AdminShell>
  );
}
