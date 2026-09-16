# Production Backup and Rollback Strategy (Phase 11)

## Backup strategy (Task 19) - based on what actually persists today

| Data | Persists where | Backup implication |
|---|---|---|
| Chat history/conversations | Browser `localStorage` only (`www/chatStore.js`), per-device, per-guest/user namespace | **No server-side backup exists or is needed** - this app never receives or stores this data server-side at all. The user's own **Export** feature (`www/history-ui.js`, unchanged since Phase 3) remains the only backup mechanism for a user's own history - a real, working, already-tested feature, not a gap. |
| Auth identity | Firebase (Google's own infrastructure) | Backed up by Google as part of Firebase itself - outside this project's scope entirely. |
| Rate-limit counters | In-process memory, or (if activated) a shared Redis-compatible store | Ephemeral by design - losing them on restart just resets everyone's budget to zero, never a data-loss concern. |
| Logs | stdout only | Not this application's responsibility to retain - whatever captures stdout in production (container runtime, `journald`, a log shipper) owns retention/backup of logs, per `docs/production-logging.md`. |
| Server source code / configuration | This git-less-in-this-session repository | Standard source control backup practices apply (this project has no git remote configured in this environment - see `docs/deployment-preflight-checklist.md`). |
| A future PostgreSQL database | **Not implemented** (`docs/production-environment.md`, Task 11) | See "If PostgreSQL is added later" below. |

**Bottom line: this application currently has no server-side user data to
back up.** This is a direct, honest consequence of the LocalStorage-only
architecture (unchanged since Phase 1), not an oversight this phase
introduces or fixes.

### Environment/secrets backup

`.env` (and any real service-account JSON / `google-services.json`) must
never be committed to version control (already enforced by `.gitignore`
since Phase 8/10) and must be backed up, if at all, through a **secrets
manager** appropriate to the deployment platform (e.g. a cloud provider's
own secrets store, or an encrypted vault) - **never** as a plain file
backup alongside application code. This project does not implement or
recommend a specific secrets manager (deployment-platform-dependent,
outside this phase's scope) - only states the requirement plainly.

### If PostgreSQL is added later (not implemented this phase)

A real implementation would need: scheduled `pg_dump`/continuous WAL
archiving appropriate to the hosting platform, a defined retention period
(e.g. 30 daily + 12 monthly, a decision for whoever operates the real
database), periodic **restore testing** (an untested backup is not a
backup - only a hope), encryption at rest for the backup artifacts
themselves, and access control restricting who can read or restore a
backup (should not be the same credential the application itself uses
day-to-day). None of this is built now, matching
`docs/production-environment.md`'s Task 11 conclusion that no database
layer exists to back up yet.

## Rollback strategy (Task 20)

### What "rollback" means for this application today

Because there is no database migration involved (LocalStorage-only,
Firebase-managed auth), a rollback of this application is unusually
simple compared to most production web apps: **redeploy the previous
backend artifact and the previous frontend files.** There is no
migration-compatibility matrix to reason about, because there are no
migrations.

### Practical rollback plan

1. **Previous backend artifact**: keep the previous deployment's build
   (container image tag, or a tagged release of `server.js` +
   `lib/`/`middleware/`/`www/`) available and immediately deployable -
   whatever the actual deployment mechanism is (container registry,
   platform release history, etc. - specific to the real hosting
   decision, not made here).
2. **Previous frontend artifact**: `www/` is served by the same Express
   process as the backend (`app.use(express.static(...))`) in this
   project's current architecture - rolling back the backend
   automatically rolls back the frontend it serves, with **one caveat**:
   a signed-in user's browser may have `www/config.js`/`www/auth.js`
   already cached (see `docs/production-environment.md`'s static-asset
   `max-age=300` policy) - a rollback's effects on already-loaded clients
   complete within 5 minutes at most, by design.
3. **Environment compatibility**: check whether the rolled-back version's
   expected environment variables are a subset of (or identical to) what's
   currently configured - `lib/env.js`'s own validation makes this check
   itself trivial: start the old version against the current `.env` and
   see whether `validateEnv()` reports any error. A rollback should never
   need `.env` changes if the new version only ever *added* optional
   variables (the pattern this project has followed every phase so far -
   e.g. `RATE_LIMIT_STORE_URL`, `TRUST_PROXY` are all-optional additions).
4. **Database migration compatibility / rollback policy**: **N/A today**
   - no migrations exist. If a future phase adds PostgreSQL with real
   migrations, the standard rule applies and should be documented then:
   every migration should have a tested `down` script, and a rollback to
   a version expecting an older schema should never be performed without
   first confirming the migration that changed it is safely reversible -
   *"no destructive migration without a verified-restorable backup taken
   immediately before it runs"* is the concrete rule to adopt once
   migrations exist, stated here in advance so it isn't improvised later
   under pressure.
5. **Runtime config rollback**: covered by step 3 - this project's
   `lib/env.js` validation is itself the safety net (a bad rollback
   combination fails loudly at startup rather than serving broken
   requests).
6. **Health verification after rollback**: the rolled-back version must
   pass `GET /ready` (200) before it's considered successfully rolled
   back, and `GET /live` continuously afterward - exactly the same
   signals a fresh deploy would be judged by
   (`docs/production-healthchecks.md`).

### Rollback trigger conditions

- `/ready` reporting `not_ready` (503) for longer than a defined grace
  period after a deploy.
- A sustained high 5xx rate immediately following a deploy (see
  `docs/production-monitoring.md`'s alerting recommendations).
- A confirmed regression in guest-mode chat (this app's single most
  critical path, unaffected by auth/Android/DB status) discovered
  post-deploy.
- Any discovery that a deploy accidentally shipped a secret (re-run
  `node e2e/secret-scan.js` against the deployed artifact as part of any
  incident response - the same script this project has used every phase
  since Phase 9).

### What this plan deliberately does not include

An actual rollback was not performed or rehearsed this phase (this phase
explicitly forbids deployment of any kind) - this is a plan for a real
incident, not a demonstrated drill. A future phase focused on real
deployment should include a genuine rollback rehearsal against a real
staging environment before this plan is trusted for a real production
incident.
