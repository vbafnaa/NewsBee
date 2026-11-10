# Photo supply research: Wedgwood and Moses Lake

Checked November 3, 2026, Pacific time. Scope is these two communities only.
This is a research inventory, not an approval import or a publication run.

The implementation now includes a **Review inputs → Photo supply** workbench, private
permission invitations, an organizer submission form and administrator approval into the
scoped catalog. See [the concrete unsent requests](photo-permission-requests.md) and
[the pipeline documentation](image-pipeline.md#photo-supply-and-subject-discovery).
The researched files still require their stated rights and capture-date confirmations.

The follow-up [current-story shortlist](image-supply-current-stories.md) maps additional
photo leads to the complete published editions, records source access checks, and separates
permission requests from files rejected for age, location or resolution.

The strongest immediate discovery is a substantial **2026 Wedgwood Car Show collection**
that our narrow image searches were missing. For recurring people photos, the most
useful suppliers are community/event organizers and artist media contacts. Many of
their photos are visible, but no reuse agreement has been obtained for Newsbee.

## Verified findings

| Finding | What was verified | What it establishes |
| --- | --- | --- |
| Wedgwood car show | Commons' live category API returned **50 file records**, without continuation. Image metadata was checked for **30**: Joe Mabel, captured **2026-08-23**, CC BY-SA 4.0, generally 6,000 by 4,000 native pixels (some portraits). | A real, recent, independently licensed collection about this specific local event. It is not 50 interchangeable photos of neighbors. |
| Three Wedgwood examples | Three JPEG derivatives downloaded successfully, fully decoded at **3,840 by 2,560**, and visually inspected during this research. | Vehicle/event photos exist at useful resolution. The Buick frame includes attendees in the background; it is not a people-focused portrait. |
| Downtown Moses Lake | The Commons file credited to **Quintin Soloviev**, captured **2026-04-01**, is CC BY 4.0. The original downloaded and fully decoded at **7,284 by 4,857**, 4,119,364 bytes. | A recent real downtown place photograph. Visual inspection shows the street and Moses Lake clock; use that factual description rather than automatically copying the file's broad aerial-view caption. |
| Moses Lake city gallery | The official **2026 Cleanup Event** album returned HTTP 200. Its page exposes original image references as well as small album-navigation thumbnails. | A promising documentary-photo supply, with permission and capture-date/credit checks still needed. Website availability is not image reuse permission. |
| City photo RSS | The city publishes links to all-photo and cleanup-album RSS feeds. Robots checks blocked the exact feed URLs for at least one of the agents checked, so **the feed bodies were not requested**. | A documented delivery lead, not a working approved photo integration. |
| National Guard / Forest Service | DVIDS lists an April 29, 2026 Moses Lake Readiness Center photo set and an August 8, 2026 photograph explicitly showing a Moses Lake Fire Department crew at a Spokane fire. Individual pages identify their images as public domain and state their reuse conditions. | Narrowly relevant documentary/venue candidates. Original downloads require the site's authorized account/download route; that was not bypassed. |
| Upcoming photo-bearing stories | First-party sources list Moses Lake's **November 20 tree lighting**, **November 21 Booker T. Jones concert**, and **January 8, 2027 Nevermore performance**; an author's own site lists a **November 22, 2026 Wedgwood bookstore appearance**. | Concrete subjects for obtaining relevant organizer/performer photos. An event date does not prove the accompanying photo was recently captured. |

The [candidate CSV](image-supply-candidates.csv) and [structured inventory](image-supply-research.json)
contain the file links, rights evidence and matching restrictions. The CSV contains the
30 metadata-checked Wedgwood files plus the Moses Lake Commons photograph. Four of those
31 files were downloaded and visually inspected; the rest are metadata candidates.
None has been approved by the runtime photo editor for a particular story.

## Wedgwood sources, in priority order

| Priority / source | Actual supply and delivery | Rights/access decision | Next concrete step |
| --- | --- | --- | --- |
| P0: [19th Annual Wedgwood Car Show collection](https://commons.wikimedia.org/wiki/Category:19th_Annual_Wedgwood_Car_Show) | 50 indexed files; 30 checked file-level license/date records. Use the official Commons category-members and image-info APIs, then select wide event frames over engines and dashboards. | The checked files are CC BY-SA 4.0. Preserve Joe Mabel credit, license and crop/change information. Three downloaded samples are sharp vehicle photographs. | Add bounded category-based discovery and source/event identity matching. Retain the August 23 capture date and exact car-show relationship. |
| P0: [Lovestruck in Seattle press page](https://www.lovestruckinseattle.com/pages/press) and [contact](https://www.lovestruckinseattle.com/pages/contact) | Three press-page image links; permanent Wedgwood location at 8507 35th Ave NE. The shop has author events and pop-ups. [Alexa Shay's own events page](https://www.alexashays.com/events) lists a November 22 appearance there; time is TBD. | No explicit Newsbee image reuse scope, photographer or capture dates were established. The page describes both the former pop-up and the current location: do not mix their photographs. | Request a 2026 shop exterior/interior, adult owner/author portrait and approved event-photo delivery, with captions and credit. Use the public general-contact form; do not submit it automatically. |
| P1: [Wedgwood Community Council](https://www.wedgwoodcc.org/) | Primary neighborhood stories, the community picnic and business-district events. Public homepage was read through web research. A WordPress media integration could enumerate several approved images per post. | The direct research robots request returned 403; the existing permission hold remains. No publisher photos were cleared. | Ask `admin@wedgwoodcc.org` for an approved feed/export plus separately approved current picnic/volunteer photos. Do not treat sponsor logos or ads as documentary photos. |
| P1: [Wedgwood PTA](https://www.wedgwoodpta.org/meet-the-pta) | Leadership images and school/community event supply. Public site lists `president@wedgwoodpta.org`. | Robots explicitly excludes the AI agents checked. Public family/leadership images do not establish permission to republish, and may include children. | Request supplied adult organizer photographs and event images already approved for external publication, with applicable permissions. Prefer an organizer-provided folder/manifest over crawling the PTA site. |
| P1: [Northeast Library branch](https://www.spl.org/hours-and-locations/northeast-branch) | Branch photo gallery and a supported SPL events calendar. SPL's [newsroom](https://www.spl.org/about-us/news-releases) identifies Laura Gentry, `laura.gentry@spl.org`, as the media contact. | Public branch page returned 200; robots returned 404 in this check. Reuse permission and capture dates for gallery photos were not established. The existing source review also requires selecting/confirming this branch's relevance to the Wedgwood edition. | Obtain an approved 2026 exterior/interior and event/organizer images. Confirm edition coverage and select the branch before enabling its events. |
| P2: [Wedgwood Car Show organizer](https://www.wedgwoodcarshow.com/) / [Wedgwood Broiler](https://wedgwoodbroiler.com/contacts/) | Organizer confirms the nineteenth show on August 23, 2026, in the Broiler parking lot. Broiler's public contact is `wedgwoodbroiler@yahoo.com`. | Organizer robots specifies a 10-second delay; no publisher-photo reuse grant was established. The independently licensed Commons files are a separate rights path. | Request future event notices and current organizer-approved wide shots with people. This can provide a recurring photo supply beyond this one Commons collection. |

Do not reuse the Commons Northeast Library photographs from **2008/2015** for current
context. They were checked and remain outside the 365-day rule. A newly edited Commons
category or a recently indexed page cannot make the original photo recent.

## Moses Lake sources, in priority order

| Priority / source | Actual supply and delivery | Rights/access decision | Next concrete step |
| --- | --- | --- | --- |
| P0: [Downtown Moses Lake Association events](https://www.downtownmoseslake.org/events) | Actual downtown events: tree lighting November 20, 2026, and agricultural parade/street party December 4. The [team page](https://www.downtownmoseslake.org/team-4) lists `director@downtownmoseslake.org` and `events@downtownmoseslake.org`. | Event hero images can be promotional artwork; no blanket photo license was found. The public team portraits are not generic resident photos. | Request dated documentary originals of downtown gatherings and Sinkiuse Square, plus a weekly event/photo manifest. Keep flyers distinct from photographs. |
| P0: [Columbia Basin Allied Arts](https://www.cba-arts.org/) / [contact](https://www.cba-arts.org/contact/) | First-party season announcement connects specific performers and dates to the Wallenstein Theater in Moses Lake. | Artist photos, show artwork and captions require item-level rights and current capture-date evidence. Newsbee has no agreement yet. | Obtain a current approved performer portrait and press images per confirmed local show. Ask the organizer to supply the artist-approved originals and required credits. |
| P0: [Ballet Fantastique Nevermore presenter page](https://www.balletfantastique.org/nevermore-touring) | Explicit print-resolution press-image links, credits to Bob Williams and Jeremy Bronson, plus a separately credited Greg Burns image. Contact: `hannah@balletfantastique.org`. A Moses Lake January 2027 stop is listed; CBAA gives January 8. | Advertised press resources are promising, but this page also covers the show's 2019/2023 history. Capture dates and the precise editorial-use/crop permission were not established. | Request 2026 images appropriate to the January 2027 event and written use/credit terms. Do not silently treat older touring images as newly captured. |
| P1: [City 2026 Cleanup Event gallery](https://www.moseslakewa.gov/gallery.aspx?AID=23) and [photo feed directory](https://www.moseslakewa.gov/rss.aspx) | The album page exposes original document image URLs, including IDs 13541, 13540 and 13538. RSS offers an album-specific and an all-photo route. | [City copyright notice](https://www.cityofml.com/site/copyright) reserves rights. Robots requests require a 10-second delay, above Newsbee's current 5-second collector limit; exact RSS paths were also blocked in the research rules check. The gallery itself was read with a full 10-second interval honored. | Ask city communications for a permitted photo export/feed and original files, date, credit and reuse scope. Any future approved crawler must honor the site's delay. Do not work around the RSS restriction using URL spelling changes. |
| P1: [Moses Lake Chamber of Commerce](https://moseslake.com/) | Public site has community/business events, including a November 3 listing, and numerous image elements. Contact: `information@moseslake.com`. | Homepage returned 200 and robots 404. Image-element count includes branding and graphics and is not a count of usable photos. No redistribution grant or capture dates were established. | Request 2026 networking, business-opening and organizer photos through a supplied folder/export. Verify the photographer and place for every image. |
| P1: [DVIDS Readiness Center exterior](https://www.dvidshub.net/image/9652130/past-present-moses-lake-armory-reimagined-modern-readiness-center) | Joseph Siemandel, April 29, 2026, 5,412 by 3,360. The associated set contains eleven images of the Moses Lake facility. | The item is identified as public domain, subject to [DVIDS reuse conditions](https://www.dvidshub.net/about/copyright). Original-download access is separate and account-gated. Current Commons-only license handling is not a DVIDS integration. | Add a provider-specific evidence/credit path only for a matching facility or Guard story, and obtain originals through the authorized account/API route. Keep non-endorsement information where required. |
| P1: [Moses Lake crew at the Old Trails Fire](https://www.dvidshub.net/image/9863749/spokane-area-fires) | Benjamin Cossel / U.S. Forest Service; August 8, 2026; source lists 8,256 by 5,504, 11.23 MB and explicitly identifies the Moses Lake Fire Department engine/crew. | Item is marked public domain with DVIDS conditions. It was photographed **near Spokane**, not in Moses Lake. Original exceeds the current 6 MiB and 40-megapixel guards; the visible 1,000-pixel preview is too small for a card. | Use only for reporting on this documented crew deployment/incident. Obtain an authorized sufficiently large derivative that fits the existing guards. It cannot illustrate unrelated dispatch records. |
| P2: [Recent Commons downtown photograph](https://commons.wikimedia.org/wiki/File:Moses_Lake,_Washington.jpg) | Quintin Soloviev, April 1, 2026, CC BY 4.0. Original bytes and dimensions verified; visually inspected. | Licensed candidate, not a match for the current Census housing brief. A broad town view does not meet the current exact event-venue/permit-street rule by itself. | Retain as a place-specific research-library asset for a qualifying future story, with precise scene caption and original attribution. |
| P2: [Booker T. Jones official site](https://bookert.com/) and [label press page](https://www.anti.com/artists/booker-t/) | Official artist/label media paths exist; the label page links a press photo and publicist contact. CBAA confirms the November 21 local performance. | The checked label material contains a 2011 biography/album campaign. A current footer is not a recent photo date. | Obtain the current touring press kit through CBAA/artist management; do not use the historical label portrait as a 2026 capture. |

## Exact city photo-feed leads

These links were followed from the city's RSS directory, not guessed:

- [2026 Cleanup Event RSS](https://www.moseslakewa.gov/RSSFeed.aspx?CID=2026-Cleanup-Event-23&ModID=53)
- [All photo albums RSS](https://www.moseslakewa.gov/RSSFeed.aspx?CID=All-0&ModID=53)

Both remain **unfetched under the current robots check**. The directory's public feed
offering and the blocked endpoint need to be resolved with the city. Neither status
grants redistribution rights for the photos in those albums.

## Additional discovery and extraction providers

| Provider | Verified capability / fit | Integration decision |
| --- | --- | --- |
| [Commons category API](https://www.mediawiki.org/wiki/API:Categorymembers) + [image-info metadata](https://www.mediawiki.org/wiki/API:Imageinfo) | Live public API calls succeeded without a key. Category discovery surfaced the Wedgwood collection. Individual file metadata includes license, credit, capture-date information and size/original URLs. | First implementation priority. Keep each category tied to an actual event or venue, bound traversal, deduplicate files and apply the same file/story quality checks. |
| [Openverse](https://docs.openverse.org/api/reference/search_algorithm.html) | Official API supports license, source, image-size and aspect-ratio filters. Four bounded live research requests timed out here; **no additional live image candidates were verified**. | Secondary discovery adapter after connectivity is resolved. Restrict to accepted BY/BY-SA/CC0 licenses, deduplicate Commons results and verify the original file's capture date and reuse evidence. An indexed date is not a capture date. |
| [Flickr search API](https://www.flickr.com/services/api/flickr.photos.search.html) | Official API supports license, taken-date and geographic filters. Public-photo search still requires an application API key; it does not require a user's private-photo authorization. | Potentially useful for recent local images. No key/account was created and no Flickr API calls were made. Review the API's applicable application/commercial-use terms and validate per-file licenses; do not confuse public visibility with reuse permission. |
| [WordPress media API](https://developer.wordpress.org/rest-api/reference/media/) | Documented media endpoint exposes originals, dimensions and media details. Its `date` field is publication time. Multiple approved attachments can be collected rather than only the first Open Graph image. | Use only for a source with approved delivery and image reuse. Check actual capture metadata or supplied captions; do not substitute the REST publication date. WCC's current access hold remains. |
| [Pexels API](https://www.pexels.com/api/documentation/) | Documented free API with a key, photographer information and several sizes. The shown photo schema has no reliable capture-date field. API rules require a prominent Pexels link and photographer credit when possible. | Optional secondary stock supply only. No service was enabled. It needs provider-license support, API-compliant presentation and capture-date evidence before it can satisfy current policy. It is not a source of verified Wedgwood/Moses Lake residents. |
| [Unsplash API](https://unsplash.com/documentation) | Requires use of API-returned CDN image URLs, attribution and download-event tracking. | Lower priority. The API delivery contract does not fit the current archive-and-serve-everything design unchanged. Do not plug API images into our ordinary caching proxy and assume the contract is satisfied. |

## What should change in the pipeline

1. **Find the story and image together.** Obtain approved, photo-bearing event/organization
   supply for the two editions. In the last saved publications, Wedgwood's two stories
   were a dispatch summary and a court case; Moses Lake's one story was Census housing
   data. All three intentionally exclude context photos. None of the new assets should
   be forced onto those stories.
2. **Add a bounded Commons category path.** A known local event category produced 50
   file records when broad name searches returned pottery, unrelated places or old files.
   Match verified event/place IDs and aliases; do not remove locality checks to boost yield.
3. **Extract multiple permitted candidates.** After source approval, inspect all relevant
   article/event image fields, linked originals and supported media attachments. Sort out
   icons, logos, covers, posters, duplicate crops and thumbnails before spending vision calls.
4. **Maintain a community photo catalog independently of an edition.** Store community,
   event/venue, capture date, author, evidence, license/use scope, native dimensions,
   withdrawal/expiry and hash. Fetch candidates in the background/local preparation stage;
   match and vet them against each finished story before publication. Reuse the existing
   MongoDB asset storage after approval rather than introducing a paid storage service.
5. **Keep the visual gates and free setup.** The next gain comes from source supply and
   discovery, not automatically increasing Ollama calls or accepting smaller/older images.
   Keep stock secondary, 365-day known capture dates, no upscaling, sensitive-record context
   exclusions and the final desktop/mobile crop critic.

## Implementation and testing

The scoped catalog, bounded category discovery, multiple article candidates and isolated
inspection commands are implemented in this worktree. See
[Photo catalog: permissions and testing](photo-catalog-testing.md) for commands, grants,
revocation behavior and the distinction between research candidates and runtime approval.

## Archival leads for a separate history feature

The user supplied an archival-research experiment on November 3. Its search/read/assess
loop fits source discovery, with a distinct history policy rather than exceptions for
ordinary news photos. An anniversary date belongs to the historical event; a supporting
portrait or scene may have a different capture date if accurately captioned and verified.
Approximate dates must retain their precision. Reading an archive record does not grant
photo reuse, and unresolved leads should retain evidence, a missing-field status and a
specific next action after bounded searches.

Two primary leads were checked:

- [Moses Lake Museum's June 2025 newsletter](https://cityofml.com/DocumentCenter/View/12709/June-2025-Newsletter)
  identifies collection photo IDs, including `2001.001.0519`, and a curator contact.
  These are requests for original files and rights evidence, not cleared assets.
- [Wedgwood Elementary School Photograph Collection](https://archivespace.seattleschools.org/repositories/2/accessions/8778)
  returned HTTP 200 after its robots rules were checked for the agents used. Individual
  photo dates, available scan resolution and reuse terms remain unverified.

Neither lead was activated as a current-news photo source. No outreach was sent and
the existing 365-day current-photo requirement remains in force.

## Unsent request template

> We publish Newsbee's [Wedgwood / Moses Lake] community edition. Could you supply a small
> set of 2026 photographs for factual coverage of [specific event/venue]? Please include
> the original file, capture date, location/event, factual caption, photographer and exact
> credit, and confirm the permitted editorial uses in our reader/newsletter, storage,
> resizing/cropping and repeat use. Please identify any third-party rights, applicable
> subject permissions, restrictions or expiry, and the contact for corrections/withdrawal.
> A shared folder or feed with one metadata row per photo would work well.

No request was sent. No source holds were cleared, no paid account/API was activated,
no image was inserted into an edition and no publication or production deployment changed.
Private environment files were not read or modified for this research.

## Evidence and limitations

Raw bounded request records, category membership, metadata, downloaded research copies,
SHA-256 hashes and decoded dimensions are in the ignored local directory
`.local/source-research/photo-supply-2026-11-03/` in the original workspace. Request reports
distinguish successful reads, timeouts, robots holds and the 10-second city research interval.

The four downloaded files were visually inspected by the coding assistant during research;
they have not been given a story-specific Ollama review or final runtime crop approval.
Photographs of vehicles are not substitutes for people portraits. Public-domain statements
and CC licenses do not establish the identity, location or relevance of every visible person.
Do not turn this research catalog into an automatic publisher-image allowlist.
