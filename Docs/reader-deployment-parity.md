# Reader deployment parity

Checked November 12, 2026 against the public reader at
<https://newsbee-seven.vercel.app/reader>.

## The stale preview

The original UX preview used the isolated `newsbee_ux_figma_qa` database and local
`.local/stage2/drive` files last refreshed November 1–3. It was not reading the current
published catalog. Its latest Moses Lake edition had 3 stories and its Wedgwood
edition had 76. Its Ballard ID was also different from the current public ID.
Comparing only Git ancestry and those old fixtures did not establish edition parity.

The public deployment still serves the editions shown in the reported screenshots:

| Community | Current public edition | Stories |
| --- | --- | ---: |
| Ballard | `58f02704-30c3-4833-bbbb-724ad734cd49` | 14 |
| Moses Lake | `3eab3bff-e36b-494a-8c39-4b2ca729fe38` | 17 |
| Wedgwood | `89bcfa4d-fba9-4203-863e-1768f8d6cad2` | 2 |

Moses Lake and Wedgwood cover November 12–18. Moses Lake includes the dense fog
advisory and football coverage. Wedgwood includes the Seattle transit measure and
the November 26 Thanksgiving event; that upcoming event must remain in the edition.
Duplicate published items must also be preserved when comparing item arrays.

The UX commits leave the reader catalog loader, edition parser, newest-publication
selection, article mapping, edition APIs, and publishing/storage pipeline unchanged.
The only change in `reader-data.ts` is an additional engagement action type. The UX
branch includes `main` revision `290048c`, and its new sharing/browsing controls are
absent from the public deployment. These UX commits did not replace the live reader.
The exact deployed commit SHA is available only after administrator sign-in, so
public feature and data parity do not establish an exact build SHA.

After refreshing the isolated preview, canonical hashes of the complete edition JSON
and the full ordered item arrays matched the public API for all three communities.
All 33 published items were retained. Home and full-newsletter layouts passed at
1440, 768, 390, and 320px (24 cases), with no broken images or browser exceptions.
Pinned article links opened the corresponding editions, including Wedgwood's
November 26 Thanksgiving event. Both local apps use the same fresh snapshot; the
local test mailbox configuration and isolated database remain in place.
The isolated Ballard search fixture was aligned to `ballard-seattle-wa`, with its
previous record preserved in QA backups. Selecting Ballard in the mobile picker now
opens the same 14-story edition; private workspace reads still succeed.

## Keeping previews current

Use the public snapshot command in the [reader README](../apps/reader-site/README.md)
before comparing a local UX preview with production. It performs public GET requests,
pins each fetched edition to the catalog's edition ID, and creates a new snapshot
directory. It does not overwrite old fixtures or write to the deployed services.
Keep the preview database and local email provider isolated. Both local applications
must use the same snapshot root so reader pages and newsletter dispatch see the same
published editions. Restart them to clear the existing catalog cache.

A latest-edition snapshot is not a complete historical archive. Production still
reads the configured published folder and its archived editions; that behavior is
unchanged. Public data can advance after a snapshot, so compare IDs again when
reviewing a later deployment.

## Other unmerged work

The newer release-reader (`4854699`), distribution (`2e0ce01`), and separate-portals
(`50081bd`) feature commits are not on current `main`. Public deployment probes did
not show their new publication metadata, publication email APIs, or portal routes.
They must not be treated as deployed solely because their timestamps are newer.

The refreshed stack deliberately keeps two email audiences. Community/location signup
continues through `/reader/subscribe?location=...` and `reader_newsletter_*`, and can
deliver only the latest public legacy/community edition. Publication signup continues
through `/reader/subscribe?publication=...` and `publication_email_*`, requires its own
signed confirmation, and can deliver only immutable releases for that selected
publication. Publication-shaped editions are explicitly rejected from the community
dispatcher.

The same address may opt into both audiences or multiple publications. Signed
preferences, unsubscribe, and suppression remain scoped to the explicit subscription,
so changing one does not mutate another. Deterministic per-system delivery identities
and disjoint artifact eligibility prevent a release/audience duplicate. The Journalist
**Newsletter delivery** view labels community versus publication status; community
batches run there, while publication release campaigns remain attached to their release
under **Publishing channels**. Live publication delivery remains blocked by the ESP,
domain, DKIM/SPF, webhook, shared-secret, and compliance prerequisites.
