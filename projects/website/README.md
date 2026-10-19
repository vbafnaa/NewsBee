# Local reader website

Home for the minimal Stage 1 website: community editions, full stories, and
visible source attribution. Consume published content through the local backend
API; keep editorial and source-processing logic in the backend.

Cross-project contracts belong in `shared\contracts\` at the repository root.
Astro renders the minimal reader shell in `src\pages\index.astro`; a small browser
script lists onboarded locations from `/api/editions` and shows the selected
location's latest published edition, or "No edition yet." API failures are shown. Keep components lightweight until UX flows
and designs are supplied.

No public hosting, reader accounts, subscriptions, or behavioral analytics are
scaffolded here. Use the root README's setup and launcher commands.
`PUBLIC_API_URL` optionally changes the API origin at build/start time; it
defaults to `http://127.0.0.1:8000`. Cross-origin access is allowed only from the
default local website origins.
