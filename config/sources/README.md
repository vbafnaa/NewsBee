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

The seed reflects only the three checked-in files listed above. It does not contain
onboarded location profiles from SQLite or journalist-admin accounts. The running backend
does not yet read these MongoDB documents; this file prepares the source configuration
data shape for migration.
