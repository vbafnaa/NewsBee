# Cloud source configuration

The journalist pipeline bundles `library-websites.json`, `government-sources.json`,
`state-sources.json` and `communities.json` and seeds them into MongoDB `source_configs` on first use. Existing
documents are not overwritten; changing a checked-in seed does not update a live database.
See [`sources/README.md`](sources/README.md) for the document shape and import procedure.

These reviewed overrides support automatic connector discovery. Location-specific manual
links are validated in the journalist console and stored in `location_source_links`, not
in this directory. Keep credentials, downloaded evidence and runtime state out of config.

`communities.json` contains optional reviewed community overrides, independent of Census imports.
It defines parent jurisdictions, selected library branches, community relevance terms
and local publisher feeds. See the [community guide](../apps/journalist-site/README.md#neighborhood-and-community-coverage)
for entry requirements and how to update already-onboarded communities. New neighborhoods
are discovered through Photon in the onboarding UI; no entry here is required.
The legacy import snapshot in `sources/` contains only the original three source documents;
`communities` is automatically seeded separately.

Each state in `state-sources.json` may list `athletics` feeds (`name` and an `https` `feed`)
for the school athletics connector. Add a state association's feed only after checking
that its `robots.txt` and terms allow automated access. The connector reads team headlines
only, never summaries, because they can name students.

The Python prototype's preview-subscriber settings and unused configuration placeholders
are retained under [`archive/python/config`](../archive/python/config/).
