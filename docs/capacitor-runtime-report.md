# Capacitor Runtime Report (Phase 8)

## Status: source-verified only — device/emulator runtime NOT RUN

Re-checked at the start of Phase 8, same result as Phase 7:

```
$ which adb          # not found
$ which emulator     # not found
$ echo $ANDROID_HOME       # empty
$ echo $ANDROID_SDK_ROOT   # empty
```

No Android SDK, emulator, or connected device is available in this environment. Nothing beyond source review and configuration validation was possible. This is stated plainly, not implied by omission.

## Configuration audit (Task 8)

| Item | Finding |
|---|---|
| `appId` | `com.xasan.ai` - a pre-rename leftover (project was renamed to LinguaHub AI in Phase 1; this identifier wasn't). Cosmetic, no functional impact, not changed (same decision as `package.json`'s `build.appId`, which shares the same value and the same reasoning). |
| `appName` | `LinguaHub AI` - correct, matches the current product name. |
| `webDir` | `www` - verified to exist and contain a real `index.html` (new: `tests/capacitor-config.test.js`, "webDir points at the real, existing frontend directory"). |
| `server.url` | Not set (no override) - the app uses Capacitor's default bundled-webview origin, which is exactly what `www/config.js`'s `computeApiBase()` special-cases (`capacitor://localhost` for iOS, `https://localhost` with no port for Android's default). New regression test confirms this stays unset (`tests/capacitor-config.test.js`). |
| Allowed navigation | No custom `allowNavigation` config exists; not needed since the app makes no cross-origin page navigations, only `fetch()` calls to the backend (governed by CORS, not Capacitor's navigation allowlist). |
| Cleartext dev settings | `android/app/src/main/AndroidManifest.xml` sets no `android:usesCleartextTraffic` and references no custom `network_security_config.xml` → Android's own default applies: **cleartext HTTP is blocked by default on API 28+.** This is a real, concrete, unresolved gap for local development specifically (connecting an emulator/device to a local `http://` dev backend would need an explicit dev-only network security config) - documented, not fixed, since it can't be verified without a real device and touches native Android XML this project has never needed before. |
| HTTPS production requirement | Satisfied by the same Android default (cleartext blocked) as long as the production backend is actually served over HTTPS - an infrastructure decision outside this project's source. |
| Safe-area handling | No `env(safe-area-inset-*)` CSS exists anywhere (confirmed by direct search of `www/*.css`). Matters most for iOS (not installed in this project - see below); lower-impact but not zero for Android gesture-navigation devices. Documented as a known gap, not fixed (no device to verify against). |
| Keyboard resize | No `@capacitor/keyboard` plugin is installed - relies entirely on the platform WebView's default resize behavior. Not verified on a device. |
| Status bar | No `@capacitor/status-bar` plugin is installed - default system status bar styling applies. Not verified on a device. |
| Storage | Plain `localStorage` (`www/chatStore.js`), backed by the platform WebView's own storage; subject to the OS's normal app-data eviction under storage pressure. `chatStore`'s proactive pruning (`LIMITS.maxNamespaceBytes`) mitigates but doesn't eliminate this - unchanged from Phase 7, still correct. |
| Clipboard | Standard `navigator.clipboard` Web API; Capacitor's WebView supports it (some Android WebView versions require foreground focus / may prompt on first use) - not verified on a device. |
| File export/import | `Blob` + `<a download>` (export) and a real `<input type=file>` `change` event (import) - both standard Web APIs, delegated to the platform's native handling by the WebView. Not verified on a device. |
| Network behavior / CORS | `server.js`'s `DEFAULT_ALLOWED_ORIGINS` already includes `capacitor://localhost` and `http://localhost` (the two origins Capacitor's default iOS/Android WebView use) - confirmed present in source, re-confirmed by `tests/server.test.js` (unchanged, still passing). |
| Mode API | `GET /api/ai/modes` and `/api/chat*` are plain HTTPS/HTTP JSON+SSE endpoints with no browser-specific assumptions - nothing about them is Capacitor-incompatible. Not verified from an actual Capacitor WebView. |
| Auth limitations | See "Google auth strategy" below. |

## Runtime verification (Task 8, second half): NOT RUN

Sync, build, emulator/device run, and every item in the device-testing checklist (chat, streaming, themes, drawer, keyboard, storage, import/export, no-port-5500-request) are **NOT RUN** - no Android tooling exists in this environment. The "no port 5500 request" property is, however, verified in every real-browser suite this project has (`e2e/smoke.js` et al.) via the exact same `config.js` logic Capacitor's WebView would use, so it's a reasonable (not identical) proxy for that specific check, honestly labeled as **not a substitute** for a real device run.

## Google auth strategy (Task 9)

**Do not treat embedded-WebView popup/redirect OAuth as production-safe on Capacitor.** This project's frontend (`www/auth.js`) currently has only that path (the Firebase Web SDK's `signInWithPopup`/`signInWithRedirect`), which is known to be unreliable inside Android/iOS WebViews (Google has progressively restricted OAuth inside embedded WebViews for phishing-prevention reasons; behavior varies by Android WebView version and isn't guaranteed to keep working).

**Recommended strategy: `@capacitor-firebase/authentication`** (a native bridge to each platform's real Firebase Auth SDK, using the platform's native Google account picker instead of a WebView popup) for native builds, falling back to the existing Web SDK flow for the plain-browser and Electron targets (which don't have the WebView-OAuth restriction). This is the standard, widely-used approach for Capacitor + Firebase Google sign-in.

**Not installed in this phase** - the phase's instructions are explicit that no plugin should be added without a real decision to ship it, and this project currently has no iOS platform and no Android device to validate a real native-auth integration against. This is a recommendation for a future phase, not a completed change.

What a future integration will need, documented in advance so it isn't a surprise:

- **Android**: the app's **SHA-1 and SHA-256 signing certificate fingerprints** (from the keystore that will actually sign release builds - `keytool -list -v -keystore <path>`) must be registered in the Firebase Console (Project settings → Your apps → Android app → SHA certificate fingerprints) *before* native Google sign-in will work on that build. Debug and release keystores have different fingerprints and both need registering during development.
- **Android**: the app's `google-services.json` (downloaded from Firebase Console, project-specific, not a secret in the same sense as an Admin key but still shouldn't be committed to a public repo without consideration) needs to be placed in `android/app/`.
- **iOS** (not currently part of this project - `@capacitor/ios` isn't installed): would need the **reversed client ID** (from `GoogleService-Info.plist`, format `com.googleusercontent.apps.XXXXXXXX`) registered as a custom URL scheme in `Info.plist`, plus the same Firebase project's iOS app configured in the Console.
- **Redirect/deep-link requirements**: `@capacitor-firebase/authentication` (and most native-bridge alternatives) use the platform's own native flow rather than a redirect URL scheme the app has to register itself, which is exactly why it avoids the WebView-OAuth problem - unlike a raw "system browser + deep link" DIY approach, which would additionally need an app-specific custom URL scheme or Android App Link registered and handled in `MainActivity`.
- **Web login stays separate and unaffected**: the existing `www/auth.js` Web SDK flow keeps working as-is for the plain browser and Electron - a native plugin only needs to be *conditionally* used when running under Capacitor (`Capacitor.isNativePlatform()`), not a replacement for the existing code.
