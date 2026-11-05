/**
 * Every story kind, defined once. Editorial policy, newsworthiness ranking, the story
 * writer and the fixed When/Where line all read this table, and a test checks it against
 * the edition contract (shared/contracts/edition.schema.json) and the reader site's type.
 * To add a kind: add it here, to the contract enum, and to a connector's meta.storyKinds.
 */
export type KindDefinition = {
  /** News kinds are reported (newest first, no event dates in prose); others are things to go to. */
  news: boolean;
  /** What the written story is for, given to the story writer. */
  purpose: string;
  /** Fixed When/Where text for news kinds: {when} and {source} are filled from the first occurrence. */
  line?: string;
  /** Allegation wording is expected and allowed (court records); private-matter checks still apply. */
  allegationsAllowed?: boolean;
  /** Civic weight for rule-based ranking when the model is unavailable. */
  civic?: number;
};

export const KIND_DEFINITIONS = {
  event: { news: false, purpose: "tells neighbours what happens at this event and why it is worth going" },
  meeting_preview: { news: false, civic: 3, purpose: "tells neighbours what this public meeting will consider and why it matters to residents, in plain language for someone new to local government" },
  meeting_outcome: { news: false, civic: 3, purpose: "tells neighbours what this public body decided, exactly as the recorded outcomes state, and why it matters to residents, in plain language for someone new to local government" },
  state_news: { news: true, line: "Published {when} by {source}.", purpose: "tells neighbours what this official announcement says, naming the agency that made it, in plain language. Do not claim it affects the town unless the description says so" },
  earthquake: { news: true, line: "Recorded {when}. Where: {source}.", purpose: "tells neighbours calmly and plainly what the U.S. Geological Survey recorded. Do not mention damage, injuries, aftershocks or safety advice unless the description does" },
  trending_topic: { news: true, line: "Published {when} by {source}.", purpose: "reports the actual local development and its sourced local relevance, attributing reporting to the publisher. Wikipedia was only a discovery signal: do not mention trending, page views, searches, readership or speculate about why it attracted attention" },
  social_trend: { news: true, line: "Published {when} by {source}.", purpose: "reports the actual local development and its sourced local relevance, attributing reporting to the publisher. Bluesky was only a link-discovery source: do not mention trending, post counts, virality or quote individual social-media users" },
  safety_notice: { news: true, line: "Reported {when}. Source: {source}.", purpose: "tells households calmly and plainly what the federal record shows about their water system, naming the agency and the water system. Do not give health advice, predict harm or say the water is unsafe unless the description says so" },
  housing_market: { news: true, line: "Data for {when}. Source: {source}.", purpose: "tells homeowners and would-be buyers what the official building permit figures show, naming the agency and period. Do not forecast prices, give buying advice or explain causes the description does not state" },
  development: { news: true, line: "Filed {when}. Source: {source}.", purpose: "tells neighbours what was filed or approved and where, naming the city permit record, the project and any business or developer the record names. Never name private homeowners, and do not speculate about who is building or why" },
  school_sports: { news: true, line: "Published {when} by {source}.", purpose: "celebrates the school sports news exactly as published, naming the school or association that reported it. Students may be named and celebrated when the source names them for a win, award or honour. Do not add scores, records or rankings that are not in the description" },
  game_result: { news: true, line: "Published {when} by {source}.", purpose: "reports this game result or schedule exactly as published, naming the team or association that reported it. Do not add scores, records or rankings that are not in the description" },
  home_sale: { news: true, line: "Recorded {when}. Source: {source}.", purpose: "reports this recorded home sale: address, price and date, exactly as the record gives them, naming the record's source" },
  building_permit: { news: true, line: "Filed {when}. Source: {source}.", purpose: "tells neighbours what this permit record shows and where, naming the agency. Do not speculate about who is building or why" },
  weather_alert: { news: true, civic: 3, line: "Issued {when} by {source}.", purpose: "tells neighbours calmly what the National Weather Service alert says, the area and the period it covers, naming the Weather Service. Repeat only the instructions the alert itself gives; do not add safety advice, forecasts or consequences it does not state" },
  court_case: { news: true, civic: 2, allegationsAllowed: true, line: "Announced {when} by {source}.", purpose: "reports what this official prosecutor's or court announcement says, naming the office that made it and the people it names. Charges are allegations: say a person is charged with or accused of a crime, never that they committed it, and say that a charged person is presumed innocent unless and until proven guilty in court. For convictions and sentences, state only the outcome the announcement gives. Never name a minor who is accused or a victim, never name a victim of sexual assault or domestic violence, never give a private home address, and do not add details, motives or reactions the description does not state" },
  safety_incident: { news: true, civic: 2, allegationsAllowed: true, line: "Reported {when}. Where: {source}.", purpose: "tells neighbours plainly what police, fire or medics responded to, where (to the block) and when, and what the record or the agency says happened, using the people and details the source gives. A call is not a confirmed crime, and anyone arrested or accused is presumed innocent. Never name a minor who is accused or a victim, never name a victim of sexual assault or domestic violence, and never give a house number: say the block. Do not add injuries, causes or motives the description does not state" },
  news_report: { news: true, line: "Published {when} by {source}.", purpose: "retells this local news report in fresh words, crediting the outlet that published it, leading with the people and places it names. Do not copy its sentences, and do not add details it does not state" },
  public_record: { news: true, line: "Recorded {when}. Source: {source}.", purpose: "tells neighbours what this public record shows (an inspection, a service request summary or another filing), naming the agency and the business or place it concerns. Do not speculate about causes or consequences the record does not state" },
  local_news: { news: true, line: "Published {when} by {source}.", purpose: "tells neighbours what this local post says, attributing it to the organisation that published it and leading with the people and places it names. Do not claim wider impact or add details the description does not state" },
  business_opening: { news: true, line: "Filed {when}. Source: {source}.", purpose: "tells neighbours that the public licensing record shows a business application at a local address, naming the licensing agency and the business's trade name. Say it is an application on record, not that the business has opened, and do not name owners or applicants" },
  obituary: { news: true, line: "Published {when}. Source: {source}.", purpose: "remembers this person warmly and plainly, using the life details, family, service arrangements and memories the notice gives, and naming its source. Do not add cause of death, ages, dates or anything else that is not in the description, and do not editorialise" },
  reader_story: { news: true, line: "{when}. Shared by {source}.", purpose: "passes on what a neighbour shared with the newsletter, attributing it plainly to them (for example 'a neighbour shares' or by the first name given in the description), never presenting it as the newsletter's own reporting. Keep their facts exactly; do not add names, dates, places or claims they did not give" },
} as const satisfies Record<string, KindDefinition>;

export type StoryKind = keyof typeof KIND_DEFINITIONS;
export const ALL_KINDS = new Set<string>(Object.keys(KIND_DEFINITIONS));
export const NEWS_KINDS = new Set<string>(Object.entries(KIND_DEFINITIONS).filter(([, kind]) => kind.news).map(([name]) => name));
export const MEETING_KINDS = new Set(["meeting_preview", "meeting_outcome"]);
export const ALLEGATION_KINDS = new Set<string>(Object.entries(KIND_DEFINITIONS).filter(([, kind]) => (kind as KindDefinition).allegationsAllowed).map(([name]) => name));

export function kindDefinition(kind: string | undefined): KindDefinition {
  return (KIND_DEFINITIONS as Record<string, KindDefinition>)[kind ?? "event"] ?? KIND_DEFINITIONS.event;
}
export const PURPOSE: Record<string, string> = Object.fromEntries(Object.entries(KIND_DEFINITIONS).map(([name, kind]) => [name, kind.purpose]));
export const NEWS_LINES: Record<string, string> = Object.fromEntries(
  Object.entries(KIND_DEFINITIONS).flatMap(([name, kind]) => "line" in kind ? [[name, kind.line]] : []),
);
