# Phase 10 Release Matrix

Classification key: **PASS** (verified with real evidence) / **PARTIAL**
(some real evidence, real gaps remain) / **NOT RUN** (genuinely not
exercised) / **BLOCKED** (attempted for real, a named external factor
prevented completion) / **FAIL** (a confirmed defect exists right now).
Supersedes `docs/final-release-matrix.md` (Phase 9) for the rows below;
everything else from that matrix is unchanged and carried forward.

## What changed since Phase 9

| Area | Phase 9 | Phase 10 |
|---|---|---|
| Capacitor Google Auth | Decided, not installed | **Installed and implemented** - real adapter, 14 new unit tests, two real integration defects found and fixed before they could ship |
| Android network configuration | Not audited for emulator-reachability | **Real bug found and fixed**: Android emulator default host now correctly resolves to `10.0.2.2`, not `127.0.0.1` |
| Android toolchain | Java/Gradle/AGP/`cap sync` confirmed | Re-confirmed with a fuller inventory (disk space, virtualization firmware, `javac`, Android Studio) - same bottom line |
| Real Firebase login/Admin | BLOCKED | **Still BLOCKED** - same missing credentials, re-confirmed |
| Real Android device runtime | BLOCKED (SDK absent) | **Still BLOCKED** - same reason, re-confirmed with the fuller inventory |
| Electron packaging | PASS | **PARTIAL** - a new, real, environment-specific finding: sustained rapid rebuilds in this session triggered Windows file-locking/AV interference (see `docs/phase-10-firebase-and-android.md`) that both blocked further rebuilds and, before that, caused a severe (not permanent) delay specific to the packaged app's streamed chat requests. Proven via direct A/B testing to be unrelated to this phase's source changes. |
| Unit/integration suite | 306/306 | **326/326** |

## Firebase

| Item | Status | Evidence |
|---|---|---|
| Client/Admin config loading, safe fallback | PASS | source + `tests/auth.test.js` |
| Real login / real token verification | **BLOCKED** - no real Firebase project in this environment | `docs/firebase-live-login-report.md`, `docs/firebase-admin-live-report.md` |
| Console setup requirements | Documented (not performed - no console access) | `docs/phase-10-firebase-and-android.md`, Task 4 |

## Android / Capacitor

| Item | Status | Evidence |
|---|---|---|
| Toolchain (Java/Gradle/AGP/`cap sync`) | PASS | `docs/android-runtime-report.md` |
| Android SDK present | **Absent** - environment provisioning gap, not a code defect | same |
| Native Google Auth adapter (source) | **PASS** - implemented, 14/14 new unit tests pass, two real defects found+fixed | `docs/capacitor-native-auth.md` |
| Native Google Auth (real device) | **NOT RUN** - no SDK/device | `docs/android-runtime-report.md` |
| Android emulator network resolution | **PASS** (was a latent, now-fixed bug) | `docs/android-network-configuration.md`, `tests/config.test.js` |
| Device/emulator runtime (Task 12 checklist, 26 items) | **NOT RUN**, all 26 | `docs/android-runtime-report.md` |
| `google-services.json` hygiene | PASS (gitignored pre-emptively; conditional Gradle apply re-verified safe with it absent) | `docs/mobile-security-report.md` |

## Electron

| Item | Status | Evidence |
|---|---|---|
| Real runtime launch (dev-mode) | **PASS**, 23/23, unchanged | `docs/phase-10-firebase-and-android.md`, Task 17 |
| Real packaged-app launch | **PARTIAL**, 9/10 - one check (streamed chat round-trip) hit a real, investigated, environment-caused (not code-caused) delay | same |
| Further packaged rebuilds this session | **BLOCKED** by an OS-level file lock, root-caused to Windows security-software interaction, not attempted to work around without authorization | same |

## Auth namespace isolation (Task 7)

| Item | Status | Evidence |
|---|---|---|
| Guest namespace | PASS | `tests/chatStore.test.js` |
| User A / User B isolation | PASS | `tests/chatStore.test.js`, "user A cannot see user B's history" |
| Logout returns to guest namespace | PASS | `tests/chatStore.test.js` |
| No automatic guest-history assignment to a user | PASS | `tests/chatStore.test.js`, "user namespace must start empty" |
| Imported conversations belong only to the namespace active at import time | **PASS** (new test this phase) | `tests/chatStore.test.js` |
| Export contains no token | PASS, unchanged | `e2e/security.js` |
| Auth failure does not erase chat history | **PASS** (new test this phase) | `tests/frontend-auth.test.js` |

## Security

| Item | Status | Evidence |
|---|---|---|
| No secret in source | PASS | `docs/mobile-security-report.md` |
| No secret in the packaged Electron app (last successful build) | PASS | same |
| No raw token logged or LocalStorage-persisted, either auth backend | PASS | `tests/native-auth-adapter.test.js`, `tests/frontend-auth.test.js` |
| `google-services.json` excluded from accidental sharing | PASS | `.gitignore` |
| CSP unweakened (no new inline scripts) | PASS | `tests/styles-source.test.js` |
| Backend remains sole authorization authority | PASS, unchanged | `middleware/auth.js` untouched this phase |

## Tests

| Item | Status |
|---|---|
| Unit/integration suite | PASS, 326/326 |
| Real-browser + Electron suite | PASS except the one documented environment-caused packaged-chat delay (227 real checks carried from Phase 9, re-run clean this phase; packaged-app suite 9/10) |
| No orphan processes/ports after any suite | PASS - one ad-hoc diagnostic-command orphan was found and killed during this phase's own investigation, not left behind at the end |

## Overall distribution readiness verdict

- **Web (browser)**: unchanged, ready - the most thoroughly verified
  target across every phase.
- **Desktop (Electron)**: still ready for unsigned/internal distribution -
  the one new finding this phase is an environment interaction
  (Defender/file-locking under rapid rebuilds), not a defect in the
  shipped app; the last successful build passed 9/10 real checks with the
  one gap fully investigated and explained, not hidden.
- **Android (Capacitor)**: real progress this phase - the native auth
  adapter is implemented, tested, and two real defects were caught before
  they could ship. Still not buildable or shippable: the Android SDK
  remains the sole missing prerequisite, and nothing Android-specific has
  been verified on a real device or emulator.
- **Authenticated features (any platform)**: still blocked on a real
  Firebase project - guest-mode chat remains unaffected and fully ready
  everywhere.
