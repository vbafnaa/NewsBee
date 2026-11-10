# Event venue photo review

Updated November 2, 2026. Current editorial rule: no context photographs for Census,
police, dispatch or similar sensitive records. Permit stories may use a recent licensed
photo of the actual named street and city, labeled through its credit and photo details.
Events may use a recent licensed photo of their actual venue. Missing photos render text-only; historical neighborhood covers and
illustration placeholders are removed from the reader.

| Published event | Primary venue photo decision |
| --- | --- |
| Roots of Joy Earth Circle at Carkeek Park | Approved: [view from Carkeek Park, photographed November 30, 2025](https://commons.wikimedia.org/wiki/File:Olympic_Mountains_from_Carkeek_Park_2025-11-30.jpg), Joe Mabel, [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). This shows the park's waterfront view, not the lower meadow or the event itself. |
| Game on! Board Games for All Ages, Ballard Branch | Text-only: no recent licensed photo of the actual current branch was verified. Historic Carnegie Library images show a different building and are unsuitable. |
| OSG: Spiritual Offerings, Kadampa Center | Text-only: reviewed Commons exterior/interior files were photographed September 17, 2007 and are excluded. Organizer-photo reuse permission and capture dates have not been established. |

The parish profile, parish survey and RV editorial also remain without photos where
actual source-photo reuse permission has not been established. No unrelated portrait,
generic church or stock image is attached to these stories.

The approved park asset is recorded in `shared/event-venue-photos.json`. Selection
requires an exact community/source-page match and an event or meeting-preview kind;
it is not a keyword/category fallback. Photos expire 365 days after their capture date.
The reader preserves original publisher photos ahead of this optional venue fallback.
The normal bounded image-delivery endpoint serves the selected image, with no incoming
arbitrary URL. Captions carry the photographer, source, capture date, license link and
cropping disclosure, and distinguish location context from event coverage.

New editions also run the automatic [image pipeline](image-pipeline.md) before the
publication checkpoint. When no reviewed venue asset exists, the job queries the
official Commons API and checks explicit venue/city identity, license, capture date
and actual raster dimensions. It persists its selected image or no-image decision
with the draft. The small allowlist remains a curated provider and a compatibility
fallback for these already-published editions; it is not the entire image pipeline.

The park photo was downloaded, visually inspected and delivered as HTTP 200/image/jpeg.
Browser checks verified all four editions without covers/illustrations, no context
photos on the record editions, the event photo's credit and expandable date/license, and mobile layout.
