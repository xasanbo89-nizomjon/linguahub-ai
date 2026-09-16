# Android / Capacitor Checklist (Phase 9)

**Updated in Phase 10**: the Google Auth strategy decided below
(`@capacitor-firebase/authentication`) has now been **installed and
implemented** - see `docs/capacitor-native-auth.md` for the adapter, the
two real integration defects found and fixed along the way, and what
remains unverified (a real device). The Android SDK/toolchain findings
below were re-confirmed unchanged in Phase 10 with a fuller inventory -
see `docs/android-runtime-report.md`. A real network-configuration bug
(Android emulator couldn't reach the dev backend's `127.0.0.1` default)
was also found and fixed this phase - see
`docs/android-network-configuration.md`.

## Status: toolchain works up to the SDK itself, which is genuinely absent

Prior phases reported "no Android tooling available" without pinpointing
exactly which layer was missing. This phase ran the real tools and
narrowed it down precisely.

## Toolchain audit (Task 7), each step run for real

| Layer | Result |
|---|---|
| Java | `openjdk version "21.0.11"` (Microsoft build) - present and working |
| Gradle wrapper (`android/gradlew`) | downloads and runs correctly: `Downloading https://services.gradle.org/distributions/gradle-8.14.3-all.zip` completed, real Gradle Daemon started |
| Android Gradle Plugin (`com.android.tools.build:gradle:8.13.0`) | resolves correctly from Google's Maven repo over network |
| `com.google.gms:google-services:4.4.4` | resolves correctly |
| `./gradlew tasks` | **BUILD SUCCESSFUL in 1m 5s** - real task graph configured and listed |
| `npx cap sync android` | **succeeds**: copies `www/` into `android/app/src/main/assets/public`, regenerates `android/app/src/main/assets/capacitor.config.json`, updates Android plugins |
| `adb`, `emulator` | not found on PATH |
| `ANDROID_HOME` / `ANDROID_SDK_ROOT` | both unset |
| `android/local.properties` | `sdk.dir=C:\Users\Hp\AppData\Local\Android\Sdk` - a stale path from a **different Windows user profile**; confirmed this directory does not exist anywhere on this filesystem |

**Corrected first attempt**: an initial `./gradlew tasks --offline` run
failed on `Could not resolve com.android.tools.build:gradle:8.13.0 ...
No cached version ... available for offline mode` - that failure was an
artifact of the `--offline` flag added for this check, not a real project
or environment problem. Retried without `--offline`; it succeeded
(confirms the network is available and Google's Maven repo is reachable).

## Real build attempt (Task 8)

```
$ ./gradlew assembleDebug --stacktrace
...
Caused by: com.android.builder.errors.EvalIssueException: SDK location not
found. Define a valid SDK location with an ANDROID_HOME environment
variable or by setting the sdk.dir path in your project's local
properties file at '...\android\local.properties'.
BUILD FAILED in 2s
```

This is the exact, real, root-cause error, thrown by the Android Gradle
Plugin's own `SdkLocator`. It confirms precisely what's missing: **not**
Java, **not** Gradle, **not** the Android Gradle Plugin, **not**
Capacitor's own sync step - only the physical Android SDK installation
(platform tools, platforms, build-tools) itself. Interesting and worth
recording: `./gradlew tasks` succeeds even with an invalid `sdk.dir`,
because AGP's project-configuration phase doesn't eagerly validate the SDK
location - only a task that actually needs SDK components (`assembleDebug`,
`lint`, etc.) triggers the check. This is why "tasks" listing alone would
have been a misleading signal of readiness on its own; running an actual
build task was necessary to get the real, final answer.

**Classification: BLOCKED**, not NOT RUN - a real build was attempted, and
the exact, single missing prerequisite was identified directly from the
tool's own error message, not inferred.

## Configuration audit (carried forward from Phase 8, re-confirmed unchanged)

| Item | Finding |
|---|---|
| `appId` | `com.xasan.ai` - pre-rename leftover, cosmetic, not changed (same reasoning as `package.json`'s `build.appId`) |
| `appName` | `LinguaHub AI` - correct |
| `webDir` | `www` - verified to exist, `tests/capacitor-config.test.js` passing |
| `server.url` | unset (uses Capacitor's default bundled-webview origin) - `www/config.js`'s `computeApiBase()` already handles `capacitor://localhost` (iOS) and `https://localhost` (Android default) |
| Cleartext HTTP | blocked by Android default (API 28+) - no `usesCleartextTraffic` override exists; a real concrete gap for local dev against an `http://` backend from a device/emulator, not fixed (touches native Android XML, unverifiable without a device) |
| CORS | `server.js`'s `DEFAULT_ALLOWED_ORIGINS` already includes `capacitor://localhost` and `http://localhost` |

## Google Auth strategy (Task 9) - final decision

**Decided: `@capacitor-firebase/authentication`**, used only on native
platforms, guarded by `Capacitor.isNativePlatform()`. This is now the
single, final chosen strategy (elevated from Phase 8's "recommended" to a
committed decision, per this phase's requirement to choose exactly one).

**Why this one, not an alternative:**

- It wraps each platform's real native Firebase Auth SDK and uses the
  platform's native Google account picker, which entirely avoids Google's
  restriction on OAuth inside embedded WebViews (the reason a raw
  `signInWithPopup`/`signInWithRedirect` - what `www/auth.js` currently
  uses - is not safe to rely on inside a Capacitor Android WebView).
- It returns a **standard Firebase user/ID token**, so the existing
  backend verification path (`middleware/auth.js` →
  `firebaseAdmin.verifyIdToken`) needs **zero changes** - confirmed by
  reading `middleware/auth.js`: it verifies any valid Firebase ID token
  regardless of how the client obtained it.
- The existing `www/auth.js` Web SDK flow (popup → redirect fallback)
  stays completely unchanged for the browser and Electron targets - the
  native plugin is additive and platform-gated, not a replacement.
- Alternatives considered and rejected: a raw system-browser +
  custom-URL-scheme DIY flow would need its own deep-link/App-Link
  registration and native `MainActivity` handling for no benefit over an
  existing, maintained plugin; a generic (non-Firebase-specific) native
  Google Sign-In plugin would require a manual
  `GoogleAuthProvider.credential(idToken)` exchange step that
  `@capacitor-firebase/authentication` already does internally.

**Update (Phase 10): installed and implemented.** See
`docs/capacitor-native-auth.md` for the real adapter, the compatibility
verification done before writing it, and two real integration defects
found and fixed along the way. No Android SDK or device still exists in
this environment to validate it against a real sign-in - that remains
NOT RUN, stated plainly in that document, not implied by the code
existing.

**What that future implementation will need** (documented now so it isn't
a surprise later):

- **Android**: the signing keystore's SHA-1 and SHA-256 fingerprints
  (`keytool -list -v -keystore <path>`) registered in Firebase Console
  (Project settings → Your apps → Android app). Debug and release
  keystores have different fingerprints; both need registering during
  development.
- **Android**: `google-services.json` (from Firebase Console) placed in
  `android/app/`.
- **iOS** (not currently part of this project): would need the reversed
  client ID from `GoogleService-Info.plist` registered as a URL scheme -
  irrelevant until `@capacitor/ios` is actually added.
- Install: `npm install @capacitor-firebase/authentication`, then `npx cap
  sync android`.
- Code change scope: one new conditional branch in `www/auth.js`'s
  `signInWithGoogle()` - `if (window.Capacitor && Capacitor.isNativePlatform())
  { /* native plugin path */ } else { /* existing popup/redirect path,
  unchanged */ }`. No backend change.

## Runtime verification (Task 8, device/emulator half): NOT RUN

No Android SDK, emulator, or connected device exists in this environment
(confirmed above). Sync succeeds (`npx cap sync android`); actual app
launch, chat/streaming, theme, drawer, keyboard, storage, import/export,
and the "no port 5500 request" check on a real device/emulator are all
**NOT RUN**. The "no port 5500" property specifically is, however, verified
in every real-browser and real-Electron suite this project has, through the
exact same `www/config.js` origin-resolution logic a Capacitor WebView
would use - a reasonable, not identical, proxy, explicitly labeled as such.

## Summary

| Layer | Status |
|---|---|
| Java | working |
| Gradle wrapper | working, real network download confirmed |
| Android Gradle Plugin / google-services plugin resolution | working |
| Capacitor CLI (`cap sync`) | working |
| Android SDK | **absent** - exact error captured directly from `assembleDebug` |
| Real device/emulator runtime | NOT RUN - no SDK, no device |
| Google Auth strategy | **decided**: `@capacitor-firebase/authentication`, not yet installed |
