# Deployment Preflight Checklist (Phase 11)

A concrete pre-launch checklist synthesizing every Phase 11 document.
Classification key: **READY** / **CONFIGURED BUT NOT DEPLOYED** /
**PARTIAL** / **BLOCKED** / **NOT RUN** / **FAIL**.

## Process management (Task 22)

**Recommended path: a container runtime (Docker) managed by whatever
orchestrator the real hosting platform provides** (Kubernetes, ECS,
Cloud Run, a managed container platform) - this project's `Dockerfile`
(Phase 11, new) already implements graceful `SIGTERM` handling via
`lib/gracefulShutdown.js`, so it integrates correctly with any
orchestrator that sends `SIGTERM` before force-killing a container (the
universal, standard behavior).

If a container platform isn't the target, the second acceptable path is
**a Linux `systemd` service** (`Restart=on-failure`, environment injected
via an `EnvironmentFile=` pointing at a real, non-repository `.env`,
`KillSignal=SIGTERM` - already the systemd default) - `node server.js`
run directly, since `lib/gracefulShutdown.js` already handles `SIGTERM`
correctly on Linux (unlike this project's own Windows development
sandbox - see `docs/production-environment.md`'s platform note).

**PM2 is not currently used by this project** (no `ecosystem.config.js`
exists, and none is added this phase) - not recommended as the *primary*
path since it would be a new, undemonstrated dependency; it remains a
reasonable alternative to `systemd` if an operator already standardizes
on it elsewhere, since PM2 also forwards `SIGTERM` correctly.

**One clear recommended path, not five competing ones**: Docker + a real
orchestrator, falling back to `systemd` for a bare-VM deployment. Both
require no code changes beyond what Phase 11 already implements.

| Requirement | Status |
|---|---|
| Auto restart on crash | Orchestrator/`systemd`'s job, not application code - both support it natively |
| Graceful shutdown | ✅ implemented, unit-tested (`lib/gracefulShutdown.js`) |
| Environment injection | ✅ supported (`process.env`, validated by `lib/env.js`) - no code change needed for any of the standard mechanisms (container env vars, `systemd` `EnvironmentFile=`, etc.) |
| Log handling | ✅ stdout-only (`lib/logger.js`) - compatible with every standard log capture mechanism |

## Full checklist

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Backend production config validated at startup | READY | `lib/env.js`, `tests/env.test.js` |
| 2 | Frontend never falls back to localhost/5500 in production | READY | `www/config.js`, `tests/config.test.js` |
| 3 | CORS restricted to configured production origins | READY | `docs/production-network-and-cors.md` |
| 4 | Trust proxy configured safely (not blindly permissive) | READY (requires `TRUST_PROXY=1` set at deploy time behind a real proxy) | same doc |
| 5 | Rate limiting (single instance) | READY | `docs/production-rate-limiting.md` |
| 6 | Rate limiting (multi-instance/shared store) | CONFIGURED BUT NOT DEPLOYED (contract exists, `redis` not installed, not wired into `server.js`) | same doc |
| 7 | Structured logging with redaction | READY | `docs/production-logging.md` |
| 8 | Request ID propagation | READY | `lib/requestId.js`, `tests/requestId.test.js` |
| 9 | `/health`, `/live`, `/ready` | READY | `docs/production-healthchecks.md` |
| 10 | Production error sanitization | READY | `server.js`'s centralized error handler, unchanged in spirit since Phase 1, `requestId` added this phase |
| 11 | Database/persistence | BLOCKED - no PostgreSQL implemented; LocalStorage-only architecture unchanged | `docs/production-environment.md`, Task 11 |
| 12 | Graceful shutdown (SIGTERM/SIGINT) | READY (logic unit-tested); end-to-end OS-signal verification NOT RUN in this specific Windows sandbox (platform limitation, not a code defect) | `lib/gracefulShutdown.js`, `docs/production-environment.md` |
| 13 | HTTPS/reverse proxy | CONFIGURED BUT NOT DEPLOYED (a real Nginx example provided; no real proxy stood up) | `docs/nginx-example.conf` |
| 14 | SSE-safe proxy configuration documented | READY (documentation); real proxy simulation NOT RUN | `docs/production-sse-proxy.md` |
| 15 | Static asset caching policy | READY | `docs/production-environment.md` |
| 16 | Security headers (CSP/HSTS/Permissions-Policy/etc.) | READY | `docs/production-security.md` |
| 17 | Monitoring | PARTIAL - structured logs provide the substrate; no metrics backend/alerting connected | `docs/production-monitoring.md` |
| 18 | Alerting | NOT RUN - recommendations documented only, no integration | `docs/production-monitoring.md` |
| 19 | Backup strategy | READY (LocalStorage-only architecture needs none server-side); N/A for a future DB until one exists | `docs/production-backup-and-rollback.md` |
| 20 | Rollback plan | READY (documented); not rehearsed against a real deployment | same doc |
| 21 | Docker readiness | CONFIGURED BUT NOT DEPLOYED (`Dockerfile`/`.dockerignore` written, not built or run this phase - see Task 23 for what WAS actually run) | `Dockerfile`, `.dockerignore` |
| 22 | Process management path decided | READY (documented, no code change needed) | this document |
| 23 | Firebase (authenticated production path) | BLOCKED - no real Firebase project (unchanged since Phase 7) | `docs/firebase-production-checklist.md` |
| 24 | Android production path | BLOCKED - no real Android SDK/device (unchanged since Phase 9/10) | `docs/android-runtime-report.md` |
| 25 | Code signing (Electron) | BLOCKED - no certificate provisioned (unchanged since Phase 9) | `docs/electron-distribution-checklist.md` |
| 26 | Secret scan (source + artifacts) | READY | `docs/phase-11-production-preparation.md`, Task 24 |
| 27 | Full regression (unit + e2e) | READY | same, Task 25 |

## What "READY" means here specifically

**READY** in this checklist means *this project's own code and
configuration correctly support the item*, verified by a real test or
direct inspection - it does **not** mean the item has been exercised
against real production infrastructure (a real domain, a real reverse
proxy, a real multi-instance deployment). Nothing in this checklist was
deployed, published, signed, or committed, per this phase's explicit
rules.
