# Relevant community photos

November 3 follow-up: [focused Wedgwood and Moses Lake research](image-supply-wedgwood-moses-lake.md)
adds live API findings, recent licensed files, specific suppliers and current access/rights holds.
The November 1 snapshot below remains historical research.

Research checked November 1, 2026 against the [shared source spreadsheet](https://docs.google.com/spreadsheets/d/13V3WG3vsXFpn_pwgqW2h__b2d2v8dBsWAbT-xbFdHFk/edit?gid=2144765667).

Real local photographs are available. Stock is optional; it would not solve the current
Beacon Hill edition's main problem: the run collected mostly records and did not include
several photo-rich community organizations listed in the spreadsheet.

The public CSV export contained 125 source rows. This review sampled promising photo
sources across Beacon Hill, Wedgwood/NE Seattle, Ballard and Moses Lake; it did not clear
every source or photograph for publication. Five image URLs and the Moses Lake newsletter
returned HTTP 200. The image examples were visually inspected, and newsletter page 4
was rendered and inspected. Research copies and request results are under
`.local/source-research/photo-examples/` and `photo-example-checks.json`.

## Verified examples

| Community / source | What I actually found | Appropriate use | What remains |
| --- | --- | --- | --- |
| Beacon Hill: [Beacon Food Forest work parties](https://www.beaconfoodforest.org/work-parties) | A genuine group photo of people gardening. The [about page](https://www.beaconfoodforest.org/about-us) also has a substantial gallery with photographer credits. | Reporting about the Food Forest or volunteering there. An undated gallery image needs a file-photo caption; it does not prove attendance at a new event. | Confirm the particular photo's reuse scope and credit with the organization/photographer. |
| Beacon Hill: [Beacon Business Alliance team](https://www.beaconbusinessalliance.org/index.php/the-team/) | Named staff photographs, including the portrait labeled Jenny Ap on the source page. | A profile or story actually involving that person or organization. | The site states all rights reserved. Request the approved image and credit; do not use staff portraits as generic residents. |
| Beacon Hill: [El Centro media page](https://www.elcentrodelaraza.org/contact-us/media/) | An official [media toolkit](https://drive.google.com/drive/folders/1oJyXzI8XYS7PQyKrSigqw7bXt-XzA4xp?usp=sharing) advertised as containing photos. Its [November 5 tour page](https://www.elcentrodelaraza.org/event/cafe-con-el-centro-de-la-raza-tour/2026-11-05/) has a building photograph with graphics and a visible photographer credit, rather than a people photo. | Toolkit photographs matched to an El Centro story, or the venue image for its tour. | Toolkit contents were not individually inspected. Obtain the suitable image, caption and permitted use from the communications contact on the official page. |
| Wedgwood / NE Seattle: [Wedgwood PTA leadership](https://www.wedgwoodpta.org/meet-the-pta) | Real leadership/family photographs. The inspected vice-president entry uses a family group photo including children. | A relevant PTA profile or community story using an explicitly approved image. | Ask for an editorial photo with a clear credit and appropriate publication permission; prefer a supplied adult portrait over automatically copying a family photograph. |
| Ballard: [Ballard Alliance community events](https://ballardalliance.com/programs/community-events/) | The Wine Walk image is an actual photograph of people gathered in a venue. The page also has event imagery for ArtWalk and other programs. | Coverage of that program; identify an older image as a file photo when its capture date is unknown. | Confirm photographer, date and reuse scope. A historical promotional image is not evidence from this week's event. |
| Moses Lake: [city Quarterly, Fall 2026](https://www.cityofml.com/DocumentCenter/View/13810/Moses-Lake-Quarterly---Fall-2026?bidId=), page 4 | A photograph of students doing a Stratford Road / Neppel Park cleanup. The accompanying report dates the cleanup to July 17. | A community-service feature or explicitly dated retrospective, not a new November cleanup report. | Ask the city for the original image, credit and approved reuse. PDF images are not currently extracted by the story-image pipeline. |

The [Moses Lake athletics calendar](https://www.gomlmavericks.com/calendar) illustrates
an important distinction: its visible schedule images are opponent/team logos, not
action photographs. A calendar integration alone will not supply people photos. The
[Columbia Basin Herald local section](https://columbiabasinherald.com/news/local-news/)
is a possible publisher relationship for local reporting, but an individual article's
photographs and reuse terms were not verified in this pass.

## Why Beacon Hill currently looks different

The published run `7bfb4eb4-36ea-432b-8acb-2f1260f2f3a0` collected 28 sources. Its source
list did not include El Centro de la Raza, Beacon Food Forest or Beacon Business Alliance.
The published edition contained three incident reports, two permit items and a library
event. The only image URL attached to those six items was a library logo.

Source photographs elsewhere in the neighborhood cannot simply be assigned to those
incident reports or property records. The next collection should include the relevant
community organizations and their dated stories/events. Photo availability is useful
for choosing a visual lead among otherwise relevant stories; it should not substitute
for locality, freshness or editorial importance.

## How this scales to other communities

1. Add photo-bearing sources alongside structured records: community organizations,
   chambers/business associations, volunteer groups, venues and original local reporting.
2. Request a small approved photo supply from each participating organization: event
   photos, staff/organizer portraits and place photos with captions, dates, credits and
   permitted uses. No outreach was sent during this research.
3. Match story-specific photos by original article/event, named subject, venue and date.
   Keep venue, organization and historical file photos explicitly classified and captioned.
4. Use a curated community photo library for genuinely contextual images. Store source,
   photographer, capture date, community/venue, permitted use and approval status once;
   reuse that record instead of making a new image-search/model call for every story.
5. Reject logos, pixels, unrelated people and artwork when selecting a photograph.
   Preserve event flyers as artwork with their original context; do not mistake them for
   documentary photos. Keep incident and permit briefs compact when no suitable image exists.

For a wider supply, the spreadsheet's [Stacker publisher offering](https://stacker.com/publishers)
advertises packaged stories with images and location/topic filtering. Its publisher
agreement and each item's conditions need review; it does not guarantee neighborhood
photography. [News From The States](https://www.newsfromthestates.com/republishing-guidelines)
allows outlet-credited photos to accompany the stories where they originally appeared;
that is not a general photo library for independently rewritten local stories.

## Is stock necessary?

**No, not as a default requirement.** The checked sources demonstrate that all four
communities have local people-photo opportunities. They do not establish enough approved,
fresh photos for every weekly story. A practical initial target is one or two genuine,
relevant local photos per edition, with text briefs for the rest, and then measure coverage
across several editions before adding a stock service.

Use stock only as an optional, labeled illustrative image for general topics such as
gardening or seasonal preparation. It cannot document a neighborhood event, identify an
incident participant, or stand in for a particular deceased person or property. For
place-based context, a real photograph of the actual venue/neighborhood is preferable.
[Wikimedia Commons](https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia)
can supply such images after checking the individual file's license and attribution.

If adopting [Unsplash](https://unsplash.com/license), distinguish manually selected images
from an [API integration](https://unsplash.com/documentation): the API has its own hotlink,
attribution and download-tracking requirements. Do not automatically route API images
through Newsbee's existing caching proxy without reconciling that provider contract.

## Recommended next step

Start with Beacon Food Forest and El Centro for Beacon Hill, Ballard Alliance for Ballard,
an approved PTA/community photo supply for Wedgwood, and the city communications team
for Moses Lake. Record image approvals and captions, enable the corresponding story/event
sources, then test a fresh collection. This research has not changed the spreadsheet,
enabled sources, inserted images into editions, or published any photos.

A later implementation added four separately licensed historical [community cover
photos](community-cover-photos.md), including real gatherings in Beacon Hill and Ballard.
Those file-specific approvals do not clear the organizer/publisher images sampled above.
