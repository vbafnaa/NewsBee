# Muse receiver

Standalone Next.js + TypeScript site for receiving **authorized** hourly Facebook-group reports. It is separate from the Newsbee journalist and reader sites and does not publish anything to Newsbee. Add a group, copy its per-group Muse prompt and report URL, browse accepted posts, and export all saved posts as JSON. Collection and scheduling happen **outside this app**. A Muse prompt alone cannot grant access to Facebook groups or trigger scheduled HTTP calls. The existing `incubating-connectors/facebook-group-collector` is a possible source of authorized observations, but is not wired to this site.

**No authentication is implemented.** Anyone who can reach the deployment can list groups, read/export all posts, add groups and submit or overwrite reports. Do not deploy it publicly with private-group material until access control is added. Obtain the group's permission and applicable Meta authorization before collection or transmission. Never paste credentials into a Muse prompt.

## Run locally

Use Node.js 20.9+: MongoDB is optional locally, but required on Vercel/production:

```powershell
cd apps\muse-receiver
npm ci
Copy-Item .env.example .env.local
npm run dev
```

Leave `MONGODB_URI` unset to persist groups, reports and posts in `data/muse-receiver.json` inside this app (the `data/` folder is git-ignored). Writes use a filesystem lock and atomic file replacement; keep the folder on durable local disk. If a process crashes while writing and requests report a locked data file, ensure no writer is running before removing `data/muse-receiver.json.lock`. Alternatively, set `MONGODB_URI` in `.env.local` to use MongoDB. Then open `http://127.0.0.1:3001`. `MONGODB_DATABASE` defaults to `muse_receiver`; use a separate database from the Newsbee production pipeline. `NEXT_PUBLIC_SITE_URL` is optional locally; set it to the public HTTPS origin on Vercel so copied report URLs and prompts use the correct domain. Never commit environment files.

## Deploy on Vercel

Create a **separate Vercel project** from this repository with Root Directory `apps/muse-receiver` and Framework Preset Next.js. Set `MONGODB_URI`, `MONGODB_DATABASE=muse_receiver`, and `NEXT_PUBLIC_SITE_URL=https://<receiver-domain>` in that project's environment. Deploy the project and open its URL. This does not change the repository-root multi-service Vercel deployment or its routes. Vercel function storage is ephemeral: production refuses requests without `MONGODB_URI` (503), rather than falling back to a JSON file. MongoDB is required to retain groups, reports and posts in production.

## Reporting contract

`POST /api/groups/{groupId}/reports` accepts JSON with a maximum 2 MB body. The group page displays the exact URL and a copyable prompt. Every hourly report needs `runTime`, `windowStart`, `windowEnd` (UTC ISO-8601, with a window of exactly one hour ending at `runTime`), `status` (`complete`, `partial`, `failed`), exactly two `scans`, `posts`, and `issues`. A scan has `sort` (`CHRONOLOGICAL` or `RECENT_ACTIVITY`), `status`, optional `reason`, and ordered `postRefs` pointing to posts in the same report; recent activity has at most ten. Each post needs a unique-in-report `ref`, Facebook `id` or null, original `text`, Facebook `permalink` or null, `sourceLinks`, UTC `publishedAt` or null, `rawTime` or null, UTC `observedAt`, `commentCount` or null, `reactions` (`total`, `kinds`, `counts`), `contentVerified`, and `truncated`. Use null rather than zero for unknown measurements. Only include original-post content; do not send comments, member lists, screenshots or raw page captures. This is **not** a guaranteed full Facebook feed; incomplete/undated collections must say so.

Example (illustrative only; do not submit invented observations):

```json
{
  "runTime": "2026-10-29T16:00:00.000Z",
  "windowStart": "2026-10-29T15:00:00.000Z",
  "windowEnd": "2026-10-29T16:00:00.000Z",
  "status": "partial",
  "scans": [
    { "sort": "CHRONOLOGICAL", "status": "partial", "reason": "Undated post", "postRefs": ["p1"] },
    { "sort": "RECENT_ACTIVITY", "status": "partial", "reason": "Only one post available", "postRefs": ["p1"] }
  ],
  "posts": [{
    "ref": "p1", "id": null, "text": "Example original post text", "permalink": null,
    "sourceLinks": [], "publishedAt": null, "rawTime": null,
    "observedAt": "2026-10-29T16:00:00.000Z", "commentCount": null,
    "reactions": { "total": null, "kinds": [], "counts": {} },
    "contentVerified": true, "truncated": false
  }],
  "issues": ["Illustrative partial run"]
}
```

A report's verified last-hour set is derived server-side from publication times within `[windowStart,windowEnd)`. Unknown publication times remain separately flagged, never treated as last-hour evidence. Repeating a report with the same group and `runTime` updates it instead of adding a duplicate report. Posts deduplicate on verified ID, verified URL or a fallback hash of text; linkless edits may therefore appear as separate posts. No post is auto-published.

Other routes: `GET/POST /api/groups`, `GET /api/groups/{groupId}`, `GET /api/groups/{groupId}/prompt`, `GET /api/groups/{groupId}/posts?page=0` (50 per page, latest 20 reports), and `GET /api/groups/{groupId}/export` (all posts in a downloadable JSON file). There is intentionally no cron: schedule your approved collection/invocation externally every hour and give the sender an HTTP POST capability. Muse Model API's web search alone cannot provide parity with a browser collector or private-group access.
