# Editorial illustration pipeline

Updated November 7, 2026. AI illustrations are the default for new runs and for reader editions without an explicit media preference. The photo sourcing and permission workflow remains available by choosing a photo mode.

The stages are **author and validate the story → classify its subject → choose reviewed artwork → allocate distinct images across the edition → attach illustration references → publish → render responsive artwork**.

## Artwork and neighborhood identity

The collection contains **44 original AI-generated images**, created with the built-in imagegen tool: forty subject illustrations, two neighborhood panoramas and two local subject variants. The expanded collection includes distinct theater and improv scenes, puppets, receptions, films, volunteering, parks, food, civic work and individual sports. Full prompts and generation provenance are in [illustration-art-direction.json](illustration-art-direction.json). Optimized full-size and 960-pixel WebP files live in `apps/reader-site/public/illustrations/`; original PNGs are retained locally under `.local/illustrations/originals/`.

The art direction takes inspiration from [Bainbridge Newsbee](https://www.bainbridgenewsbee.com/): delicate ink lines, loose watercolor, warm paper and feathered edges. The artwork is newly generated rather than copied from the reference site.

| Community | Visual identity | Individual assets |
| --- | --- | --- |
| Wedgwood | Leafy residential streets, mature trees, gardens and small neighborhood shops; forest green, maple gold and terracotta. | A panoramic welcome image and a cozy reading-nook variant for matching book/library stories. |
| Moses Lake | Open inland water, golden reeds, low dry hills and spacious Columbia Basin light; lake blue, sage and warm gold. | A panoramic welcome image and a football still life with a lakeside, semi-arid setting. |

Wedgwood's reviewed cues come from the [community council boundary description](https://www.wedgwoodcc.org/about/neighborhood-map/) and Seattle Parks' [description of its mature trees, gardening and natural landscape](https://www.citylink.seattle.gov/parks/about-us/projects/wedgwood-landbanked-site-park-development). The planned pocket park is not depicted as an existing finished park. Moses Lake's [2026 municipal budget](https://www.moseslakewa.gov/DocumentCenter/View/12935/2026-FINAL-BUDGET-BOOK) describes its sunny Columbia Basin/lakeshore setting. Its municipal [Japanese Peace Garden record](https://www.cityofml.com/Facilities/Facility/Details/Japanese-Peace-Garden-37) was reviewed as an additional local identity lead; those structures are not copied into an invented lakeshore scene. The panoramas are interpretive neighborhood portraits, not maps or depictions of particular businesses, people or completed projects.

Neighborhood art is selected by reviewed location IDs in `shared/neighborhood-illustrations.ts`. Local story variants remain subject-matched: a Moses Lake football scene is never used for a basketball story, and a reading nook never substitutes for a person portrait. Other communities receive the shared subject collection rather than another community's panorama.

Community welcomes also support animated watercolor portraits. Motion regions and mobile focal points are configured per community; the reusable renderer provides pause controls, reduced-motion and static fallbacks. See [animated community portraits](community-scenes.md) for the behavior and steps to add another community.

## Selection and publication

`shared/editorial-illustrations.ts` contains the reviewed subjects, asset IDs and deterministic selector. A subject must match the headline; incidental words in the article body, source name or venue cannot qualify an otherwise unrelated image. Body text helps compare already-qualified matches. Comedy, mime, improv, music and tree planting have separate subjects. Canceled events, sensitive incidents, death notices, police/court/census records and unsupported topics remain text-only.

Allocation considers the complete edition, prioritizes events, and matches each story to a distinct suitable drawing. Flexible matches can move to another relevant drawing to leave a constrained story covered. The same assignment follows a story through the front page, section, event list and article. A neutral blank-calendar drawing can cover an otherwise unmatched event; it never implies a particular activity and is not a fallback for news. The neighborhood welcome art appears only on the neighborhood homepage. If the collection has no distinct suitable image left, the article stays text-only. Adding a new image requires an original generation, visual review, provenance, a controlled asset entry and a matching rule. There is no automatic paid generation during a run.

New runs default to `NEWSBEE_IMAGE_MODE=illustrated`. Both discovery flows use the existing image-job checkpoint, record the illustration plan, skip photo search/vision/stock services, and continue through the existing finish stage. Finishing builds the edition; publishing it to the reader is a separate explicit action. Assembly allocates against the final ordered items and saves `media_mode`, `illustration_id`, `illustration_asset_id` and `illustration_policy`. Article text, sources, rank and IDs retain their existing behavior. Illustrations never use a photographer's byline or a false photo license/date.

The illustration planner consumes validated stories. It does not select discovery tools, change source ranking, or approve new sources. The reviewed spreadsheet catalog is an optional editor import; discovery does not automatically seed sources from it. The current source-review controls and explicit publication workflow remain the authority for those steps.

There are **no per-story image-generation calls during a run**. New artwork is created as a separate asset-authoring step, then reviewed and committed with its prompts. The built-in imagegen path does not read the private image-vision environment file or require a runtime image-generation API key. This implementation does not add automatic paid image generation.

The reader defaults to illustrated presentation for older payloads too, so the existing local editions can show artwork without rewriting their news or republishing stored records. `NEWSBEE_READER_MEDIA_MODE=illustrated|photos|none` overrides presentation; otherwise an edition's explicit `media_mode` wins over the illustrated default. Existing photo modes continue to enforce their original rights, quality, archival and withdrawal checks.

## Reader and testing

`StoryIllustration.astro` keeps the full composition visible and uses responsive local WebP assets without repeated generation captions. The neighborhood welcome art also has no caption. Generation provenance and the explanation that these are representative images remain on `/reader/illustrations` and in the art-direction record. Descriptive alternative text remains available, and illustrations render separately from documentary photos.

Local preview on the existing development server:

- [Full artwork collection](http://127.0.0.1:4322/reader/illustrations)
- [Wedgwood](http://127.0.0.1:4322/reader/?location=osm-r13915552-wa)
- [Moses Lake](http://127.0.0.1:4322/reader/?location=moses-lake-wa)

Run `npm run illustrations:test` in `apps/journalist-site`, `npm run lint` there, and `npm run check` in `apps/reader-site`. The tests cover topic conflicts, sensitive stories, duplicate allocation, original pixel decoding, location scoping, publication metadata, existing photo behavior and network-free illustrated runs. Both production builds should pass before deployment. Preview changes in this worktree do not deploy the production site.
