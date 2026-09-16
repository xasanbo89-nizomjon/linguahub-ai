# Capacitor Native Google Authentication (Phase 10)

## Decision (carried forward from Phase 9, now implemented): `@capacitor-firebase/authentication`

Phase 9 finalized this as the single chosen strategy and documented why
(`docs/android-capacitor-checklist.md`): embedded-WebView OAuth popups are
not production-safe on Android, and this plugin uses each platform's real
native Firebase Auth SDK (Android's Credential Manager / Google Sign-In)
instead. This phase installed it for real and implemented the adapter.

```
$ npm view @capacitor-firebase/authentication peerDependencies --json
{ "@capacitor/core": ">=8.0.0", "firebase": "^12.6.0" }
$ npm install @capacitor-firebase/authentication --save-exact
added 1 package
```

Installed at the exact pinned version `8.3.0`, compatible with this
project's `@capacitor/core@^8.3.3`.

## Compatibility verification (done before writing any adapter code)

| Check | Finding |
|---|---|
| Capacitor major version | `8.3.0` plugin requires `@capacitor/core >=8.0.0` - this project has `8.3.3`. Compatible. |
| Firebase JavaScript SDK | The plugin's peer dependency is the **modular** `firebase` npm package (`^12.6.0`) - this project's web frontend uses the **compat** SDK (`firebase-app-compat.js`/`firebase-auth-compat.js`, loaded via `<script>`, no npm `firebase` package at all). These are different, incompatible APIs. Resolved by never loading the modular SDK at all - see "No bundler, and why that's fine" below. |
| Android Gradle Plugin | The plugin's own `android/build.gradle` declares `compileSdk`/`minSdk`/`targetSdk` via `rootProject.ext` fallbacks matching this project's `android/variables.gradle` (36/24/36) - compatible, no version mismatch. |
| Android package | `android/app/build.gradle` already had a **conditional** `google-services` plugin apply block (`if google-services.json exists`) from before this phase - already compatible, no change needed there. |
| Frontend auth service (`www/auth.js`) | Uses the Firebase **compat** SDK's `firebase.auth()` object model (`signInWithPopup`, `onAuthStateChanged(callback)`, synchronous `auth.currentUser`). The native plugin's API is entirely different (promise-based `getCurrentUser()`, `addListener('authStateChange', cb)`, `photoUrl` instead of `photoURL`) - required a real adapter layer, not a drop-in swap. See below. |

## No bundler, and why that's fine

This project has no bundler (a deliberate, unchanged architecture decision -
see `README.md`). `@capacitor-firebase/authentication`'s npm package still
ships a browser-ready IIFE build for exactly this case:

```
$ node -e "const p = require('./node_modules/@capacitor-firebase/authentication/package.json'); console.log(p.unpkg)"
dist/plugin.js
```

Vendored locally (`www/vendor/capacitor-firebase-authentication.js`), same
pattern as `marked.umd.js`/`purify.min.js` - same-origin, no CDN, no CSP
change. Also vendored: `@capacitor/core`'s own browser bundle
(`www/vendor/capacitor-core.js`), needed so `window.Capacitor.isNativePlatform()`
etc. are available at all (on native Android, the runtime already injects
`window.Capacitor` itself, but this vendored copy is what makes the same
detection code work identically for a plain browser/Electron test run,
where no native bridge exists). Verified this doesn't clobber an
already-present native bridge before vendoring it - the bundle's own source
does `r = t.Capacitor || {}`, merging onto rather than replacing any
existing `window.Capacitor`.

**The `firebaseAuthExports` gap**: `dist/plugin.js` is built as
`(function (exports, core, auth) { ... })({}, capacitorExports, firebaseAuthExports)`
- it expects a `firebaseAuthExports` global (the modular Firebase Auth SDK)
to already exist, because the bundle also contains the plugin's *web-fallback*
implementation (used when running in a plain browser with no native
bridge). Reading the bundle's own source before vendoring it confirmed this
web-fallback code (`FirebaseAuthenticationWeb`, which calls `auth.getAuth()`
etc.) is only ever constructed by Capacitor's own plugin bridge when
`registerPlugin`'s lazy factory is invoked on a **non-native** platform -
this project's adapter never calls into that path (native Android only,
gated by `Capacitor.isNativePlatform() && Capacitor.getPlatform() ===
"android"`). A small first-party stub
(`www/vendor/capacitor-firebase-auth-stub.js`, NOT vendored from npm, own
header comment explains why) sets `window.firebaseAuthExports = {}` purely
so the bundle doesn't throw a `ReferenceError` while parsing - it is never
functionally exercised. This is a genuinely inert file, not a hidden
dependency on the modular SDK.

## The `photoUrl` vs `photoURL` mismatch (found and fixed)

The plugin's `User` type uses `photoUrl` (lowercase "url"). Every other
part of this app (`www/app.js`'s `renderSignedIn()`, `www/settings-ui.js`)
already reads the Firebase compat SDK's `photoURL` (capital "URL"). Left
unhandled, every native-Android sign-in would have silently shown no
avatar. Fixed by normalizing in the adapter (`normalizeNativeUser()` in
`www/auth.js`) - callers only ever see `photoURL`, regardless of backend.
Covered by a dedicated test (`tests/native-auth-adapter.test.js`).

## The Gradle `rgcfaIncludeGoogle` gate (found and fixed)

`@capacitor-firebase/authentication`'s own `android/build.gradle` compiles
its real Google Sign-In dependencies (`play-services-auth`,
`androidx.credentials`, `googleid`) as `implementation` only when
`rootProject.ext.rgcfaIncludeGoogle == true` - the default is `false`,
which compiles them as `compileOnly` (present at compile time, **not
packaged into the APK**). Left unset, the app would have compiled
successfully and then thrown a missing-class error the first time a real
device tried to sign in - a defect that source review alone (without
reading the plugin's own Gradle file) would not have caught. Fixed by
adding `rgcfaIncludeGoogle = true` (and `rgcfaIncludeFacebook = false`,
since this app has no Facebook login) to `android/variables.gradle`.

## The adapter (`www/auth.js`)

One public interface (`window.LinguaHubAuth`), two backends, selected once
at load time via `Capacitor.isNativePlatform() && Capacitor.getPlatform()
=== "android"` - never re-evaluated mid-session ("no duplicate signed-in
states"):

- **Web** (browser, Electron, and Capacitor iOS should this project ever
  add it): the existing Firebase compat SDK popup/redirect flow, entirely
  unchanged from Phase 1-9.
- **Native Android**: `capacitorFirebaseAuthentication.FirebaseAuthentication`
  - `signInWithGoogle()` calls the native plugin directly (never a WebView
    popup); `onAuthStateChanged()` primes from `getCurrentUser()` and then
    subscribes to the plugin's `authStateChange` listener; `getIdToken()`
    calls the plugin's `getIdToken()`; `signOutUser()` calls the plugin's
    `signOut()`; `completeRedirectSignIn()` is a safe no-op (native
    sign-in never navigates the page).

**The synchronous `getCurrentUser()` contract, preserved across an async
backend**: `www/app.js`'s `buildAuthHeaders()` (and other callers) call
`LinguaHubAuth.getCurrentUser()` synchronously, exactly like the Firebase
compat SDK's synchronous `auth.currentUser`. The native plugin's
equivalent is `Promise<GetCurrentUserResult>` - genuinely async. Resolved
the same way the *existing* web backend already resolves an equivalent
race (a fresh page load before Firebase's own async session restore
completes): an in-memory `cachedNativeUser` variable, primed once via an
async `getCurrentUser()` call and kept current via the `authStateChange`
listener, both wired up inside `onAuthStateChanged()` - exactly the
function `www/auth.js`'s own header comment already documents as "the
single source of truth" for this app. `getCurrentUser()` itself stays a
plain synchronous read of that cache - no public function signature
changed.

## `capacitor.config.json`

```json
"plugins": {
  "FirebaseAuthentication": {
    "skipNativeAuth": false,
    "providers": ["google.com"]
  }
}
```

`skipNativeAuth: false` (native auth is the entire point of this
decision). `providers: ["google.com"]` only - this app has no Apple/
Facebook/GitHub/Microsoft/Play Games/Twitter/Yahoo/phone sign-in, and
loading those SDKs unnecessarily would both bloat the APK and initialize
third-party SDKs this app never uses (the plugin's own README explicitly
warns these "can initialize on their own and collect various data").
Locked in by `tests/capacitor-config.test.js`.

## Backend: zero changes needed

`middleware/auth.js`'s `firebaseAdmin.verifyIdToken()` verifies any valid
Firebase ID token cryptographically - it has no way to know (and does not
need to know) whether the client obtained it via a browser popup or a
native Credential Manager sheet. Confirmed by re-reading the middleware
source; no backend code was touched for this phase's auth work.
Authorization decisions remain entirely server-side, per this phase's
explicit rule.

## What remains genuinely unverified

Everything above is real, shipped source code, covered by 14 new unit
tests (`tests/native-auth-adapter.test.js`) that run the actual
`www/auth.js` source in a sandboxed environment with a fake native plugin
bridge. **None of it has been exercised on a real Android device or
emulator** - no Android SDK exists in this environment (see
`docs/android-runtime-report.md`). This is stated plainly: the adapter is
implemented and structurally tested, not device-verified. A real device
run is the next required step before this can be trusted for a release.
