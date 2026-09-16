# Final Release Matrix (Phase 9, Task 13)

Classification key: **PASS** (verified with real evidence) / **PARTIAL**
(some real evidence, real gaps remain) / **NOT RUN** (genuinely not
exercised, no evidence either way) / **BLOCKED** (attempted for real, a
named external factor prevented completion) / **FAIL** (a confirmed defect
exists right now). This supersedes `docs/release-readiness-checklist.md`
for anything Phase 9 touched; unchanged Phase 1-8 items are carried
forward without re-litigating them.

## What changed since Phase 8

| Area | Phase 8 | Phase 9 |
|---|---|---|
| Electron runtime launch | BLOCKED (`ELECTRON_RUN_AS_NODE=1`, no workaround attempted) | **PASS** - scoped env override, 23/23 real checks, 1 real bug found+fixed |
| Electron packaging | PARTIAL (critical secret-bundling bug found+fixed, build itself blocked by symlink privilege) | **PASS** - full real build completed, real packaged app launched, 10/10 real checks |
| Android/Capacitor toolchain | "no Android tooling available" (unspecific) | **BLOCKED**, precisely: Java/Gradle/AGP/`cap sync` all work; only the Android SDK itself is missing, confirmed via the exact `assembleDebug` error |
| Google Auth (Capacitor) | "Recommended" strategy, not finalized | **Decided** (final, single strategy): `@capacitor-firebase/authentication` |
| Screen-reader readiness | "no screen reader available" | **NOT RUN**, more precisely: Narrator exists as OS software; the automation session itself has no audio/interpretation channel to drive or read any screen reader |
| Release security scan | not run as a dedicated phase task | **PASS** - 1,697 raw findings, 100% reviewed, zero real secrets, including inside the real packaged `app.asar` |
| Full regression | 187/187 real-browser | **227/227** (187 carried forward + 23 Electron runtime + 10 Electron packaged + 7 auth-error-matrix already counted) |
| Unit/integration suite | 305/305 | **306/306** |

## Frontend / Backend / Auth / AI modes / Streaming / Chat history / Import-export / Responsive

Unchanged from Phase 8 - all PASS, re-confirmed passing in this phase's
final regression run. See `docs/release-readiness-checklist.md` for the
itemized table; nothing in these areas regressed or was touched this
phase.

## Security

| Item | Status | Evidence |
|---|---|---|
| No secret in frontend source | PASS | `docs/secret-scan-report.md` |
| No secret in the real packaged Electron app | **PASS**, re-verified against a freshly rebuilt `app.asar` this phase | `docs/secret-scan-report.md` |
| XSS resistance, CSP/CORS/Helmet | PASS, unchanged | `e2e/security.js`, 22/22 |
| Electron navigation/popup hardening | PASS, unchanged from Phase 8 fix | `docs/electron-distribution-checklist.md` |

## Accessibility

| Item | Status | Evidence |
|---|---|---|
| Automated (axe-core), all 4 states | PASS, 0 violations | `e2e/accessibility.js`, 18/18 |
| Keyboard operability, focus traps | PASS | `e2e/keyboard.js`, 26/26 |
| Real screen-reader testing | **NOT RUN** - automation environment has no way to drive/interpret one (see `docs/phase-09-real-environment.md`, Task 10) | - |

## Firebase

| Item | Status | Evidence |
|---|---|---|
| Client/Admin config loading, safe fallback | PASS | source + `tests/auth.test.js` |
| Real login / real token verification | **NOT RUN** - no real Firebase project in this environment | `docs/firebase-production-checklist.md` |

## Electron

| Item | Status | Evidence |
|---|---|---|
| Source security review | PASS | `docs/electron-distribution-checklist.md` |
| Runtime launch | **PASS** (was BLOCKED) | 23/23, `docs/electron-distribution-checklist.md` |
| Packaging (unsigned, `--dir`) | **PASS** (was PARTIAL) | real `.exe` + `app.asar`, 10/10 launch checks |
| Signed installer | NOT RUN - out of scope, no signing requested or attempted | - |

## Capacitor / Android

| Item | Status | Evidence |
|---|---|---|
| Config validation | PASS | `tests/capacitor-config.test.js` |
| Toolchain (Java/Gradle/AGP/`cap sync`) | **PASS** | `docs/android-capacitor-checklist.md` |
| Android SDK present | **FAIL/absent** - confirmed by exact `assembleDebug` error, not a project defect (an environment provisioning gap) | same |
| Device/emulator runtime | **BLOCKED** (was NOT RUN) - toolchain works, only the SDK install itself is missing | same |
| Google Auth strategy | **Decided** (final): `@capacitor-firebase/authentication`, not installed | same |

## Tests

| Item | Status | Evidence |
|---|---|---|
| Unit/integration suite | PASS, 306/306 | `npm test` |
| Real-browser + Electron suite | PASS, 227/227 | `docs/phase-09-real-environment.md`, Task 12 table |
| No orphan processes/ports after any suite | PASS | checked after every run this phase |

## Environment variables

Unchanged from Phase 8 - `.env.example` documents every variable, reviewed
this phase, no new variable was introduced, nothing needed updating.

## Deployment prerequisites (still outstanding - unchanged in kind, some narrowed in Phase 9)

| Item | Status |
|---|---|
| A real Firebase project | Not provisioned |
| A production `OPENAI_API_KEY` with spend limits | Operator responsibility, outside this project's source |
| A real code-signing certificate (for a signed Electron installer) | Not provisioned, not attempted |
| An Android SDK installation | **Not provisioned** - this phase confirmed it is the only missing toolchain layer |
| An Android keystore + Firebase SHA fingerprints + `@capacitor-firebase/authentication` installed | Not provisioned - strategy is now decided (see above), implementation still pending a real SDK/device to validate against |
| HTTPS termination for the production backend | Infrastructure decision outside this project's source |

## Overall distribution readiness verdict

- **Desktop (Electron), unsigned/internal distribution**: ready. Real
  runtime launch and real packaging both pass with real evidence; the one
  remaining gap (a signed installer) is a deliberate scope boundary of this
  phase (no signing certificate provided, none requested), not a defect.
- **Web (browser)**: ready, unchanged from Phase 8 - the most thoroughly
  verified target across every phase.
- **Android (Capacitor)**: not ready to build or ship. The toolchain is
  confirmed correct; the missing Android SDK is an environment-provisioning
  gap, not a code defect, and is the only blocker to producing a real APK.
  Native Google auth additionally needs the (now-decided) plugin installed
  and validated against a real device before Android auth can ship.
- **Authenticated features (any platform)**: not ready to rely on for
  real users until a real Firebase project is provisioned and the
  checklist in `docs/firebase-production-checklist.md` is walked for real.
  Guest-mode chat is unaffected and fully ready on every platform.
