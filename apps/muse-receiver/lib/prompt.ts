import type { Group } from "./validation";

export function reportUrl(group: Group, requestUrl: string): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "");
  const origin = configured && /^https?:\/\//.test(configured) ? configured : new URL(requestUrl).origin;
  return `${origin}/api/groups/${encodeURIComponent(group.id)}/reports`;
}

export function groupPrompt(group: Group, endpoint: string): string {
  return `Newsbee hourly collection for Facebook group "${group.name}" (${group.url}).

Only collect from this group if you have authorized access through an approved tool or supplied collector results. A web-search answer does NOT establish coverage of this group's feed. If you have no such access, do not guess: report that you cannot collect. Run this prompt externally once per hour; this prompt does not create a schedule.

At run time, set runTime to the current UTC time; windowStart to exactly one hour before runTime; windowEnd to runTime. Do two independent scans: CHRONOLOGICAL for identifiable original posts published within [windowStart,windowEnd), and RECENT_ACTIVITY for the first up to 10 distinct original posts in feed activity order, even if older. Do not mistake comments for original posts or recent activity for newest publication. Dedupe posts across scans; keep each scan's ordered postRefs. Also retain posts with unknown publication time but never claim they are from the last hour. Mark partial/failed scans, missing fields and coverage gaps truthfully.

For each original post preserve: a stable ref unique within this report, verified Facebook post id or null, original post text, verified original permalink or null, external source links, UTC publishedAt or null, raw displayed time or null, UTC observedAt, commentCount or null, reaction total or null, recognizable reaction kinds and only explicitly shown per-kind counts, contentVerified, and truncated. Null means unknown, not zero. Do not include comment bodies, member lists, screenshots or raw HTML. Never manufacture content or metadata. Never publish a story automatically.

Send ONE HTTP POST with Content-Type: application/json to ${endpoint}. The body must match this JSON shape (replace examples with actual observations):
{
  "runTime": "2026-10-29T16:00:00.000Z",
  "windowStart": "2026-10-29T15:00:00.000Z",
  "windowEnd": "2026-10-29T16:00:00.000Z",
  "status": "partial",
  "scans": [
    {"sort":"CHRONOLOGICAL","status":"partial","reason":"Example: publication time unavailable","postRefs":["post-1"]},
    {"sort":"RECENT_ACTIVITY","status":"complete","reason":null,"postRefs":["post-1"]}
  ],
  "posts": [
    {"ref":"post-1","id":null,"text":"Example post text","permalink":null,"sourceLinks":[],"publishedAt":null,"rawTime":null,"observedAt":"2026-10-29T16:00:00.000Z","commentCount":null,"reactions":{"total":null,"kinds":[],"counts":{}},"contentVerified":true,"truncated":false}
  ],
  "issues": ["Example: the chronological window could not be fully verified"]
}
Do not send the example data. If you cannot make an HTTP request, output the valid JSON for a separate, authorized sender to POST; do not claim delivery. The receiver currently has NO authentication: do not transmit private-group posts without explicit permission and an appropriate access-control decision.`;
}
