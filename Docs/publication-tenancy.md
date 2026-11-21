# Publication tenancy foundation

Newsbee treats each existing publishing channel (`output_channels`) as a publication. This is a
compatibility decision: channel IDs, reader feeds, Drive folders, selected locations, and current
URLs remain unchanged instead of introducing a second competing publication entity.

- `owner_id` identifies the publication owner and remains readable for legacy data.
- `members` contains explicit publication members. The owner is implicitly a member.
- Private child records use `publication_id` as their authoritative tenant scope.
- Server code must resolve a `PublicationContext` before reading or writing publication-owned data;
  a channel/publication ID supplied by a client is never authorization by itself.
- Existing `output_channel_editions` rows are lazily and additively assigned `publication_id` after
  the first authorized publication access. A scope-version marker avoids repeating migration writes;
  a constrained legacy owner/channel fallback remains for rolling-deploy safety, and no destructive
  migration is required.
- `selected_location_ids` is intentionally nonunique. Multiple publications may cover the same
  shared location, while their notes, drafts, editions, branding, and subscriber data remain scoped
  by `publication_id`.
- Every deliberately assigned journalist can generate, review, approve (including self-approval),
  explicitly publish, correct and withdraw in that publication. Approval never silently publishes.
  Run retry/resume/cancel recovery remains a separate Editorial integration; global run-control and
  operator routes are not opened to journalists.
- Global workspace owners and admins retain broad read inspection. Journalists never receive
  global inspection or operator access from a publication assignment.
- Privileged inspection uses `resolvePrivilegedPublicationContext`, requires a reason, and appends a
  hash-protected event to `publication_access_audit`. An inspection context cannot authorize a write.
- Unassigned operator writes require deliberate, publication-bound support entered at
  `/admin/publication-governance`. Support records the operator's reason, entry, explicit exit and
  expiry (30 minutes); expiry is also recorded when the expired grant is next inspected or used.
  Services revalidate the persisted grant and current enabled operator before each elevated write,
  append per-write evidence, and reject forged, read-only, exited or expired contexts. Fixed button
  labels and a global owner/support badge are not authorization.
- Archiving/restoring a newsroom is explicit global Admin/Owner management, not an editorial
  support grant. `/admin/publications` confirms the operation; the service rechecks the persisted
  enabled actor and lifecycle revision transactionally, blocks active generation (including paused
  work), video/uploads, approved/publishing releases and manifest claims, and audits each change.
  DELETE archives without deleting published editions, artifacts, manifests, pointers or assignments.
  Archive stores epoch-second `archived_at`, stable `archived_by` and `archived_was_enabled`, and
  disables future publication. Restore removes archive fields and preserves the prior enabled state.
  Safe directory/channel projections include `archivedAt` and `lifecycleRevision`. Archived settings
  cannot be used to bypass restoration. Archive alone must never expose previously disabled history:
  Reader visibility requires either enabled status or finite numeric archival plus
  `archived_was_enabled=true`, as well as the existing valid-public-pointer and release-state checks.
- The same governance page provides workspace-owner-only ownership transfer and a bounded audit
  view/API (`GET /api/admin/audit`). Its cursor/filter projection combines historical account-access,
  publication-access and publication-change records without reading current identities or logging
  recursive publication-list inspection. Audit timestamps are milliseconds. Hash verification is
  per entry only, not a global chain or proof that history is complete.
- Restore evidence is a separate, read-only newest-20 projection of Restore07's shared
  `readRestoreEvidence` reader. Application code never opens its reserved evidence/state collections;
  the owner-authorized projection also strips nested fields not in the public evidence contract.
  BSON/ISO timestamps are normalized independently;
  it neither participates in the account/publication cursor nor claims an actual restore succeeded.
  No archive, credential, invitation, provider configuration or raw account snapshots are exposed.
- Publication video submission and upload starts atomically increment the publication lifecycle
  revision and insert their active job/upload record. Transfer checks those same records. Upload
  finalization commits an `uploading` job before external storage begins; provider and storage
  calls never run inside the Mongo transaction. A failed active-record insertion rolls back the fence.

Use the helpers in `pipeline/publications/access.ts`, `permissions.ts`, and `audit.ts` for future
publication-owned collections.

## Newsroom entry and creation

`/newsroom` is the canonical chooser for approved signed-in roles. Only global Admins and Owners
can create newsrooms; journalists need an explicit assignment and cannot self-create one.
Operators can switch between Operations and Newsrooms. Direct access is distinct from read-only inspection; directory discovery neither grants
membership nor logs unopened rows as inspected. Opening private workspace/settings data still
resolves and audits actual privileged reads. Admin normal Open goes to the same edition workspace.
Historical location/per-story publishers remain under Advanced legacy maintenance with their
existing URLs and history.

`GET /api/admin/output-channels` returns a minimal `directory`; full `channels` settings are returned
only for an authorized `?channelId=...` read, with `accessMode`, `canWrite`, and `supportExpiresAt`.
Channel controls disable inspection writes and expired support without treating the UI as authority;
mutation routes recheck persisted access. Publishing destinations are secondary to coverage setup.
Unavailable known communities stay visible with canonical readiness reasons and cannot be selected.

`POST /api/admin/output-channels` requires a stable 16–128-character `requestKey`. Creation stores
an actor/key identity and normalized payload fingerprint in `output_channel_creations` before
provisioning. Same-key/same-payload retries return the same newsroom; changed details conflict.
An in-progress claim returns an explicit 409; a crashed claim can be resumed after its two-minute
lease. Folder identity is persisted before side effects: local and Mongo destinations are
deterministic, while connected Drive reserves an ID and creates that exact folder directly under
the configured pipeline root. This avoids duplicate folders after overlapping or lost-response
attempts. Drive authorization/reservation failures use the existing Mongo fallback; once a Drive
identity is reserved, provisioning failures require retry rather than silently switching stores.

Folder provisioning must succeed before the channel, creation completion and single creation
audit commit together. Creation never initializes or rewrites `locations.json`: canonical publication
reads use release pointers/manifests, and existing publish/settings materializers create the directory
when needed. A stale provisioning attempt therefore cannot reset a later published directory or
duplicate a Drive file by name. Real account writes serialize creation quota checks and account suspension.
An empty initial community selection creates a newsroom awaiting coverage setup, not an edition-ready
or published workspace. The browser keeps an unconfirmed request and its details in tab-scoped session
storage across reloads, retries exactly that request, and refreshes directory/cards/selector after
confirmation. No provider generation, publication, email, scheduling or membership grant occurs.
