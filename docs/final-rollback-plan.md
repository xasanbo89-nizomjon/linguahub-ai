# Final Rollback Plan (Phase 12)

Consolidates and finalizes `docs/production-backup-and-rollback.md`
(Phase 11), re-verified accurate this phase. No destructive rollback was
performed or rehearsed against real infrastructure - this is a
documentation-level rehearsal, per this phase's explicit rules.

## Why rollback is unusually simple for this application

There is no database and no migration to reason about (LocalStorage-only
persistence, Firebase-managed auth - unchanged through all 12 phases).
Rolling back this application means exactly one thing: **redeploy the
previous backend artifact.** The frontend (`www/`) is served by the same
process, so it rolls back automatically with the backend.

## Step-by-step rollback procedure

1. **Identify the current (bad) artifact**: whatever build/version is
   currently live - identified by its `package.json` `version` (as of
   this RC, `1.0.0-rc.1`) or the deployment platform's own release
   identifier (container image tag, platform release ID - mechanism
   depends on the real hosting decision, not made in this project).
2. **Identify the previous (known-good) artifact**: the last version that
   passed its own full regression baseline (402/402 unit,10/10 e2e
   suites) - every phase's own `docs/phase-0N-*.md` records this baseline
   at the time, so the previous artifact's health is independently
   verifiable from its own phase documentation, not just trusted.
3. **Check environment compatibility**: start the previous version
   against the *current* `.env`/environment variables and confirm
   `lib/env.js`'s `validateEnv()` reports no error - this project's own
   env validation is the compatibility check. Every phase through 12 has
   only ever *added* optional variables, never removed or renamed one, so
   a rollback should never require reverting `.env` itself.
4. **Config rollback**: implied by step 3 - if the previous version
   doesn't recognize a newer variable, it simply ignores it (Node reads
   only what it asks for from `process.env`); no explicit config-file
   rollback step is needed.
5. **Database rollback implications**: **none exist** - there is no
   database. If a future phase adds PostgreSQL with real migrations, this
   section must be revisited before that phase ships - the rule to adopt
   then, stated here in advance: no destructive migration without a
   verified-restorable backup taken immediately before it runs, and every
   migration should have a tested `down` script before it's trusted for a
   production rollback.
6. **Deploy the previous artifact** using whatever mechanism the real
   platform provides (not decided in this project).
7. **Health verification after rollback**: the rolled-back version must
   return `200` from `GET /ready` before being considered successfully
   rolled back, and `GET /live` continuously afterward - re-verified this
   phase to still behave exactly this way.

## Rollback trigger conditions

- `/ready` reporting `not_ready` (503) beyond a defined grace period after
  a deploy.
- A sustained high 5xx rate immediately following a deploy.
- A confirmed regression in guest-mode chat (this app's single most
  critical, always-on path).
- Discovery that a deploy shipped a secret - re-run `node
  e2e/secret-scan.js` against the deployed artifact immediately as part
  of incident response (the same script used every phase since Phase 9,
  re-run again this phase with 0 real secrets found).

## What was and wasn't rehearsed this phase

**Rehearsed (real, direct verification)**: environment-compatibility
checking via `lib/env.js` (re-run live this phase with both valid and
invalid configurations), health-check-based rollback verification
(`/ready` re-confirmed live).

**Not rehearsed (no real infrastructure exists to rehearse against)**:
an actual artifact-swap against a real deployment platform, a real
previous-vs-current version comparison in a real registry, and a timed
rollback drill. These require real production infrastructure this
project has never provisioned, per every phase's standing no-deploy rule.
