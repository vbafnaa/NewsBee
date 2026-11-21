# Reader UX design coverage

Design source: [Newsbee Drafting — Copy](https://www.figma.com/design/wD2rpKuxDtzcTVhtpAwcgS/Newsbee-Drafting--Copy-?node-id=0-1).
Reviewed on November 12, 2026. The file contains **Wireframes + IA** and **User Flows**.
This records the implemented screens and action flows, including the follow-up work
requested for the concepts on the User Flows page.

## Screen coverage

| Figma reference | Implementation |
| --- | --- |
| [Ballard front page](https://www.figma.com/design/wD2rpKuxDtzcTVhtpAwcgS/Newsbee-Drafting--Copy-?node-id=17-415) | `NeighborhoodHome`, `TopNews`, `EventsWeek`, `Newsroom`, and shared header/footer. |
| [Moses Lake front page](https://www.figma.com/design/wD2rpKuxDtzcTVhtpAwcgS/Newsbee-Drafting--Copy-?node-id=17-820) | Shared front-page components plus `NeighborhoodWelcome` and the existing interactive `CommunityScene`; the illustrated welcome also applies to Wedgwood. |
| [Newsletter Format](https://www.figma.com/design/wD2rpKuxDtzcTVhtpAwcgS/Newsbee-Drafting--Copy-?node-id=17-1031) | `AllStories`, with shared reader typography and navigation. This is a web edition view, not email delivery. |
| [Story Submission Form](https://www.figma.com/design/wD2rpKuxDtzcTVhtpAwcgS/Newsbee-Drafting--Copy-?node-id=26-541) | `src/pages/share.astro`, retaining photo upload, consent, validation, and submission behavior. |
| [Proposed IA](https://www.figma.com/design/wD2rpKuxDtzcTVhtpAwcgS/Newsbee-Drafting--Copy-?node-id=25-264) | Top news, events, housing, policy, other news, signup, submission prompt, and edition notes; `OtherNews`, matching header/footer navigation, and source count. The existing bee game remains available before signup. |
| [Moses component studies](https://www.figma.com/design/wD2rpKuxDtzcTVhtpAwcgS/Newsbee-Drafting--Copy-?node-id=17-783) | Reused header, story-card, event, signup, and button compositions rather than separate demonstration screens. |

Component paths above are under `apps/reader-site/src/components/edition/` unless
otherwise stated. Fonts are bundled locally; story and community imagery remain
data driven, including photo provenance and interactive scene behavior.

The proposed IA takes precedence where the earlier Ballard layout, Current IA,
and low-fidelity studies show a different section order. The latest user request
deliberately makes both illustrated welcome animations larger, with tighter
spacing than the static Figma reference.

## Completed follow-up flows

| Figma reference | Implementation |
| --- | --- |
| [Share Newsletter](https://www.figma.com/design/wD2rpKuxDtzcTVhtpAwcgS/Newsbee-Drafting--Copy-?node-id=27-819) | `ShareEdition` on the front page and web newsletter: native sharing, clipboard, manual fallback, no-JavaScript permalink, and an exact community/edition URL. |
| [Potential Editor interest Form](https://www.figma.com/design/wD2rpKuxDtzcTVhtpAwcgS/Newsbee-Drafting--Copy-?node-id=27-846) | `/reader/become-editor`: community, experience, motivation, and contributor/lead/start-a-branch intent; durable private receipt and review-required next steps. |
| [Community champion needs](https://www.figma.com/design/wD2rpKuxDtzcTVhtpAwcgS/Newsbee-Drafting--Copy-?node-id=27-971) | `/reader/contact`, linked from discovery and community pages, plus existing story, source, remembrance, and problem-report flows. Contact and editor submissions are reviewed in the protected editorial Inbox. |
| [Entrepreneurial journalist needs](https://www.figma.com/design/wD2rpKuxDtzcTVhtpAwcgS/Newsbee-Drafting--Copy-?node-id=27-972) | Public branch-interest intake feeds a private review workflow with statuses, reviewer notes, and history. Accepted applicants are provisioned through the existing protected Administrators and Locations workflows; submitting a public form never grants privileges or starts paid pipeline work. |
| [Newsletter versus platform](https://www.figma.com/design/wD2rpKuxDtzcTVhtpAwcgS/Newsbee-Drafting--Copy-?node-id=27-973) | `/reader/browse`: search across published editions, community/topic filters, pagination, edition history, and exact version links. Newsletter signup supports topics, email confirmation, private preference management, unsubscribe, personalized edition emails, durable delivery receipts, and protected dispatch/operations. |

Newsletter code is implemented and can be exercised with a local test mailbox.
Production sending requires a configured provider and verified sender. See
[newsletter delivery setup](newsletter-delivery.md) for configuration and operating limits.

Neighborhood selection, section browsing, event/story reading, individual-story
sharing, signup intake, story submission, remembrance submission, and return
navigation already support the main action paths in the flow diagrams.

## Independent publication releases

The Reader uses the selected Option A location-first flow for independent
publications. `/reader/locations/<location>` presents one branded card per
publication, with the current immutable release and a publication-specific
newsletter target. `/reader/subscribe?publication=<publication-id>` is the stable
handoff contract for the publication newsletter layer; until that layer is
available it records no consent and does not fall through to the separate
community-edition subscription.

Publication latest, archive, exact-release, section, event, and story views reuse
the public Reader header, footer, typography, sponsor disclosure, and share
behavior. They use stable `/reader/publications/<publication-id>/releases/<release-id>`
URLs and do not pass through the legacy Bee game or mutate legacy location
editions.

Browse and search have an explicit non-duplicative indexing boundary. The current
release for each publication is loaded directly and its stories participate in
search, including source-reference deduplication against legacy editions. Compact
manifest metadata adds every immutable release to history exactly once, even
when it covers several locations. Older release story bodies are not eagerly
loaded into the global search index; their exact release links remain available
from browse history and the publication archive. This avoids listing or parsing
all historical release artifacts on every browse request.

`npm run newsroom:local` exercises the release workspace and Reader routes with
an isolated Mongo replica set. Its default `.local/newsroom-release` data remains
persistent; parallel review runs can set `NEWSROOM_RELEASE_DATA_DIR`,
`NEWSROOM_RELEASE_MONGO_PORT`, `NEWSROOM_RELEASE_EDITOR_PORT`, and
`NEWSROOM_RELEASE_READER_PORT` without resetting that default data.

There are no standalone journalist-workspace designs or mobile-specific frames
in this file. Journalist functionality is preserved; mobile layouts are responsive
adaptations of the reader screens. The file's style-guide image and earlier
low-fidelity/Current IA artifacts are references, not additional product screens.

## Verification

The branch includes the fetched `main` revision `290048c`. Both public deployed apps
responded successfully; exact deployment commit metadata was unavailable. Existing
published-reader data contracts, shared-domain routing, deployment restrictions, and
the pipeline queue trigger are preserved.

188 focused regression tests passed, including existing reader behavior, data clearing,
new intake and newsletter routes, and deployment routing. Both applications passed
typechecks and production builds. Public and protected layouts were
checked at 1440, 768, 390, and 320px. The isolated local newsletter journey verified
confirmation, topic changes, duplicate prevention, pinned article links, unsubscribe,
and no subsequent delivery; no external email was sent.

Those initial layout tests used older isolated fixtures and did not establish parity
with the currently published editions. The follow-up
[deployment parity check](reader-deployment-parity.md) records the current public
edition IDs, the preview refresh procedure, and the separate unmerged-feature
integration concerns. Check live edition IDs and payloads as well as Git ancestry
before calling a later UX preview current.
