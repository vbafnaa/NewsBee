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
Locations are onboarded with `scripts/dev.py onboard` and stored in the local database,
not here. No editorial defaults are implied.

`library-websites.json` maps an IMLS FSCS key to a reviewed `{name, website}` for
library systems Wikidata cannot resolve. The name must match the directory, the
website must be `https://`, and the entry overrides Wikidata. Re-run `onboard` after
editing it.
