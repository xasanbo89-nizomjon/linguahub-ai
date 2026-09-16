# Phase 11: Production Deployment Preparation, Infrastructure Hardening

This phase's mandate: prepare LinguaHub AI for a safe production
deployment **without deploying it** - hardening real code where a real
gap existed, and documenting precisely everything that remains
infrastructure-dependent (a real domain, a real reverse proxy, a real
multi-instance deployment) rather than faking any of it.

## Task 1: Audit - findings

Read in full before any change: `server.js`, `www/config.js`,
`.env.example`, `middleware/auth.js`, `lib/firebaseAdmin.js`,
`lib/aiModes.js`, `www/chatStore.js`, `package.json`, and every Phase
9/10 doc. No Docker/Nginx/PM2/PostgreSQL files existed anywhere in the
repository before this phase.

1. **Web production readiness**: mostly present already (CSP/Helmet/CORS
   all correctly configured since Phase 4), but env validation, request
   IDs, structured logging, and multi-tier rate limiting were all absent.
2. **Backend production readiness**: `server.js` had a single-process-only
   rate limiter with no cleanup timer (a real, confirmed memory leak under
   sustained traffic), no graceful shutdown at all (`app.listen()` with no
   signal handling), and no `/live`/`/ready` distinction (only `/health`).
3. **Frontend production readiness**: `www/config.js`'s URL resolution was
   already correct for the common cases (Phase 9/10 work), but had no
   validation for a malformed override value.
4. **Auth production blocker**: unchanged - still BLOCKED on a real
   Firebase project (Phase 7-10's finding, re-confirmed, not re-litigated
   this phase).
5. **Storage/persistence**: unchanged - LocalStorage-only, no database.
6. **Rate-limit scaling**: real gap - single in-memory Map, no cross-
   instance sharing, no periodic cleanup.
7. **Logging**: real gap - bare `console.error(error)` calls, no
   structure, no levels, no redaction, no request correlation.
8. **Monitoring**: no contract existed at all.
9. **HTTPS/domain**: no documentation existed for reverse-proxy
   expectations or SSE-specific proxy requirements.
10. **Process management**: undocumented.
11. **Backup/rollback**: undocumented.
12. **Files requiring changes**: `server.js` (substantial), `www/config.js`
    (validation addition), five new `lib/` modules, `package.json`
    (unchanged - no new runtime dependency added), `.env.example`,
    `README.md`, `docs/release-readiness-checklist.md`.
13. **Regression risk**: `server.js` is the highest-risk file in this
    project (every route flows through it) - mitigated by running the
    full existing test suite after every substantive change and adding
    new tests before considering any new behavior done.
14. **Implementation plan**: extract each concern into its own testable
    `lib/` module (matching this project's established pattern from
    Phase 9/10's `lib/firebaseAdmin.js`/native-auth-adapter work), wire
    them into `server.js` minimally, verify with real requests after every
    change, document what's real vs. contract-only precisely.

## Tasks 2-12: implementation summary

Each has its own dedicated document - this section is a pointer, not a
duplicate:

| Task | Document |
|---|---|
| 2. Environment validation | `docs/production-environment.md`, `lib/env.js` |
| 3. Frontend production API config | `www/config.js`, `tests/config.test.js` |
| 4. CORS production policy | `docs/production-network-and-cors.md` |
| 5. Trust proxy / client IP | same document |
| 6. Rate limiting | `docs/production-rate-limiting.md`, `lib/rateLimiter.js` |
| 7. Structured logging | `docs/production-logging.md`, `lib/logger.js` |
| 8. Request ID | `lib/requestId.js`, `tests/requestId.test.js` |
| 9. Health/liveness/readiness | `docs/production-healthchecks.md` |
| 10. Error handling hardening | this document, "Error handling" below |
| 11. Database readiness | `docs/production-environment.md`, "Database" section |
| 12. Graceful shutdown | `lib/gracefulShutdown.js`, `tests/gracefulShutdown.test.js` |

### Error handling hardening (Task 10) - what changed specifically

Every error response (validation 400s, the 404 handler, the centralized
error handler) now includes `requestId` for correlation - previously none
did. `console.error(err)` (which would print a full Node error object,
including its stack, to stdout) was replaced with structured
`logger.error(...)` calls that log only an error category and name, never
a stack trace or message content, in every path. Status codes were
unchanged (already correct since Phase 1) - this task was about
*sanitization and correlation*, not changing what triggers which status.
Verified: `tests/server-production.test.js`'s requestId-correlation tests,
plus the full pre-existing `tests/server.test.js` suite re-run clean.

## Tasks 13-16: network/proxy/security

| Task | Document |
|---|---|
| 13. Reverse proxy / HTTPS readiness | `docs/nginx-example.conf` |
| 14. SSE production proxy check | `docs/production-sse-proxy.md` |
| 15. Static asset production policy | `docs/production-environment.md`, static asset section |
| 16. Security headers finalization | `docs/production-security.md` |

## Tasks 17-20: monitoring, alerting, backup, rollback

| Task | Document |
|---|---|
| 17. Monitoring contract | `docs/production-monitoring.md` |
| 18. Alerting recommendations | same document |
| 19. Backup strategy | `docs/production-backup-and-rollback.md` |
| 20. Rollback strategy | same document |

## Tasks 21-22: Docker and process management

| Task | Document |
|---|---|
| 21. Docker readiness | `Dockerfile`, `.dockerignore` |
| 22. Process management | `docs/deployment-preflight-checklist.md` |

## Task 23: Production build simulation - real, executed this phase

Run directly, not simulated in description only:

```
$ NODE_ENV=production PORT=3000 OPENAI_API_KEY="sk-test-simulated-not-real-..." \
  FRONTEND_ORIGINS="https://app.example.com" TRUST_PROXY=1 LOG_LEVEL=info node server.js
{"level":"info","message":"server started",...,"nodeEnv":"production",...}
🚀 LinguaHub AI running on http://localhost:3000
```

| Check | Result |
|---|---|
| Server starts under `NODE_ENV=production` | ✅ real |
| Env validation runs and logs its summary (JSON, no secret values) | ✅ real |
| `/health`, `/live`, `/ready` all respond correctly | ✅ real (`ready:true`, `openaiKeyConfigured:true`) |
| CORS allows the configured production origin | ✅ real - `Access-Control-Allow-Origin: https://app.example.com` |
| CORS still allows local dev defaults (unaffected) | ✅ real |
| CORS rejects an unrecognized origin | ✅ real - 403 |
| Static `index.html` serves with `Cache-Control: no-cache` | ✅ real |
| Static `config.js` serves with `Cache-Control: public, max-age=300, must-revalidate` | ✅ real |
| SSE headers present on a real streamed request | ✅ real - `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `X-Accel-Buffering: no` |
| Logs are JSON and redacted, no secret output | ✅ real - `OPENAI_API_KEY` shows only `[REDACTED]` |
| No port leak after shutdown | ✅ real - verified via `netstat` after process termination |
| **Missing required production config refuses to start** | ✅ real - `OPENAI_API_KEY=""` + `FRONTEND_ORIGINS=""` under `NODE_ENV=production` → 2 logged errors, `process.exit(1)`, confirmed via `$?` |
| SPA fallback | N/A - this app is not a multi-route client-side SPA (a single `index.html`, no client router); Express's own default 404 for an unmapped path was confirmed to leak no stack trace |

## Task 24: Secret scan - real, executed this phase

```
$ node e2e/secret-scan.js
Total findings: 1703
```

| Category | Count | Disposition |
|---|---|---|
| Source maps | 1695 | Unchanged from Phase 9/10 - third-party library maps, not secrets |
| `.env` filename | 1 | Expected, unchanged |
| "Firebase private key block" | 3 | All false positives: `e2e/security.js` (Phase 9, self-referential regex), `docs/secret-scan-report.md` (Phase 10, quotes that same pattern in prose), and **new this phase**: `tests/env.test.js`, which deliberately constructs a fake `-----BEGIN PRIVATE KEY-----...` string as a *test fixture* to verify `lib/env.js`'s Firebase-completeness detection and `summary`'s secret-masking logic |
| "OpenAI API key" | 1 | `tests/env.test.js` - a deliberately fake `sk-thisIsASecretValueThatMustNeverAppear` fixture verifying the `summary` masking test itself |
| "FIREBASE_CLIENT_EMAIL value" | 1 | `tests/env.test.js` - a fake `svc@my-project.iam.gserviceaccount.com` fixture |
| "DATABASE_URL with embedded credentials" | 1 | `tests/env.test.js` - a fake `postgres://user:pass@host/db` fixture testing URL-shape validation |
| "generic hex/base64 secret-shaped assignment" | 1 | Same test file, same fixtures |

**Zero real secrets.** Every non-source-map, non-`.env` finding this
phase is traceable to a single file (`tests/env.test.js`) whose entire
purpose is testing secret detection/redaction logic - the same category
of expected false positive already established and documented in Phase 9
(`e2e/security.js`) and Phase 10 (`docs/secret-scan-report.md`). The
packaged Electron artifact was not rebuilt this phase (no source change
requires it, and this phase does not touch Electron packaging) - the
scan covers project source and docs, matching this phase's own scope. A
fresh packaged-artifact scan should still precede any real Electron
distribution, per the existing `docs/electron-distribution-checklist.md`
guidance.

## Task 25: Full regression

| Suite | Result |
|---|---|
| `npm test` (unit/integration) | **402/402** (up from 306 baseline: +49 across `tests/env.test.js`, `tests/logger.test.js`, `tests/requestId.test.js`, `tests/rateLimiter.test.js`; +7 `tests/gracefulShutdown.test.js`; +7 `tests/config.test.js` additions; +16 `tests/server-production.test.js`) |
| `e2e/run-all.js` (10 real-browser suites) | see final report for the fresh run's exact numbers |
| No port/process leak after any suite | ✅ verified via `netstat` after every run |

**Two real bugs were found and fixed by these new tests before they ever
shipped**, not after:

1. **Rate limiter middleware ordering**: `generalLimiter` was originally
   registered *after* `/health`/`/live`/`/ready`/static routes, so it
   never actually protected them (Express matches middleware in
   registration order) - caught by
   `tests/server-production.test.js`'s "General rate limiter protects
   routes beyond just chat" test failing with `200,200,200,200,200,200`
   instead of an eventual `429`. Fixed by moving its registration to
   immediately after body parsing, before any route.
2. **A temporal-dead-zone crash in graceful shutdown**:
   `lib/gracefulShutdown.js` referenced `hardExitTimer` from inside
   `server.close()`'s callback before the `const hardExitTimer = ...`
   line (declared *after* the `server.close()` call) had executed - this
   would have thrown a `ReferenceError` and crashed the shutdown handler
   on any deployment where `server.close()`'s callback fires
   synchronously or very quickly (a real, common case), turning a clean
   shutdown into a crash. Caught by `tests/gracefulShutdown.test.js`'s
   very first test. Fixed by declaring the timer before the `close()`
   call.

Both bugs are now locked in by dedicated regression tests
(`tests/server-production.test.js`, `tests/gracefulShutdown.test.js`).

## A real false positive found in the Phase 10 harness fix itself

Running this phase's full e2e regression surfaced a genuine, reproducible
false positive in `e2e/harness.js`'s own Phase 10 `assertPortClosed()`
regression guard (the one added specifically to catch the Phase 10
port-5500 leak). Multiple suites (`security.js`, `performance.js`,
`auth-error-matrix.js`) failed with `Error: port 5500 is still accepting
connections after harness cleanup` **after every real check in the suite
had already passed** - meaning the failure was in the cleanup
verification itself, not the application.

**Root cause**: `assertPortClosed()` worked by opening a raw TCP probe
connection to `127.0.0.1:5500` after the harness's own static server had
already closed, and treating *any* successful connection as proof the
harness leaked. On this development machine, a **completely unrelated
process** (a VS Code utility process, confirmed via
`Get-CimInstance Win32_Process`) opportunistically grabs a just-freed
port 5500 for its own port-forwarding/preview feature within the same
window this check runs in. The probe correctly found *something*
listening - it just couldn't tell "our own leaked server" apart from "an
unrelated process now occupies this port number for unrelated reasons,"
and failed the suite either way.

**Fixed** by replacing the external network probe with two deterministic,
in-process checks immune to any third-party process's use of the same
port number: the static server's own `.listening` property (Node's
`http.Server` sets this to `false` only once its own `close()` has truly
finished - a direct, race-free read of the exact state this check cares
about) and the backend child process's actual `exit` event (already
awaited by `backend.stop()`, now surfaced as a return value instead of
silently ignored). Re-verified: `node e2e/security.js` (previously
failing) now passes 22/22 with no cleanup error, and the full
`e2e/run-all.js` suite was re-run clean - see Task 25 below for the final
numbers. This required no application code change - `e2e/harness.js` is
test-only infrastructure, matching the exact same category and severity
as the original Phase 10 fix it corrects.

## Windows platform limitation for graceful-shutdown verification

Verified directly, not assumed: `child_process.kill('SIGTERM')` and
`child_process.kill('SIGINT')` both terminate a piped-stdio Node child
process on this Windows development machine **without invoking its
registered `process.on()` handler at all** - confirmed via a standalone
diagnostic script (spawn `server.js`, send each signal, observe `code:
null, signal: 'SIG...'` with neither `"shutdown started"` nor `"shutdown
complete"` ever logged). This is a demonstrated limitation of Windows
signal delivery to a child process via Node's `child_process` module, not
a defect in `lib/gracefulShutdown.js`. Real OS-level SIGTERM delivery
(the actual production scenario - a container orchestrator or `systemd`
sending SIGTERM) is not reproducible in this sandbox; the handler *logic*
is instead fully unit-tested directly (`tests/gracefulShutdown.test.js`,
7 tests against fake server/limiter objects with an injectable exit
function), and a forceful kill was verified to still fully release the
process's port (`tests/server-production.test.js`).

## Task 26: Documentation

New this phase: this document, `docs/production-environment.md`,
`docs/production-network-and-cors.md`, `docs/production-logging.md`,
`docs/production-monitoring.md`, `docs/production-rate-limiting.md`,
`docs/production-healthchecks.md`, `docs/production-sse-proxy.md`,
`docs/production-backup-and-rollback.md`, `docs/production-security.md`,
`docs/deployment-preflight-checklist.md`, `docs/nginx-example.conf`,
`Dockerfile`, `.dockerignore`. Updated: `README.md`, `.env.example`,
`docs/release-readiness-checklist.md` - see each for what changed.
