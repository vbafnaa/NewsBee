# Animated community portraits

The reader uses original neighborhood watercolor artwork with local motion and
pointer, touch and keyboard interactions. Wedgwood's canopy, leaves and café
warmth respond to a breeze; Moses Lake has rippling water and a small paddling
kayak. Clicking the street neighbors triggers a high-five, clicking the café
reveals a conversation, and clicking the shore boat sends it onto the lake.
Buildings and authored news remain still.

`CommunityScene.astro` renders a responsive still image first. Its browser controller
enhances that painting with a small WebGL shader and decorative SVG layers. The
shader reads normalized regions from `shared/neighborhood-illustrations.ts`; it
does not generate new imagery or fetch third-party animation services.

## Reader behavior

- Neighborhood welcomes fill the page width and most of the opening viewport.
  Community-specific sky and warm washes blend the painting into the page;
  welcome text remains above the artwork. The artwork collection keeps its
  compact layout.
- Welcomes show only the community greeting. The shared template omits the
  eyebrow, subtitle, visible pause control and interaction instructions for
  existing and future community editions.
- Move or click in Wedgwood to stir the canopy and release leaves. Move across or
  tap Moses Lake's water to create ripples. The focused painting also accepts
  Enter/Space for the local effect and Escape to pause.
- Scene objects use transparent, labelled click targets. Keyboard readers can tab
  to an object and press Enter/Space. Fully cropped targets are removed from tab
  navigation. Touch scrolling remains available.
- A high-five lasts 4.2 seconds; café patrons fade in, gesture and fade out over
  8.2 seconds. The shore boat takes a 24-second trip and returns to the bank.
  Repeated clicks during the same gesture do not create additional animations.
- Pause freezes the painting, boat, decorative layers and temporary effects,
  including during a resize. Animation resumes from its previous position.
- Reduced-motion readers, JavaScript-disabled browsers and unsupported graphics
  contexts receive the still image. Context loss also restores the still image
  and removes unavailable keyboard actions and their instructions.
- Animation stops outside the viewport and while the document is hidden.
- Rendering is capped at 24 frames per second and a 2160-pixel canvas width.
- Temporary interaction effects are capped and removed when their animation ends.
- Mobile crops use the same focal point for the image, texture and decorative layers.
- Animation appears in illustrated neighborhood welcomes and the artwork collection.
  Photo-mode editions retain their current presentation.

## Adding a community

1. Review an original 2172 × 724 neighborhood portrait and add its full and 960 × 320 WebP
   variants under `apps/reader-site/public/illustrations/`. Record its generation
   provenance in `Docs/illustration-art-direction.json`.
2. Add a profile to `NEIGHBORHOOD_ART`: location IDs, name, art-direction copy,
   alternative text, asset name and palette. Locations without a profile do not
   inherit another community's identity.
3. Add `presentation` to tune the immersive welcome: `sky` and `glow` are CSS
   colors, and `focalPoint` selects the crop for tall screens. Check that the
   community's defining features and interaction origin remain visible. The
   full-resolution image is used for this enlarged presentation.
4. Optionally add `motion`: a compact-layout focal point and up to six regions per effect.
   Regions are `[centerX, centerY, radiusX, radiusY]` in normalized image coordinates.
   `breeze`, `water` and `warmth` reuse the same renderer. `energy` adjusts motion
   intensity within the renderer's limits. Birds, leaves, steam and boats are
   optional decorations. `interaction` selects a breeze or water response and a
   reviewed origin for keyboard gestures. Keep boat paths and ripple origins on
   the water. A profile without motion remains a still portrait.
5. Optionally add `cast` with a reviewed background plate, original-artwork
   cutout paths, joints and finite action timelines. Profiles in
   `shared/community-casts.ts` define the current examples. Parent actors let
   hands move with their bodies; `restOpacity` supports reveal-on-click figures.
   Keep static portraits unchanged for fallback views and record generated
   plates in `Docs/community-scene-assets.json`.
6. Review desktop, mobile, paused, reduced-motion and graphics-fallback views.
   Check contact poses, shoreline placement, cropped targets and repeated clicks.
   Use character motion only for the authored community illustration, never
   to animate a reported person's photograph or depict an unverified news event.

No per-edition generation, vision calls, new source-discovery rules or paid
services are introduced by community animation.

This is a reader presentation feature. Account and server-key access, source-run
behavior, editorial checks, pipeline recovery and publishing remain governed by
the current application code. Animation never requires a credential fallback.
