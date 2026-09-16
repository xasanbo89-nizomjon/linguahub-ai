# Release Readiness Checklist

Classification key: **PASS** (verified with evidence) / **PARTIAL** (some real evidence, real gaps remain) / **NOT RUN** (genuinely not exercised, no evidence either way) / **BLOCKED** (attempted for real, an external factor prevented completion) / **FAIL** (a confirmed defect exists right now).

Nothing below is marked PASS without a specific test, script, or direct inspection backing it - see the linked evidence for each.

**As of Phase 11, see `docs/deployment-preflight-checklist.md` for the
current, authoritative status** (which supersedes Phase 10's
`docs/phase-10-release-matrix.md`, which itself supersedes Phase 9's
`docs/final-release-matrix.md`) - production environment validation,
structured logging, multi-tier rate limiting, health/readiness endpoints,
graceful shutdown, and a full production security/CORS/reverse-proxy
audit, all real and tested, on top of Phase 10's native Android Google
Auth implementation and Phase 9's real Electron runtime/packaging
verification. **Nothing was deployed** - Firebase, Android, and code
signing remain exactly as blocked as Phase 9/10 left them; Phase 11 adds
production *readiness*, not a production *deployment*. All three
matrices supersede the Electron, Capacitor, Security, and Accessibility
rows below (Phase 8 snapshot, kept for history).

## Frontend

| Item | Status | Evidence |
|---|---|---|
| Loads without a blank screen | PASS | `e2e/smoke.js` |
| No fatal console errors on load | PASS | `e2e/smoke.js` |
| Responsive across 7 viewports (360px–1440px) | PASS | `e2e/responsive.js`, 38/38 |
| Theming (light/dark/system) | PASS | `e2e/smoke.js`, `e2e/performance.js` |
| Dialogs, toasts, settings panel | PASS | `e2e/smoke.js`, `e2e/keyboard.js` |
| Markdown/code rendering | PASS (mocked content, real render path) | `e2e/smoke.js` |

## Backend

| Item | Status | Evidence |
|---|---|---|
| `/health` | PASS | `e2e/smoke.js`, `tests/server.test.js` |
| CORS allowlist enforced | PASS | `tests/server.test.js` (real rejection), `e2e/security.js` (real CSP/header check) |
| Helmet headers (CSP, nosniff, frame-ancestors) | PASS, unchanged from Phase 4 | `e2e/security.js` |
| Rate limiting | PASS | `e2e/security.js` (real 429 triggered) |
| Input/context limits | PASS | `e2e/security.js` (real 400s triggered) |

## Auth

| Item | Status | Evidence |
|---|---|---|
| Guest mode works with no config | PASS | `e2e/auth-error-matrix.js` |
| Missing-config UI is honest | PASS | `e2e/auth-error-matrix.js`, `e2e/keyboard.js` |
| Backend fails safely when Admin unconfigured | PASS | `tests/auth.test.js`, `e2e/auth-error-matrix.js` |
| Auth error messages never leak raw Firebase errors | PASS (**one real bug found + fixed this phase**) | `tests/frontend-auth.test.js` |
| Real Google login end-to-end | **NOT RUN** | no real Firebase project - `docs/firebase-real-verification.md` |
| Real backend ID token verification (success path) | **NOT RUN** | same |
| Namespace isolation (guest vs. user) | PASS (structural) | `tests/chatStore.test.js` |

## AI modes

| Item | Status | Evidence |
|---|---|---|
| 4 enabled modes work with the real provider | PASS | Phase 6 report, re-confirmed via `e2e/smoke.js`'s real generation |
| Disabled modes (Image/Voice/Web Search) are honest, not faked | PASS | `e2e/security.js` (UI + backend defense-in-depth) |
| Client cannot override model/prompt/temperature/tools | PASS | `e2e/security.js`, `tests/ai-modes-request.test.js` |

## Streaming

| Item | Status | Evidence |
|---|---|---|
| Real streaming, Stop, Edit, Regenerate, Retry | PASS | `e2e/smoke.js` (real provider) |
| Network failure handling (401/403/429/500/hang/malformed/empty) | PASS | `e2e/network-failures.js`, 15/15 |

## Chat history

| Item | Status | Evidence |
|---|---|---|
| Refresh restores state, New Chat/rename/delete/clear/search | PASS | `e2e/storage.js`, 15/15 |
| Corrupted LocalStorage recovers | PASS | `e2e/storage.js` |
| Mode persists per conversation | PASS | `e2e/storage.js` |
| Stopped/failed messages restore correctly | PASS (**one real bug found + fixed this phase** - empty-content messages used to vanish) | `e2e/storage.js`, `tests/streaming-persistence.test.js` |

## Import/export

| Item | Status | Evidence |
|---|---|---|
| Real download + real file-input import round-trip | PASS | `e2e/smoke.js`, `e2e/security.js` |
| Malicious import content stays inert | PASS | `e2e/security.js` |

## Security

| Item | Status | Evidence |
|---|---|---|
| No secret in frontend source/bundle | PASS | `e2e/security.js` |
| No secret in the **packaged Electron app** | **FAIL → fixed in Phase 8, re-verified PASS against a freshly rebuilt app.asar in Phase 9** | `docs/electron-runtime-report.md`, `docs/secret-scan-report.md` |
| XSS resistance (Markdown, import) | PASS | `e2e/security.js` |
| CSP/CORS/Helmet unchanged and active | PASS | `e2e/security.js` |
| Electron navigation/popup hardening | PASS (**one real gap found + fixed this phase**) | `docs/electron-runtime-report.md` |

## Accessibility

| Item | Status | Evidence |
|---|---|---|
| Automated (axe-core), all 4 states | PASS, 0 violations at all severities | `docs/accessibility-final-report.md` |
| Keyboard operability, focus traps, restoration | PASS | `e2e/keyboard.js`, 26/26 |
| 200% zoom, forced-colors emulation | PASS | `e2e/accessibility.js` |
| Real screen-reader testing | **NOT RUN** (Phase 9: root cause narrowed - Windows Narrator exists as OS software, but this automation session has no audio/interpretation channel to drive or read any screen reader) | `docs/phase-09-real-environment.md`, Task 10 |

## Responsive / Browser

| Item | Status | Evidence |
|---|---|---|
| 7-viewport matrix | PASS | Phase 7, re-confirmed this phase |
| No request to port 5500 | PASS | every e2e suite checks this |

## Firebase

| Item | Status | Evidence |
|---|---|---|
| Client config loading, safe fallback | PASS | source + live |
| Admin config loading, safe fallback | PASS | source + `tests/auth.test.js` |
| Real login / real token verification | **NOT RUN** | no real project - `docs/firebase-real-verification.md` |

## Electron

| Item | Status | Evidence |
|---|---|---|
| Source security review | PASS (**one gap found + fixed**) | `docs/electron-runtime-report.md` |
| Runtime launch | **PASS as of Phase 9** (was BLOCKED - scoped `ELECTRON_RUN_AS_NODE` override found, 23/23 real checks) | `docs/electron-distribution-checklist.md` |
| Packaging | **PASS as of Phase 9** (was PARTIAL - real unsigned build now completes in full, real packaged app launched, 10/10 real checks) | `docs/electron-distribution-checklist.md` |

## Capacitor

| Item | Status | Evidence |
|---|---|---|
| Config validation | PASS | `tests/capacitor-config.test.js` (new) |
| Source review | PASS | `docs/capacitor-runtime-report.md` |
| Toolchain (Java/Gradle/AGP/`cap sync`) | **PASS as of Phase 9** | `docs/android-capacitor-checklist.md` |
| Device/emulator runtime | **BLOCKED as of Phase 9** (was NOT RUN - toolchain confirmed working; only the Android SDK install itself is missing, exact error captured) | `docs/android-capacitor-checklist.md` |
| Google auth strategy | **Decided (final) as of Phase 9**: `@capacitor-firebase/authentication`, nothing installed | `docs/android-capacitor-checklist.md` |

## Tests

| Item | Status | Evidence |
|---|---|---|
| Unit/integration suite | PASS, 402/402 (Phase 11, up from 326 Phase 10) | `npm test` |
| Real-browser + Electron suite | PASS - all suites re-run clean this phase, one already-documented pre-existing environment timing flake (`performance.js`'s theme-switch check, proven non-reproducing in isolation - see `docs/phase-11-production-preparation.md`, Task 25) | `npm run test:e2e`, `docs/phase-11-production-preparation.md` |
| No orphan processes/ports after any suite | PASS | checked via `netstat` after every run, every phase including 11 - a real false-positive in the Phase 10 harness check itself was found and fixed this phase (`e2e/harness.js`), see `docs/phase-11-production-preparation.md` |

## Environment variables

| Item | Status | Evidence |
|---|---|---|
| `.env.example` documents every variable | PASS | reviewed, one clarifying note added (packaging safety) |
| No real secret in `.env.example` | PASS | reviewed |
| `.gitignore` excludes `.env` and service-account patterns | PASS, pre-existing | reviewed |

## Deployment prerequisites

| Item | Status |
|---|---|
| A real Firebase project (if auth is required for launch) | Not provisioned |
| A production `OPENAI_API_KEY` with appropriate spend limits | Operator responsibility, outside this project's source |
| A real code-signing certificate (if publishing a signed Electron build) | Not provisioned, not attempted (unsigned `--dir` packaging itself now succeeds - Phase 9) |
| An Android SDK installation | Not provisioned - confirmed the only missing toolchain layer, Phase 9 |
| An Android keystore + Firebase SHA fingerprints (if publishing to Android with native auth) | Not provisioned - native auth strategy is now decided (`@capacitor-firebase/authentication`) but not installed, see `docs/android-capacitor-checklist.md` |
| HTTPS termination for the production backend | Infrastructure decision outside this project's source |

## Rollback prerequisites

| Item | Status |
|---|---|
| No deployment has occurred | N/A - nothing to roll back |
| All Phase 1–8 changes are file-based, no database migrations | confirmed - this app has no database beyond client-side LocalStorage |
| Every phase's exact file-level changes are documented | PASS - see each `docs/phase-0N-*.md` |
