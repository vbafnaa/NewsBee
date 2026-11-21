import type { Db, Filter } from "mongodb";
import { csvCell } from "@/pipeline/editions/story-reviews";
import { COLLECTIONS } from "@/pipeline/storage/mongo";

export const CAMPAIGNS = [
  "newsroom",
  "college-journalism",
  "high-school-journalism",
  "branded-news",
] as const;

export const CAMPAIGN_ROLES = [
  "Independent journalist",
  "Staff reporter",
  "Editor or publisher",
  "Video producer",
  "Student reporter",
  "Student editor",
  "Student video producer",
  "Faculty adviser",
  "Journalism teacher",
  "Student media adviser",
  "School administrator",
  "Other educator",
  "Myself or my personal brand",
  "A local business",
  "A community organization",
  "Another brand",
  "Other",
] as const;

export const CAMPAIGN_INTERESTS = [
  "Collecting tips and story submissions",
  "Organizing sources and drafts",
  "Creating articles and newsletter briefs with AI",
  "Creating video for my channel",
  "Pitching and submitting stories",
  "Organizing reporting with my campus newsroom",
  "Writing articles and newsletter briefs with AI",
  "Making video explainers",
  "Building a reporting portfolio",
  "Story pitching and submissions",
  "Organizing sources and reviewing drafts",
  "Adapting a story into several formats with AI",
  "Making a short video explainer",
  "A guided reporting assignment",
  "A local email newsletter",
  "A local news page",
  "Short video updates",
  "A roundup in several formats",
] as const;

export const CAMPAIGN_ATTRIBUTION_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
] as const;

export const CAMPAIGN_LEADS_PAGE_SIZE = 50;

type Campaign = typeof CAMPAIGNS[number];
type CampaignRole = typeof CAMPAIGN_ROLES[number];
type CampaignInterest = typeof CAMPAIGN_INTERESTS[number];
type AttributionKey = typeof CAMPAIGN_ATTRIBUTION_KEYS[number];

type CampaignLeadDocument = {
  _id: string;
  campaign: Campaign;
  email: string;
  context: string;
  role: CampaignRole;
  interest: CampaignInterest;
  attribution?: Partial<Record<AttributionKey, string>>;
  createdAt: Date;
};

export type CampaignLeadFilters = {
  campaign?: Campaign;
  role?: CampaignRole;
  interest?: CampaignInterest;
  utmSource?: string;
  from?: Date;
  to?: Date;
  page: number;
};

export type CampaignLead = {
  email: string;
  campaign: Campaign;
  context: string;
  role: CampaignRole;
  interest: CampaignInterest;
  attribution: Partial<Record<AttributionKey, string>>;
  createdAt: string;
};

export class CampaignLeadQueryError extends Error {}

function optionalValue(params: URLSearchParams, name: string) {
  const values = params.getAll(name);
  if (values.length > 1) throw new CampaignLeadQueryError(`Invalid ${name} filter`);
  return values[0]?.trim() || undefined;
}

function knownValue<const T extends readonly string[]>(
  value: string | undefined,
  values: T,
  name: string,
): T[number] | undefined {
  if (value === undefined) return undefined;
  if (!values.includes(value)) throw new CampaignLeadQueryError(`Invalid ${name} filter`);
  return value as T[number];
}

function dateValue(value: string | undefined, name: string, endOfDay = false) {
  if (value === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new CampaignLeadQueryError(`Invalid ${name} date`);
  const date = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new CampaignLeadQueryError(`Invalid ${name} date`);
  }
  return date;
}

export function parseCampaignLeadFilters(params: URLSearchParams): CampaignLeadFilters {
  const campaign = knownValue(optionalValue(params, "campaign"), CAMPAIGNS, "campaign");
  const role = knownValue(optionalValue(params, "role"), CAMPAIGN_ROLES, "role");
  const interest = knownValue(optionalValue(params, "interest"), CAMPAIGN_INTERESTS, "interest");
  const utmSource = optionalValue(params, "utm_source");
  if (utmSource && !/^[a-z0-9][a-z0-9_. -]{0,99}$/i.test(utmSource)) {
    throw new CampaignLeadQueryError("Invalid UTM source filter");
  }
  const from = dateValue(optionalValue(params, "from"), "from");
  const to = dateValue(optionalValue(params, "to"), "to", true);
  if (from && to && from > to) throw new CampaignLeadQueryError("Invalid date range");
  const pageValue = optionalValue(params, "page");
  const page = pageValue === undefined ? 1 : Number(pageValue);
  if (!Number.isSafeInteger(page) || page < 1) throw new CampaignLeadQueryError("Invalid page");
  return { campaign, role, interest, utmSource, from, to, page };
}

function mongoFilter(filters: CampaignLeadFilters): Filter<CampaignLeadDocument> {
  const filter: Filter<CampaignLeadDocument> = {};
  if (filters.campaign) filter.campaign = filters.campaign;
  if (filters.role) filter.role = filters.role;
  if (filters.interest) filter.interest = filters.interest;
  if (filters.utmSource) filter["attribution.utm_source"] = filters.utmSource;
  if (filters.from || filters.to) {
    filter.createdAt = {
      ...(filters.from ? { $gte: filters.from } : {}),
      ...(filters.to ? { $lte: filters.to } : {}),
    };
  }
  return filter;
}

function collection(db: Db) {
  return db.collection<CampaignLeadDocument>(COLLECTIONS.campaignSignups);
}

export async function ensureCampaignLeadIndexes(db: Db) {
  await collection(db).createIndexes([
    { key: { createdAt: -1, _id: -1 }, name: "campaign_leads_newest" },
    { key: { campaign: 1, createdAt: -1, _id: -1 }, name: "campaign_leads_campaign" },
    { key: { role: 1, createdAt: -1, _id: -1 }, name: "campaign_leads_role" },
    { key: { interest: 1, createdAt: -1, _id: -1 }, name: "campaign_leads_interest" },
    { key: { "attribution.utm_source": 1, createdAt: -1, _id: -1 }, name: "campaign_leads_utm_source" },
  ]);
}

function publicLead(document: CampaignLeadDocument): CampaignLead {
  const attribution: Partial<Record<AttributionKey, string>> = {};
  for (const key of CAMPAIGN_ATTRIBUTION_KEYS) {
    const value = document.attribution?.[key];
    if (typeof value === "string") attribution[key] = value;
  }
  return {
    email: document.email,
    campaign: document.campaign,
    context: document.context,
    role: document.role,
    interest: document.interest,
    attribution,
    createdAt: document.createdAt.toISOString(),
  };
}

export async function listCampaignLeads(db: Db, filters: CampaignLeadFilters) {
  await ensureCampaignLeadIndexes(db);
  const query = mongoFilter(filters);
  const total = await collection(db).countDocuments(query);
  const documents = await collection(db).find(query, {
    projection: {
      _id: 1,
      email: 1,
      campaign: 1,
      context: 1,
      role: 1,
      interest: 1,
      attribution: 1,
      createdAt: 1,
    },
  })
    .sort({ createdAt: -1, _id: -1 })
    .skip((filters.page - 1) * CAMPAIGN_LEADS_PAGE_SIZE)
    .limit(CAMPAIGN_LEADS_PAGE_SIZE)
    .toArray();
  return {
    leads: documents.map(publicLead),
    page: filters.page,
    pageSize: CAMPAIGN_LEADS_PAGE_SIZE,
    total,
    pages: Math.ceil(total / CAMPAIGN_LEADS_PAGE_SIZE),
  };
}

export async function campaignLeadCsv(db: Db, filters: CampaignLeadFilters) {
  await ensureCampaignLeadIndexes(db);
  const documents = await collection(db).find(mongoFilter(filters), {
    projection: {
      _id: 1,
      email: 1,
      campaign: 1,
      context: 1,
      role: 1,
      interest: 1,
      attribution: 1,
      createdAt: 1,
    },
  }).sort({ createdAt: -1, _id: -1 }).toArray();
  const headers = [
    "email",
    "campaign",
    "context",
    "role",
    "interest",
    ...CAMPAIGN_ATTRIBUTION_KEYS,
    "signup_timestamp",
  ];
  const rows = documents.map((document) => {
    const lead = publicLead(document);
    return [
      lead.email,
      lead.campaign,
      lead.context,
      lead.role,
      lead.interest,
      ...CAMPAIGN_ATTRIBUTION_KEYS.map((key) => lead.attribution[key]),
      lead.createdAt,
    ].map(csvCell).join(",");
  });
  return `${[headers.join(","), ...rows].join("\r\n")}\r\n`;
}

export async function campaignLeadSummary(db: Db, now = new Date()) {
  await ensureCampaignLeadIndexes(db);
  const sevenDaysAgo = new Date(now.getTime() - (7 * 24 * 60 * 60 * 1000));
  const [total, recent] = await Promise.all([
    collection(db).countDocuments({}),
    collection(db).countDocuments({ createdAt: { $gte: sevenDaysAgo, $lte: now } }),
  ]);
  return { total, recent };
}
