# Mobile Security Report (Phase 10, Task 15)

## Secret scan: re-run this phase, zero new real secrets

```
$ node e2e/secret-scan.js
Total findings: 1698
```

| Category | Count | Disposition |
|---|---|---|
| `.js.map` source maps | 1695 | Unchanged from Phase 9 - third-party library maps (vendored frontend libs + packaged `node_modules` dependencies). Not secrets. None of this phase's new vendor files (`capacitor-core.js`, `capacitor-firebase-authentication.js`, `capacitor-firebase-auth-stub.js`) were copied with an accompanying `.js.map` - confirmed zero new source-map findings from them. |
| "Firebase private key block" | 2 | Both false positives, both self-referential: `e2e/security.js` (the scanner's own detection regex, unchanged from Phase 9) and, new this phase, `docs/secret-scan-report.md` (this project's own Phase 9 documentation describing that same false positive - it quotes the pattern in prose, it doesn't contain a key). |
| `.env` filename | 1 | Expected, unchanged. |

**Zero** OpenAI-key-shaped strings, AWS keys, database credentials, real
service-account emails, or raw JWT-shaped tokens anywhere in source. The
built Electron artifact scanned here is the one produced earlier this
phase (before an unrelated Windows file-locking issue blocked further
rebuilds - see `docs/phase-10-firebase-and-android.md`) but already
contains every Phase 10 source change; re-run `node e2e/secret-scan.js`
again after the next successful rebuild to re-confirm.

## No secret in the native Android auth adapter

`www/auth.js`'s new native backend and `tests/native-auth-adapter.test.js`
were specifically checked for the two Phase 10 rules that don't apply to
pattern-scanning alone:

- **No raw ID token ever logged**: every `console.*` call in `www/auth.js`
  was enumerated and checked individually (stripping quoted string labels
  first, so a message like `"...fresh native ID token:"` doesn't
  false-positive on the word "token") - none references a bare token
  value. Locked in by a dedicated structural test.
- **No token written to LocalStorage, by either backend**: `www/auth.js`
  contains no `localStorage.setItem` call at all (checked via regex across
  the whole file, both backends) - session state lives only in Firebase's
  own storage (web) or in an in-memory cache updated by the native
  plugin's auth-state listener (native), never in this app's own
  LocalStorage.

## Android/Firebase configuration hygiene

| Check | Status |
|---|---|
| `google-services.json` present in the repo | No (not obtained this phase - no real Firebase project) |
| `google-services.json` excluded from accidental sharing | ✅ added to `.gitignore` (`android/app/google-services.json`) this phase, before any real file would ever be placed there |
| `google-services.json` vs Firebase Admin credentials confusion | Not conflated - `google-services.json` is Android/Firebase **client** configuration (project-identifying, similar sensitivity class to `www/firebase-config.js`'s public values); it contains no private key and is unrelated to `GOOGLE_APPLICATION_CREDENTIALS`/the Admin service-account JSON, which remains covered by the pre-existing `.gitignore` patterns (`serviceAccountKey.json`, `*-firebase-adminsdk-*.json`, `*.serviceaccount.json`) |
| SHA-1/SHA-256 fingerprint requirements | Documented in `docs/capacitor-native-auth.md` and `docs/android-capacitor-checklist.md` (Phase 9) - not yet registered, no real Firebase project exists to register them against |
| `android/app/build.gradle`'s conditional `google-services` plugin apply | Pre-existing (before this phase), re-verified: only applies the plugin `if google-services.json exists and is non-empty` - a missing file does not break the build, confirmed by this phase's real `./gradlew tasks`/`assembleDebug` runs (both got past this line without issue) |
| No Admin private key anywhere in the Android package | ✅ confirmed by source review - nothing under `android/` references `FIREBASE_PRIVATE_KEY`/`GOOGLE_APPLICATION_CREDENTIALS`, both server-only Node env vars that never reach any frontend or Android asset |

## Re-verified, unchanged security controls (all still active, all re-tested this phase)

| Control | Status | Evidence |
|---|---|---|
| No OpenAI key in frontend source | ✅ | `e2e/security.js`, re-run this phase, 22/22 |
| CORS allowlist enforced | ✅ | `tests/server.test.js`, `e2e/security.js` |
| Helmet headers (CSP, nosniff, frame-ancestors) | ✅ unchanged | `e2e/security.js` |
| Rate limiting | ✅ | `e2e/security.js` (real 429 triggered) |
| Backend token verification remains the sole source of authorization (never the mobile client) | ✅ | `middleware/auth.js` unchanged this phase - confirmed by direct re-read; the native adapter only ever *obtains* a token, never decides what it's allowed to do |
| Disabled AI modes (Image/Voice/Web Search) remain honestly disabled | ✅ unchanged | `e2e/security.js` |
| Imported HTML/Markdown cannot execute scripts | ✅ unchanged | `e2e/security.js` |
| CSP has no `unsafe-inline`/`unsafe-eval` | ✅ - and re-verified this phase's new inline-script temptation was avoided: the `firebaseAuthExports` stub was moved to an external same-origin file specifically to keep this true (see `docs/capacitor-native-auth.md`) | `e2e/security.js`, `tests/styles-source.test.js` |
| Android network configuration does not weaken production security | ✅ - the `10.0.2.2` emulator-only fix (`docs/android-network-configuration.md`) is scoped to Android's default WebView origin only, has no effect on Electron/iOS/web, and does not touch CORS, CSP, or any production URL path | `tests/config.test.js` |
| Debug settings don't leak into release configuration | Partially open - see `docs/android-network-configuration.md`'s "production must set an explicit override" section: this is a genuine, documented pre-launch requirement for Android, not something silently handled. Cleartext-HTTP blocking is Android's own secure-by-default behavior (re-confirmed, unchanged) |

## Electron packaging and this environment's antivirus interaction

Investigated during this phase's regression testing (see
`docs/phase-10-firebase-and-android.md` for the full trace): repeated,
rapid `electron-builder --dir` rebuilds in this session eventually hit a
real, OS-level file lock (`Device or resource busy`) on the packaged
`app.asar`, with Windows Defender's real-time protection, antivirus, and
behavior monitoring all confirmed enabled on this machine
(`Get-MpComputerStatus`). This is a genuine external environment
interaction (most likely real-time scanning of a freshly-written,
unsigned executable and its bundled archive), not a code-level security
issue - and not something this phase attempted to work around by
disabling or excluding from Defender, which would require admin
privileges and explicit authorization neither available nor sought.
