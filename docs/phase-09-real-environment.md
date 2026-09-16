# Phase 9: Real Environment Verification and Distribution Readiness

This phase's mandate: verify as much as this real machine actually allows,
without rebuilding the architecture and without ever claiming a check ran
when it didn't. Where Phases 7-8 hit a hard environment wall (Electron
wouldn't launch at all, Android had no toolchain) and stopped at "NOT RUN /
BLOCKED", this phase pushed on those specific walls with real, reproducible
commands and either got past them for real or narrowed the blocker down to
its exact, named root cause.

## Mid-phase interruption: what "ENOTFOUND" actually was

Partway through this phase, the session was interrupted by `API Error:
Unable to connect to API (ENOTFOUND)` during the `npx electron-builder
--dir` packaging step. On resumption, this was investigated methodically
before anything else continued, per the explicit resumption instructions.

**Findings, in order:**

1. **`ENOTFOUND` is Node's own DNS-lookup error string format**
   (`Error: getaddrinfo ENOTFOUND <host>`). Node produces it; Go (which
   electron-builder's helper binary, `app-builder.exe`, is written in)
   produces a differently-formatted error for the same underlying failure:
   `dial tcp: lookup <host>: no such host`. This distinction matters because
   it means the literal string "ENOTFOUND" reported by the interrupted
   session is far more consistent with a break in the assistant's own
   connection to the Claude API (which *is* a Node process making HTTPS
   calls) than with electron-builder's Go-based download helper, which
   would have surfaced a different error string if it were the one that hit
   a DNS failure.
2. **No project code produces or handles a hostname lookup that could
   itself throw `ENOTFOUND`.** `server.js`, `main.js`, and every `www/*.js`
   file were checked - the only network calls are to `127.0.0.1`/`localhost`
   (never a DNS name) and to the OpenAI API (via the `openai` package, only
   from the backend, never during a build). Nothing in this project's own
   code path could produce a DNS lookup failure during an `electron-builder
   --dir` invocation.
3. **The build's own debug log (`dist/builder-debug.yml`) contains no
   error at all** - it's just the resolved file-inclusion pattern list,
   consistent with a build that completed its configuration phase. There is
   no leftover partial/corrupt output directory, no half-written `.asar`,
   no stale lockfile.
4. **Conclusion: the `ENOTFOUND` was very likely a transient interruption
   in the assistant-to-Claude-API connection, not a failure inside this
   project or inside electron-builder's own network access.** Per the
   resumption instructions, no code change was made on this basis alone -
   the investigation above is the full extent of what changed because of
   it.
5. **Retry, once, with network confirmed available:** `npx electron-builder
   --dir --publish never` was re-run after resumption. It completed with a
   real `dist/win-unpacked/LinguaHub AI.exe` and a real
   `resources/app.asar` - see `docs/electron-distribution-checklist.md` for
   the full build and launch verification. No lockfile was touched, no
   dependency was reinstalled - exactly the scoped, minimal retry the
   resumption instructions called for.
6. **Environment left clean:** `netstat` confirmed no listener on port
   3000 or port 5500 after every run this phase, and `tasklist`-equivalent
   process checks confirmed no orphaned `electron.exe`/`node.exe`/`LinguaHub
   AI.exe` processes at any point where the phase paused. Phases 1-8's work
   (all prior fixes, all prior regression suites, the Phase 8 packaging
   secret-exclusion fix) was preserved untouched throughout - re-confirmed
   directly this phase, see the final regression section below.

## Task 1: Environment audit

| Component | Version / status |
|---|---|
| Node.js | v24.18.0 |
| npm | 11.16.0 |
| Electron (devDependency) | 37.10.3 |
| electron-builder (devDependency) | 26.8.1 |
| @capacitor/core, @capacitor/android | 8.3.3 |
| Java (OpenJDK) | 21.0.11 LTS (Microsoft build) |
| Gradle (via project's own wrapper) | 8.14.3 - downloads and runs correctly |
| Android Gradle Plugin (declared in `android/build.gradle`) | 8.13.0 - resolves correctly from network |
| Android SDK | **absent** - see Task 7 |
| iOS platform | not installed (`@capacitor/ios` is not a dependency) - out of scope, unchanged from prior phases |

`ELECTRON_RUN_AS_NODE` origin (re-confirmed this phase): present in every
process this session's tools spawn (both the Bash/Git-Bash tool and a
separately-invoked PowerShell session both inherit it as `1`), but **not** a
persistent Windows User or Machine environment variable -
`[Environment]::GetEnvironmentVariable("ELECTRON_RUN_AS_NODE", "User"/
"Machine")` both return empty. It is injected into this specific process
tree only (almost certainly a deliberate guardrail against an agent sandbox
accidentally spawning a real GUI window), not a system-wide or project
setting. This is why a **scoped override** - passing a copy of
`process.env` with only that one key deleted to a specific child-process
launch - is the correct fix: it does not touch any system-wide or
persistent configuration, and it only ever affects the one process the
override is explicitly passed to.

## Task 2 & 3: Firebase checkpoint and real login

Re-checked directly this phase, same method as Phases 7-8:

```
$ node -e "require('dotenv').config(); ['FIREBASE_PROJECT_ID','FIREBASE_CLIENT_EMAIL','FIREBASE_PRIVATE_KEY','GOOGLE_APPLICATION_CREDENTIALS'].forEach(k => console.log(k, process.env[k] ? 'set' : 'unset'))"
FIREBASE_PROJECT_ID unset
FIREBASE_CLIENT_EMAIL unset
FIREBASE_PRIVATE_KEY unset
GOOGLE_APPLICATION_CREDENTIALS unset
```

No real Firebase project is configured in this environment, and none was
provided this phase. **Real login: NOT RUN, same as every prior phase, for
the same reason.** See `docs/firebase-production-checklist.md` for the full
checkpoint and what a real pass will need.

## Task 4 & 5: Electron environment fix and real runtime verification

Fully covered in `docs/electron-distribution-checklist.md`. Summary: the
scoped `ELECTRON_RUN_AS_NODE` override works, a real `BrowserWindow` opens,
a real chat round-trip completes end-to-end through the real OpenAI
provider, and 23/23 real runtime checks pass - including finding and fixing
a real bug (Export silently failing under Electron due to a `blob:`-URL
download limitation).

## Task 6: Electron package build

Fully covered in `docs/electron-distribution-checklist.md`. Summary: `npx
electron-builder --dir --publish never` completed for real this phase,
producing a real `dist/win-unpacked/LinguaHub AI.exe` (containing the
Phase 8 secret-exclusion fix, re-verified intact). The packaged app was
launched for real and passed 10/10 checks, including a real chat
round-trip from inside the packaged `app.asar`.

## Task 7 & 8: Android toolchain and real Capacitor Android attempt

Fully covered in `docs/android-capacitor-checklist.md`. Summary: Java,
Gradle, the Android Gradle Plugin, and Capacitor's own CLI (`npx cap sync
android`) all work correctly on this machine. The one and only missing
piece, confirmed by a real `assembleDebug` invocation's own error message,
is the Android SDK itself - not installed, and `android/local.properties`
references a stale path from a different Windows user profile that doesn't
exist on this filesystem.

## Task 9: Capacitor Google Auth strategy - final decision

Fully covered in `docs/android-capacitor-checklist.md`. **Decision (single,
final): `@capacitor-firebase/authentication`**, used only on native
platforms (`Capacitor.isNativePlatform()`), with the existing
`www/auth.js` Web SDK popup/redirect flow kept unchanged for the browser
and Electron targets. Not installed this phase - there is no Android SDK
or device in this environment to validate a real native-auth integration
against, and installing untested native-auth code would violate this
phase's own rule against claiming unverifiable work as done.

## Task 10: Screen-reader readiness

**NOT RUN**, more precisely than Phase 8's classification. Phase 8 stated
"no screen reader is available in this environment" - re-checked this
phase, that's not quite exact: **Windows Narrator is present as OS-bundled
software** (`C:\Windows\System32\Narrator.exe` exists), but no NVDA or JAWS
is installed, and more importantly, **this automation session has no way
to drive or interpret any screen reader's output** - there is no audio
capture channel, no interactive desktop session guaranteed, and no
speech-to-text bridge available to this agent. The blocker is the
automation environment's I/O surface, not the absence of screen-reader
software. This doesn't change the practical result (still NOT RUN), but it
is the more accurate root cause. See `docs/accessibility-final-report.md`
(Phase 8) for the full automated-accessibility results, which remain valid
and were re-confirmed passing this phase (18/18, re-run as part of the
final regression below).

## Task 11: Release security scan

Fully covered in `docs/secret-scan-report.md`. Summary: 1,697 raw pattern
matches across source and the real packaged `app.asar`; every single one
was manually reviewed. 1,695 are third-party `.js.map` source maps (2 in
vendored frontend libraries, 1,693 inside packaged `node_modules`
dependencies) - not secrets. 1 is a self-referential false positive (the
scanner's own detection-regex literal, present inside
`e2e/security.js`'s test source, not an embedded key). 1 is the expected
`.env` filename marker. **Zero real secrets found in source or in the real
packaged build.**

## Task 12: Final regression

Every real-browser and Electron suite was re-run this phase, after the
resumption, against the final state of the code:

| Suite | Result |
|---|---|
| `e2e/smoke.js` | 38/38 |
| `e2e/responsive.js` | 38/38 |
| `e2e/keyboard.js` | 26/26 |
| `e2e/network-failures.js` | 15/15 |
| `e2e/empty-state.js` | 8/8 |
| `e2e/accessibility.js` | 18/18 |
| `e2e/security.js` | 22/22 |
| `e2e/auth-error-matrix.js` | 7/7 |
| `e2e/performance.js` | 7/7 |
| `e2e/storage.js` | 15/15 |
| `e2e/electron.js` (real Electron runtime) | 23/23 |
| `e2e/electron-packaged.js` (real packaged app) | 10/10 |

**227/227 real-browser and Electron checks pass. Zero failures.** No orphan
process or listener on port 3000/5500 was left behind after any suite
(checked directly after each run). Phases 1-8's fixes were all
re-exercised as part of this run and remain intact - nothing regressed.

## Task 13: Distribution readiness

See `docs/final-release-matrix.md` for the complete, phase-spanning
PASS/PARTIAL/BLOCKED/NOT RUN/FAIL matrix.

## Task 14: Documentation

This document, plus `docs/firebase-production-checklist.md`,
`docs/electron-distribution-checklist.md`,
`docs/android-capacitor-checklist.md`, `docs/secret-scan-report.md`, and
`docs/final-release-matrix.md` are new this phase. `README.md`,
`docs/release-readiness-checklist.md`, and `docs/firebase-setup.md` were
updated to reflect this phase's findings (see each for what changed).
`.env.example` was reviewed and needs no changes - no new environment
variable was introduced this phase.
