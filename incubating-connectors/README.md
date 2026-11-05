# Incubating connectors

Source collectors kept for future work. **Nothing in this folder is part of the Newsbee pipeline**: it isn't registered in `apps/journalist-site/pipeline/connectors/registry.ts`, imported by either app, or deployed by Vercel (the root `vercel.json` only builds `apps/journalist-site` and `apps/reader-site`).

A collector moves out of here and into the pipeline only after it is rebuilt as a registered connector with its own lookup window, ranker, editorial checks and tests.

| Folder | What it is | Status | Before it can join the pipeline |
| --- | --- | --- | --- |
| `facebook-group-collector/` | Local dashboard that collects posts from approved Facebook groups through a signed-in Chrome profile and exports them as JSON | Parked; run locally only | Meta's terms (section 3.2.3) restrict automated collection without Meta's permission, so a decision on that comes first. If approved: import the export through an admin-only route rather than scraping from the server, hold posts for editor review, check for personal information, add a `community_post` story kind to the edition contract, and require a public source link |
