# Cloud source configuration

The journalist pipeline bundles `library-websites.json`, `government-sources.json` and
`state-sources.json` and seeds them into MongoDB `source_configs` on first use. Existing
documents are not overwritten; changing a checked-in seed does not update a live database.
See [`sources/README.md`](sources/README.md) for the document shape and import procedure.

These reviewed overrides support automatic connector discovery. Location-specific manual
links are validated in the journalist console and stored in `location_source_links`, not
in this directory. Keep credentials, downloaded evidence and runtime state out of config.

The Python prototype's preview-subscriber settings and unused configuration placeholders
are retained under [`archive/python/config`](../archive/python/config/).
