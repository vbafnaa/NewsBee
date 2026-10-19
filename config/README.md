# Local prototype configuration

| Folder | Intended contents |
| --- | --- |
| `local\` | Shareable local environment templates and service settings |
| `communities\` | Community identities and coverage definitions |
| `sources\` | Onboarded sources, connector selections, URLs, and source settings |
| `editorial_policies\` | Versioned policy configuration once editorial decisions are confirmed |

Store declarative configuration here, not scraping code, runtime state,
credentials, downloaded evidence, or models. Source-agent pipelines and
connector implementations live under
`projects\backend\modules\source_connectors\`.

Infrastructure settings are validated in
`projects\backend\shared\configuration\settings.py`; environment variables and
ignored runtime paths are documented in the root README. Community, source,
and editorial-policy formats are not general-purpose schemas yet.
`communities\capitol-hill-seattle.json` records the initial location and coverage
limitation. `sources\spl-capitol-hill.json` is the one enabled, validated source:
the official RSS feed, strict branch venue URL, local-only usage, and unresolved
redistribution permission. Changing the source requires deliberate onboarding,
not supplying an arbitrary URL to the worker. No editorial defaults are implied.
