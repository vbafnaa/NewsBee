# Local observability

Home for future local health-view definitions and telemetry configuration.
Backend instrumentation code belongs in
`projects\backend\shared\observability\`, not here.

The backend's `/api/health` feeds the review console's `/review` page. It reports
API liveness, SQLite access, worker heartbeat, Ollama/model availability, local
SMTP connectivity, job counts, and the last completed job timestamp. No completed
jobs or implemented editorial workflows are invented.

The worker emits a heartbeat every two seconds; health considers it stale after
15 seconds. These are operational defaults, not editorial thresholds.
HTTP 503 means at least one dependency is unavailable or not configured.
HTTP 200 means infrastructure is available, not that publication is safe.
Backend logs are structured JSON, including request duration and failures.
The launcher captures them in `.local\logs\`; frontend/Mailpit logs retain their
native formats. Logs contain operational metadata, not story prompts or evidence.

The roadmap's quality, human-workload, run-duration, and edition-cost measures
need real workflows and agreed definitions; they are not implemented metrics.

Do not store generated logs, telemetry exports, or runtime state here. No cloud
monitoring service or separate monitoring stack has been selected.
