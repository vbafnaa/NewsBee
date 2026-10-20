# MongoDB source configuration seed

`mongodb-source-configs.json` is an importable JSON array for the `source_configs`
collection. It contains one document for each current source configuration file:

| `_id` | Source file |
| --- | --- |
| `library-websites` | `config/library-websites.json` |
| `government-sources` | `config/government-sources.json` |
| `state-sources` | `config/state-sources.json` |

Each document stores the source file path in `config_path` and preserves the file's
complete JSON value under `data`. Re-importing with upsert on `_id` replaces the matching
configuration document without duplicating it.

To import from PowerShell, with `MONGODB_URI` and `MONGODB_DATABASE` set in the current
environment and MongoDB Database Tools installed:

```powershell
mongoimport --uri "$env:MONGODB_URI" --db "$env:MONGODB_DATABASE" --collection source_configs --jsonArray --mode upsert --upsertFields _id --file config\sources\mongodb-source-configs.json
```

The TypeScript pipeline reads library websites, government platforms and state newsroom
feeds from these MongoDB documents. It automatically inserts missing seed documents from
the three checked-in source files; it does not overwrite existing documents. The portal
exposes this global configuration read-only. Location-specific manual links are validated
and stored separately in `location_source_links`.

The import file is a snapshot of only the three files listed above. Refresh it if you
intend to import updated checked-in seeds; upserting it replaces live global overrides.
It does not contain onboarded location profiles or journalist-admin accounts.
