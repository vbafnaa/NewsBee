# Local review console

Home for the minimal internal Stage 1 interface for editorial exceptions,
review decisions, audits, and corrections. Consume the local backend API;
publication checks and review state remain owned by backend editorial modules.

Cross-project contracts belong in `shared\contracts\` at the repository root.
Jinja renders `templates\index.html` through the backend's `/review` route.
`/review` is an operations dashboard: `static\health.js` combines `/api/health`
(service and capability status, latest runs) with `/api/metrics?days=N` (success,
held and model-fallback rates, events, queue depth, heartbeat age, per-day charts,
source coverage, and per-location freshness over a 1-30 day window; contract in
`shared\contracts\metrics.py`). It auto-refreshes every 30 seconds; charts are
inline SVG, with styles in `static\dashboard.css`. This separate
folder is a logical UI boundary, not another server or independently deployed
service. No frontend build step is needed.

Keep presentation lightweight and defer detailed UX design. This project is
served by the local backend; see the root README. Pages are read-only: health,
ingested events, and an edition audit of held items (kept as future training data).
There is no review or publish action.
