export const campaigns = {
  newsroom: {
    audience: "For local journalists and editors",
    title: "Less busywork between reporting and publishing.",
    description: "Keep pitches, sources, and drafts in one workspace. Use AI to turn the same reporting into an article, email brief, or video for your channel.",
    cta: "Request early access",
    contextLabel: "Publication or beat",
    contextExample: "e.g. Independent reporter covering city hall",
    roleLabel: "What’s your role?",
    roles: ["Independent journalist", "Staff reporter", "Editor or publisher", "Video producer", "Other"],
    interestLabel: "What would help you most?",
    interests: ["Collecting tips and story submissions", "Organizing sources and drafts", "Creating articles and newsletter briefs with AI", "Creating video for my channel"],
  },
  "college-journalism": {
    audience: "For college student journalists and campus media",
    title: "Tell the campus story everyone’s talking about.",
    description: "Gather pitches, work with your student editor, and use AI to adapt one campus story for the student paper, newsletter, or video channel.",
    cta: "Join the campus pilot list",
    contextLabel: "Campus publication or journalism program",
    contextExample: "e.g. Campus radio or the student newspaper",
    roleLabel: "How are you involved?",
    roles: ["Student reporter", "Student editor", "Student video producer", "Faculty adviser", "Other"],
    interestLabel: "What would you like to try first?",
    interests: ["Pitching and submitting stories", "Organizing reporting with my campus newsroom", "Writing articles and newsletter briefs with AI", "Making video explainers", "Building a reporting portfolio"],
  },
  "high-school-journalism": {
    audience: "For high-school journalism classes and clubs",
    title: "Your school has stories worth reporting.",
    description: "Build a journalism portfolio through an extracurricular project. Report a school story, review it with your adviser, and use AI to adapt it into a newsletter brief or video explainer.",
    cta: "Request a school pilot",
    contextLabel: "School or journalism program",
    contextExample: "e.g. School newspaper or journalism class",
    roleLabel: "What’s your role at the school?",
    roles: ["Journalism teacher", "Student media adviser", "School administrator", "Other educator"],
    interestLabel: "What would you use in class first?",
    interests: ["Story pitching and submissions", "Organizing sources and reviewing drafts", "Adapting a story into several formats with AI", "Making a short video explainer", "A guided reporting assignment"],
  },
  "branded-news": {
    audience: "For creators, local businesses, and community organizations",
    title: "Be the name your community turns to for local news.",
    description: "Collect local updates and use AI to draft a roundup you can review and share under your own name or brand.",
    cta: "Join the publisher waitlist",
    contextLabel: "Name or brand you’d publish under",
    contextExample: "e.g. Your business, organization, or creator name",
    roleLabel: "Who are you publishing for?",
    roles: ["Myself or my personal brand", "A local business", "A community organization", "Another brand"],
    interestLabel: "What would you send your audience first?",
    interests: ["A local email newsletter", "A local news page", "Short video updates", "A roundup in several formats"],
  },
};

export type CampaignSlug = keyof typeof campaigns;

export function isCampaignSlug(value: unknown): value is CampaignSlug {
  return typeof value === "string" && Object.hasOwn(campaigns, value);
}

export const campaignAttributionKeys = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;
