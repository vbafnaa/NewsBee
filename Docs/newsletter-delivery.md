# Newsletter delivery

## Current availability

Email delivery has not launched. No production provider, transactional mail, email
preview, fake sending, campaign creation, retry, or confirmation activation is
available through the Reader or Journalist applications. Configuring credentials
does not enable these controls.

Edition finishing uses the same shared product boundary. It still generates the
website front page, but skips email-purpose inference, preview rendering and new
HTML/text preview artifacts (including their folder creation). New drafts and
edition summaries explicitly record `email_output.status: "unavailable"` and a
reason; generated `email` is null, and new drafts' `email_preview` is null, not a
successful empty email.
Standalone and combined-location children share this contract. A finish retry
after artifact persistence failure reuses the built web edition without repeating
front-page or email work. Recovery of a historical built draft preserves its
stored preview for historical reads but reports email unavailable and never
recreates preview artifacts while the product is disabled.

The Reader publication signup endpoint returns **503 before database access**.
It does not create pending subscriptions, consent, confirmation requests, or mail.
Publication newsletter pages explain this and collect no replacement waitlist.
Existing signed confirmation POSTs also return 503 without turning pending records
active. Signed preference and unsubscribe links remain usable; changing preferences
does not activate or re-subscribe an inactive subscription.

The Journalist publication email POST blocks every action, including preview,
send_test, send_release, continue, retry_unknown, and fake_event, before campaign,
delivery, outbox, suppression, or campaign audit writes. GET retains historical
campaign state. Journalist newsletter dispatch and the authenticated
`/reader/api/newsletter/dispatch` endpoint return explicit 503 unavailable responses.
Unauthenticated dispatch is rejected before database access. Disabled UI controls
have visible explanations rather than relying on hover text.

Delivery is manual-only if launched in the future. No automatic schedule is
configured or recommended. Provider implementation and activation require a
separate approved change; the underlying delivery libraries and isolated unit-test
fixtures are not an application rollout mechanism.

## Working capture remains separate

Community/location preference capture at
`/reader/subscribe?location=<location-id>` remains working through `SignupForm.astro`
and `/reader/api/locations/<location-id>/interest`. It saves community interest,
optional topics, and explicit consent for future editions without requesting or
promising confirmation mail. Public repeat requests preserve an active reader's
existing confirmed choices. No pending record becomes active through this flow.

Marketing `/reader/campaign/*` forms and `/reader/api/campaign-signups` remain
working lead capture, not email campaigns. They write `campaign_signups` and never
send mail or create publication subscriptions.

## Historical audiences and management

Community (`reader_newsletter_*`) and publication (`publication_email_*`) audiences
remain separate. Existing consent, suppression, subscriptions, receipts, and
historical campaign results are preserved, not silently migrated or activated.
Historical publication content and delivery outcomes remain readable. Mail
previews are not returned by the newsletter status endpoint.

Signed management links use the existing signing secrets and canonical Reader
URLs; keep those settings when maintaining historical access. Management pages
disable indexing and analytics, use private/no-store caching and no-referrer,
and require same-origin POST for browser changes. GET does not change consent.
Signed one-click unsubscribe remains available without a browser origin.

Publication navigation keeps its publication and exact release in story,
signup-return, and contribution links. Multi-community contributions require a
deliberate choice from the release's covered communities; external return URLs
are not accepted. Global discovery is explicitly labeled.

## Focused verification

Reader and Journalist route cases verify unavailable actions before writes,
preserved historical consent and subscription status, signed management,
working community and marketing capture, and two-community contribution choices.
Run the relevant Vitest route/navigation cases from `apps/journalist-site`
and `npm run check` from `apps/reader-site`. Full builds and the broader
persona/device matrix belong to final integration acceptance.
