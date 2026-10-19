# Local reader website

Home for the minimal Stage 1 website: community editions, full stories, and
visible source attribution. Consume published content through the local backend
API; keep editorial and source-processing logic in the backend.

Cross-project contracts belong in `shared\contracts\` at the repository root.
Astro renders the minimal reader shell in `src\pages\index.astro`; a small browser
script searches `/api/locations/search` for autocomplete suggestions from the local
US public-library directory (towns with library venues, not a worldwide geocoder).
Type at least two letters; add `, ST` to narrow by state. Suggestions support mouse,
touch, and arrow-key/Enter selection. `/api/editions` determines whether the selected
town has an onboarded paper: show its latest published edition, "No edition yet."
for an onboarded town awaiting publication, or an expansion interest page otherwise.
The `?location=<id>` link works for both onboarded and directory-only towns.
Search, edition, and signup failures are shown explicitly.

The expansion form posts an email to `/api/locations/<id>/interest`. The API validates
the town against the directory and saves one entry per town/email in the local
SQLite `expansion_signups` table (including town name and signup time). Repeated
signups are idempotent. These are interest registrations, not subscriptions: no
email is sent and no launch is promised. Addresses are not exposed by a public API.
The form discloses local storage; do not use real personal data for demos.

No public hosting, reader accounts, email subscriptions, or behavioral analytics
are scaffolded here. Use the root README's setup and launcher commands, including
`setup-directory` before location search.
`PUBLIC_API_URL` optionally changes the API origin at build/start time; it
defaults to `http://127.0.0.1:8000`. Cross-origin access is allowed only from the
default local website origins.
