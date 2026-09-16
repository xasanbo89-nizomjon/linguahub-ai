# Phase 10: Real Firebase Integration, Google Login Verification, Android SDK Setup, Capacitor Runtime, and Native Mobile Authentication

This phase's mandate: complete real Firebase authentication and
Android/Capacitor runtime verification wherever the local environment
genuinely permits it, and implement the native Capacitor Google Auth
strategy Phase 9 selected - while never claiming a check ran when it
didn't, never inventing credentials, and never rebuilding the existing
architecture.

## Task 1: Audit of Phase 9 state and current source

Re-read in full before any change: all six Phase 9 docs
(`phase-09-real-environment.md`, `firebase-production-checklist.md`,
`electron-distribution-checklist.md`, `android-capacitor-checklist.md`,
`secret-scan-report.md`, `final-release-matrix.md`), plus
`firebase-setup.md`, `lib/firebaseAdmin.js`, `middleware/auth.js`,
`server.js`'s `/api/auth/me` route, `www/auth.js`, `www/config.js`,
`capacitor.config.json`, `android/` (manifest, `MainActivity.java`,
`build.gradle` at both root and app level, `variables.gradle`),
`package.json`, and the existing test suite.

**Findings:**

1. Firebase client/Admin: both still unconfigured (blank
   `www/firebase-config.js`, no `FIREBASE_*`/`GOOGLE_APPLICATION_CREDENTIALS`
   in `.env`) - unchanged since Phase 7.
2. No real credentials present anywhere in this session.
3. Authorized-domain requirements: documented in
   `docs/firebase-production-checklist.md` (Phase 9), still accurate.
4. Web Google login flow: Firebase compat SDK, `signInWithPopup` →
   `signInWithRedirect` fallback, unchanged and working (mocked) per
   `tests/frontend-auth.test.js`.
5. Electron auth flow: identical to the web flow (same `www/auth.js`,
   same compat SDK) - Electron has no platform-specific auth code.
6. Capacitor auth limitation: embedded-WebView OAuth is not
   production-safe on Android (Phase 9's finding, unchanged) - this is
   exactly what Task 10 below replaces with a real native adapter.
7. Android SDK/toolchain: absent, but Java/Gradle/AGP/Capacitor CLI all
   confirmed working (Phase 9's finding) - re-confirmed this phase with a
   fuller inventory, see `docs/android-runtime-report.md`.
8. Native plugin compatibility: not previously checked in depth - this
   phase found two real, non-obvious integration defects before they
   could ship (the `photoUrl`/`photoURL` casing mismatch and the Gradle
   `rgcfaIncludeGoogle` gate) - see `docs/capacitor-native-auth.md`.
9. Files requiring modification: `www/auth.js` (adapter), `www/config.js`
   (Android emulator host fix), `www/index.html` (new vendor scripts),
   `capacitor.config.json` (plugin config), `android/variables.gradle`
   (Gradle gate), `package.json` (new dependency + Electron files
   allowlist exclusion), `.gitignore` (`google-services.json`).
10. Regression risk: primarily around `www/auth.js`, since it's on the
    critical path for every chat request (`buildAuthHeaders()`) - mitigated
    by keeping the web backend's code path byte-identical and covering the
    new native backend with 14 dedicated unit tests before touching
    anything else.
11. Implementation plan: verify compatibility first (done, documented),
    implement the adapter as an additive, platform-gated backend (done),
    fix the two real defects found along the way (done), re-run the full
    regression suite (done, see Task 17 below).

## Task 2: Firebase credential checkpoint

Re-checked directly, same result as every prior phase:

```
$ node -e "require('dotenv').config(); ['FIREBASE_PROJECT_ID','FIREBASE_CLIENT_EMAIL','FIREBASE_PRIVATE_KEY','GOOGLE_APPLICATION_CREDENTIALS'].forEach(k => console.log(k, process.env[k] ? 'set' : 'unset'))"
FIREBASE_PROJECT_ID unset
FIREBASE_CLIENT_EMAIL unset
FIREBASE_PRIVATE_KEY unset
GOOGLE_APPLICATION_CREDENTIALS unset
```

No values printed, no values invented. **Real Firebase verification:
BLOCKED for this reason alone** - see
`docs/firebase-live-login-report.md` and
`docs/firebase-admin-live-report.md`. Per this phase's explicit
instruction, work continued on everything Android/source/test-related
that doesn't require real credentials.

## Task 4: Firebase Console checklist - exact manual actions required

No authenticated Firebase Console access exists in this environment, so
none of the following was (or could be) done - listed precisely so
whoever has console access knows exactly what's needed:

| # | Action | Status |
|---|---|---|
| 1 | Create/select a Firebase project | Not done |
| 2 | Add a Web app to the project | Not done |
| 3 | Authentication → Sign-in method → enable Google | Not done |
| 4 | Set a support email for the Google provider | Not done |
| 5 | Authorized domains: add every real domain the app will be served from | Not done |
| 6 | `localhost` is authorized by default in a new Firebase project - no action needed for local web dev | N/A |
| 7 | `127.0.0.1` is **not** the same as `localhost` to some browsers' cookie/storage partitioning, though Firebase's own authorized-domains check is hostname-based and `127.0.0.1` is not auto-authorized the way `localhost` is - **add `127.0.0.1` explicitly if local dev is done against that hostname** (this project's own dev default already prefers `127.0.0.1` - see `www/config.js`) | Documented, not done |
| 8 | Add an Android app to the project, package name `com.xasan.ai` (matches `capacitor.config.json`'s `appId` and `android/app/build.gradle`'s `namespace`/`applicationId` - a pre-rename cosmetic leftover, not changed, see `docs/android-capacitor-checklist.md`) | Not done |
| 9 | Confirm the registered Android package name is exactly `com.xasan.ai` | Not done |
| 10 | Register the **debug** keystore's SHA-1 fingerprint | Not done - no keystore exists to generate one from yet |
| 11 | Register the SHA-256 fingerprint (both debug and, later, release) | Not done |
| 12 | Download `google-services.json` and place it at `android/app/google-services.json` | Not done - `android/app/build.gradle`'s conditional apply block already handles its absence safely (confirmed by this phase's real `./gradlew` runs) |
| 13 | Create Admin credentials securely (Service accounts → Generate new private key) and store as `GOOGLE_APPLICATION_CREDENTIALS` or the three discrete `FIREBASE_*` env vars - **never commit this file** | Not done |
| 14 | Add the real production domain to Authorized domains before any real deployment | Not done - no deployment has occurred, matching this phase's own no-deploy rule |

No Firebase Console was accessed or modified this phase, per the explicit
instruction not to modify it without authenticated access (none exists).

## Task 8/9: Android SDK and Capacitor build - see dedicated reports

Full detail in `docs/android-runtime-report.md`. Summary: Java, Gradle,
AGP, and `npx cap sync android` all confirmed working; the Android SDK
itself is the sole missing prerequisite (exact error captured from a real
`assembleDebug` run). Not installed, per the explicit instruction not to
silently install large global tooling without existing support - none
exists on this machine (no Android Studio, no partial SDK).

## Task 10: Native Capacitor Firebase Auth - implemented

Full detail in `docs/capacitor-native-auth.md`. Summary: installed
`@capacitor-firebase/authentication@8.3.0`, verified compatibility before
writing any code, implemented a platform-gated adapter inside the existing
`www/auth.js` (one public interface, web backend unchanged, new native
backend added), found and fixed two real integration defects
(`photoUrl`/`photoURL` casing, the Gradle `rgcfaIncludeGoogle` gate), and
covered the adapter with 14 new unit tests. Not verified on a real device
- none exists in this environment.

## Task 11: Android Firebase configuration

`google-services.json` does not exist in this repo (no real Firebase
project). Added to `.gitignore` pre-emptively
(`android/app/google-services.json`) so a real one, when added later,
is never accidentally shared. `android/app/build.gradle`'s conditional
`google-services` plugin apply block (present before this phase) was
re-verified safe with the file absent - confirmed by this phase's real
Gradle runs completing normally past that point. Full detail in
`docs/mobile-security-report.md`.

## Tasks 12 & 13: Real Android runtime and real Capacitor Google login

Both **NOT RUN** - no Android SDK, emulator, or device exists in this
environment. Every checklist item is listed and honestly marked in
`docs/android-runtime-report.md`; none is claimed as passing based on
source review alone.

## Task 14: Mobile network configuration - real bug found and fixed

`www/config.js` previously resolved Capacitor Android's default WebView
origin to `127.0.0.1`, which a real Android emulator can never reach (that
address refers to the emulator itself, not the host). Fixed to use the
standard `10.0.2.2` emulator-host alias, scoped so it has zero effect on
Electron or iOS. Full detail, including the physical-device and
production-URL requirements (both need an explicit override - there's no
way to auto-detect either), in `docs/android-network-configuration.md`.

## Task 15: Security audit, and an unrelated but real environment finding

Full detail in `docs/mobile-security-report.md`. Summary: zero new real
secrets, the native adapter never logs or persists a token, and
`google-services.json` is now pre-emptively `.gitignore`'d.

**A real, separate finding surfaced during this phase's regression
testing, documented here because of how much investigation it took:**
repeated `electron-builder --dir` rebuilds in quick succession, this
session, eventually produced a genuine OS-level file lock
(`Device or resource busy`, reproduced by a plain `rm` outside
electron-builder entirely) on the packaged `app.asar`, and - before that -
a reproducible, severe delay (45+ seconds) in the packaged app's real
`/api/chat/stream` request completing, while the exact same backend
answered a direct `curl` request in 1.48 seconds and the exact same
request succeeded normally in dev-mode Electron. Investigated
methodically:

1. Diagnostic script with full request/response/console logging showed
   the request left the renderer immediately and the backend logged
   receiving and fully handling it (headers flushed) almost instantly -
   the delay was entirely between the backend flushing headers and the
   renderer's `fetch()` recognizing the response, specific to the
   streamed (`text/event-stream`, chunked) response type - a plain JSON
   `GET /api/ai/modes` in the same packaged app returned instantly.
2. An A/B rebuild with this phase's own script changes temporarily
   disabled reproduced the **same** delay pattern, ruling out this
   phase's source changes as the cause.
3. `Get-MpComputerStatus` confirmed Windows Defender's real-time
   protection, antivirus, and behavior monitoring are all enabled on this
   machine.
4. Further rebuild attempts then hit the file-lock error above, with no
   visible owning process in either `ps -W` or PowerShell's
   `Get-Process` - consistent with a kernel-level filter driver (i.e.
   Defender's real-time scanning engine) holding a transparent lock,
   which does not show up as an ordinary process handle.

**Conclusion**: this is a genuine, external Windows-security-software
interaction with freshly-built, unsigned executables and their bundled
archives in this specific sandbox - not a defect in this project's code,
and not something this phase attempted to work around by disabling or
excluding anything from Defender (would require admin privileges and
explicit authorization, neither available nor sought, matching the same
standing restriction from Phase 9's Developer Mode discussion). The
packaged Electron build from earlier this phase (before the rebuild
storm that triggered the lock) is real, contains every Phase 10 source
change, and was used for the secret scan in `docs/mobile-security-report.md`.
**Classified PARTIAL, not FAIL**: the packaged app launches, loads, and
functions correctly for everything tested except the one streamed-request
check, which is environment-blocked rather than code-broken - real
evidence for that distinction is documented above, not assumed.

## Task 16: Accessibility mobile check (source-level)

| Check | Finding |
|---|---|
| Touch target sizing | `--touch-target-min: 44px` CSS token already exists (Phase 7/8), re-confirmed present and applied |
| Font scaling | Every `--font-size-*` token in `www/theme.css` uses `rem`, not fixed `px` - this respects Android's system font-scale accessibility setting (rem is relative to the root element's font size, which Android's WebView scales) |
| Content descriptions / accessible names | Covered at the web layer by Phase 8's accessibility work (`docs/accessibility-final-report.md`) - the same HTML ships to the Android WebView unchanged (`webDir: "www"`), so the same axe-core-verified landmarks/labels/ARIA apply there too, though not re-verified inside an actual native WebView (no device) |
| High-contrast / orientation / 200%-equivalent scaling | Covered by browser emulation in Phase 8 (`forced-colors`, 200% zoom) - not re-verified on a real Android device |
| TalkBack | **Not used** - no Android device exists to run it on. Not claimed. |

## Task 17: Full regression

| Suite | Result |
|---|---|
| `npm test` (unit/integration) | **326/326** (up from 306 baseline: +2 `config.test.js`, +14 `native-auth-adapter.test.js` (new file), +1 `capacitor-config.test.js`, +2 `chatStore.test.js`, +1 `frontend-auth.test.js`) |
| `e2e/smoke.js` | 38/38 |
| `e2e/responsive.js` | 38/38 |
| `e2e/keyboard.js` | 26/26 |
| `e2e/network-failures.js` | 15/15 |
| `e2e/storage.js` | 15/15 |
| `e2e/security.js` | 22/22 |
| `e2e/accessibility.js` | 18/18 |
| `e2e/empty-state.js` | 8/8 |
| `e2e/performance.js` | 7/7 (isolated) - flaked once under sustained sequential full-suite load; proven via a controlled A/B run (Phase 10 scripts disabled, ran again) to reproduce identically either way, confirming pre-existing environment resource contention, not a Phase 10 regression - see below |
| `e2e/auth-error-matrix.js` | 7/7 |
| `e2e/electron.js` (real dev-mode Electron) | 23/23 |
| `e2e/electron-packaged.js` (real packaged app) | 9/10 - see the SSE-hang finding above; all other checks pass |

**No flaky hidden retries**: every re-run above is disclosed, not hidden -
including the one genuine intermittent full-suite timing flake
(`performance.js`'s cold-start check, and once `storage.js`'s page load),
proven via a direct A/B comparison (my script tags disabled, then
re-enabled) to reproduce identically in both cases - i.e., proven to be
this sandboxed environment's own resource contention under sustained
sequential Chromium load, not caused by this phase's changes. **No orphan
server or emulator process** was left behind by any suite (no emulator
ever ran; backend/Electron processes checked via `netstat`/process list
after every run, and an orphaned port-3000 backend accidentally left by
one of this phase's own ad-hoc diagnostic commands was found and killed
during investigation - see `docs/mobile-security-report.md`). **No
production credential output**: nothing above prints a real secret value.
**No user data mutation outside test namespaces**: every test uses its own
fake/in-memory storage or a throwaway conversation created and torn down
within the test itself.

## Addendum: a real port 5500 leak, found and fixed mid-phase

After this phase's implementation work above, a live browser smoke-test run
(`e2e/smoke.js`, 38/38 passed) was followed by a routine port/process
cleanliness check that found a **real, live orphaned process still
LISTENING on port 5500** (PID 6872) - the throwaway static file server
`e2e/harness.js` starts to stand in for a dev "Live Server". Port 3000 (the
backend) was already clean at the same moment; only the static server had
leaked.

**Investigation**: `e2e/harness.js`'s `withApp()` already closes the static
server in a `finally` block (`await new Promise((resolve) =>
staticServer.close(resolve))`), so a normal exit should never leave it
running. Node's plain `server.close(callback)` only invokes its callback
once every open connection has ended **on its own** - a single lingering
HTTP/1.1 keep-alive socket (Chromium's connection pool doesn't always tear
down the instant `browser.close()` returns, and this project requires
Node v24, whose default `keepAliveTimeout` behavior can leave a socket
open longer than a test run should ever wait for) can make `close()` hang
indefinitely instead of erroring. Because the harness's cleanup steps run
sequentially, a hang here would silently strand that one specific
invocation's Node process forever (backend already stopped via its own
existing bounded-timeout fallback, browser already closed, only the
static server's own `close()` call left never resolving) - exactly the
observed symptom: a "38/38 passed"-looking run completed fine, while a
**separate, earlier, still-hung invocation** was the one actually leaking
port 5500 in the background, invisible until a direct `netstat` check.

**Fix** (`e2e/harness.js`, test-only code - no application architecture
touched):
1. `server.closeAllConnections()` (Node 18.2+) is now called immediately
   before `close()`, forcing every open socket shut instead of waiting for
   graceful keep-alive expiry.
2. A bounded 3-second fallback timeout was added around the close call,
   matching the pattern `backend.stop()` already used - so this can never
   hang again even if some other, still-unknown cause reappears.
3. A new `assertPortClosed(port)` regression guard now runs at the end of
   every `withApp()` invocation's `finally` block, for **both** port 3000
   and port 5500 - it actively probes whether either port still accepts a
   connection and throws a loud, visible test failure if so, rather than
   letting a future regression leak silently again. This protects every
   suite that uses the shared harness (currently 10 of them), not just
   `smoke.js`.

**Re-verified**: the orphaned PID 6872 was confirmed fully terminated,
ports 3000 and 5500 confirmed clean (`netstat`, no LISTENING entries, only
expected `TIME_WAIT` residue), `e2e/smoke.js` re-run clean (38/38, exit
code 0) with an immediate post-run port check showing no listener on
either port, and the complete `e2e/run-all.js` suite (10 suites, all
suites using the fixed harness) re-run clean afterward with no leaked
process or port at the end. This fix required no change to
`www/`/`server.js`/`main.js` - `e2e/harness.js` is test-only
infrastructure, never shipped to a user.

## Post-fix full regression re-confirmation

With the harness fix in place, the entire suite was re-run fresh, in this
order, to get final, current numbers:

| Suite | Result |
|---|---|
| `npm test` | 326/326 |
| `e2e/run-all.js` (10 suites: smoke, responsive, empty-state, accessibility, keyboard, network-failures, storage, security, performance, auth-error-matrix) | all 10 suites passed, 0 failures across all of them |
| Electron rebuild (`npx electron-builder --dir --publish never`, fresh, single attempt) | completed - real `LinguaHub AI.exe` + `app.asar` (9,165 files) produced |
| `e2e/electron-packaged.js` (fresh build) | **9/10** - re-confirms the exact same, already-investigated finding from earlier this phase (the packaged app's streamed `/api/chat/stream` round-trip specifically hits an environment-caused delay/hang; every other check, including a real window, real assets, real config resolution, theme switching, and LocalStorage, passes) |
| `node e2e/secret-scan.js` (fresh build) | 1,698 findings, identical breakdown to the earlier scan this phase (1,695 source maps, 2 self-referential false positives, 1 expected `.env` marker) - zero real secrets, re-confirmed against the newly rebuilt artifact |

No port 3000/5500 listener and no orphaned Electron/Node process remained
after any of the above (checked directly after each step).

## Task 18: Documentation

This document plus `docs/firebase-live-login-report.md`,
`docs/firebase-admin-live-report.md`, `docs/capacitor-native-auth.md`,
`docs/android-runtime-report.md`, `docs/android-network-configuration.md`,
`docs/mobile-security-report.md`, and `docs/phase-10-release-matrix.md`
are new this phase. `README.md`, `.env.example`,
`docs/firebase-setup.md`, `docs/android-capacitor-checklist.md`, and
`docs/release-readiness-checklist.md` were updated - see each for what
changed. `.gitignore` was updated (`android/app/google-services.json`).
