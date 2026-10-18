# Local observability

Home for future local health-view definitions and telemetry configuration.
Backend instrumentation code belongs in
`projects\backend\shared\observability\`, not here.

The goal is at-a-glance product health. The roadmap identifies run duration,
unsupported claims and corrections, human workload, useful editions, and cost
per edition as areas to track. Confirm the initial indicators, presentation,
and tooling before implementing them; this scaffold sets no thresholds.

Do not store generated logs, telemetry exports, or runtime state here. No cloud
monitoring service or separate monitoring stack has been selected.
