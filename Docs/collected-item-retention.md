# Collected-item retention: deletion is disabled

`created_at` remains numeric epoch seconds, including historical reads. New source
and follow-link collection writes also store `retention_expires_at` as a BSON Date,
90 days after creation. This is a **proposed** expiration, not permission to delete.

Application initialization provisions the ordinary, non-TTL
`collected_item_retention_inventory` index. It does not create, convert or drop a
TTL index, backfill history, enable an expiry worker, or delete historical items.
The old numeric `created_at` TTL declaration is no longer provisioned. Any existing
index remains untouched; inventory its options and field types before rollout.
In particular, unexpected historical BSON Dates under that old TTL require an
operator decision, not an automatic drop or conversion during startup.

## Read-only inventory and dry run

`pipeline/editions/retention.ts` exports `dryRunCollectedItemRetention(db, options)`.
It reads only the needed identifiers and timestamps, in stable `_id` order,
at most 500 rows per call. Continue with `afterId: result.nextAfterId`, preserving
the same `asOf` and reviewed reference snapshot. It issues no writes. Reports use
identifiers, not source bodies or private notes.

Without a completed reference review, every otherwise eligible row is
`blocked/reference_review_incomplete`. A supplied reviewed set of retained item,
run or story IDs yields `retain/retained_reference`. Only reviewed, unreferenced
rows produce `propose_backfill`; already-correct dates are `unchanged`, and invalid
timestamps or conflicting stored expiry values block. Overdue rows are explicitly
marked, not automatically approved. Repeating the inventory is idempotent.

The `complete` flag is an assertion by the authorized caller, not an automated
proof that all references have been discovered. This helper is not a migration
command and cannot authorize deletion.

## Separate, explicitly approved migration design

1. With authorized read-only access, inventory collection size, existing indexes,
   timestamp types, eligible counts/bytes, overdue age buckets and reference
   coverage. Verify backups and an isolated restore before proposing changes.
2. Review all retained references: publication draft `stories[].references`
   (including collected item, run and story IDs), immutable releases/snapshots,
   legacy editions, original reporting, correction/withdrawal history, evidence,
   inspectors, audits and restore exports. Keep every unresolved reference.
   Record the review version/cutoff and the inventory hash. **This review has not
   been completed against deployment data; the rollout gate remains open.**
3. During an approved restore/maintenance window, fence writers and freeze the
   reviewed reference snapshot. Run the bounded dry run again. A future separate
   migration can compare-and-set only missing expiry fields using `_id` plus the
   original numeric `created_at`; checkpoint each acknowledged batch and stop on
   conflicts. Re-execution must skip equal values and never rewrite dates.
   Backfill alone must still leave deletion disabled.
4. Design and review a separate explicit eligibility marker and partial BSON-Date
   TTL index (for example, only `retention_ttl_approved: true`). Neither marker nor
   TTL is installed by this change. New rows must not automatically receive that
   marker. References created after review must revoke eligibility atomically;
   if that invariant cannot be proved, retain the evidence and do not enable TTL.
   Never convert the broad inventory index into an unrestricted TTL.
5. Test in isolated Mongo with representative retained provenance, old rows,
   mixed types, interrupted/repeated batches, concurrent references, maintenance
   fencing and a verified restore. When eventually enabled, TTL cleanup is
   asynchronous: observe eligibility/eventual deletion, not exact-second timing.
6. Require explicit approval of counts, backups, audit results and maintenance
   window before any live backfill or deletion. Rollback must disable deletion
   eligibility before changing code; deleted evidence needs restoration, not a
   code rollback.

## Verification and still-open acceptance

Focused tests cover Date computation, unchanged numeric timestamps, a real Mongo
round-trip through follow-link writes, absence of a newly enabled TTL, bounded
read-only/restartable dry runs, retained item/run/story references, incomplete
review and invalid/conflicting dates. Historical rows are not auto-enrolled.

Live inventory, complete retained-reference review, backup/restore proof, a
production migration/approval implementation and isolated **enabled-TTL eventual
expiry** tests remain open. No live migration or deletion has been performed.
