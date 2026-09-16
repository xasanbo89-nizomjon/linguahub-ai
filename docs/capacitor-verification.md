# Capacitor Verification (Phase 7)

## Status summary

| Layer | Status |
|---|---|
| Source review | **Verified** |
| Runtime (real Android emulator/device) | **NOT RUN** — no Android SDK/emulator available in this environment |
| iOS | **Not applicable** — `@capacitor/ios` is not installed in this project |

No Android emulator, physical device, or Android SDK toolchain is available in this session's environment, so nothing below the source level could be exercised for Capacitor specifically. This is stated plainly rather than implied by omission.

## What was verified by source review

- **API base URL**: `www/config.js`'s `computeApiBase()` treats `protocol === "capacitor:"` (iOS-style Capacitor origin) and the Android WebView's default origin (`protocol === "https:" && hostname === "localhost" && port === ""`) identically to Electron's `file://` case — both resolve to the local backend default (`http://127.0.0.1:3000`). This is unit-tested (`tests/config.test.js`) and passes.
- **http/https requirements**: the Android manifest (`android/app/src/main/AndroidManifest.xml`) sets no explicit `android:usesCleartextTraffic` attribute and references no custom `network_security_config.xml`. On Android API 28+ (the default Capacitor 8 target), this means **cleartext (plain `http://`) traffic is blocked by the OS by default** unless a network security config explicitly allows it. That matters for local development specifically: connecting an Android emulator/device to a local dev backend over plain `http://10.0.2.2:3000` (the emulator's alias for the host machine) or a LAN IP would need an explicit dev-only network security config permitting cleartext to that one host — this project does not currently have one. This is a real, concrete gap for local Android development, documented here rather than guessed at, since it could not be confirmed on a real device in this session.
- **Allowed navigation / WebView origin**: `capacitor.config.json` sets `webDir: "www"` and no custom `server.url` override, so the default Capacitor behavior applies (serving the bundled `www/` directory from the platform's local origin, matching the `config.js` cases above).
- **CORS**: `server.js`'s `DEFAULT_ALLOWED_ORIGINS` already includes `"capacitor://localhost"` and `"http://localhost"` (the two forms Capacitor's iOS and Android default WebView origins use respectively) — confirmed present in source; not exercised against a real device origin.
- **Google OAuth limitation**: covered in `docs/firebase-setup.md` ("Capacitor Android limitation") — the Web SDK's popup/redirect flow is known to be unreliable inside a Capacitor WebView; the documented recommendation is a native auth plugin (not installed in this phase, per the phase's explicit instruction not to add one without a real decision to ship it).
- **Export/download behavior**: the app's export flow uses a `Blob` + `<a download>` click (same as the Electron case) — Capacitor's WebView delegates this to the platform's native download handling; not verified on a real device.
- **Clipboard**: `navigator.clipboard` is a standard Web API; Capacitor's WebView supports it, though some Android WebView versions require the app to be in the foreground and may prompt for permission on first use — not verified on a real device.
- **Storage**: the app uses plain `localStorage` (`www/chatStore.js`), which Capacitor's WebView backs with the platform's own WebView storage. This is subject to the OS's normal app-data eviction policy under storage pressure (same caveat as any WebView-based app) — chatStore's own proactive pruning (`LIMITS.maxNamespaceBytes`, verified live in this session, see the Phase 7 report's Storage QA section) mitigates but does not eliminate this.
- **Dialogs**: the app's custom dialog system (`www/dialog.js`) is plain DOM/CSS with no native-dialog dependency, so it should render identically inside a Capacitor WebView — not verified on a real device.
- **Responsive UI**: the app's CSS breakpoints go down to 360px width (verified live across 7 desktop/tablet/mobile viewports in this session's browser QA — see the Phase 7 report), which covers the range of real Android device widths, but a real device/emulator run is the only way to confirm actual on-device rendering, touch behavior, and any WebView-specific rendering differences from desktop Chromium.
- **Safe-area insets**: no `env(safe-area-inset-*)` CSS exists anywhere in `www/styles.css` or `www/theme.css` (confirmed by direct search). This matters most for iOS notch/home-indicator areas; for Android it matters less but can still affect gesture-navigation devices. Since this project has no `@capacitor/ios` platform installed and no Android device was available to confirm whether this is a real visible problem, **this is documented as a known gap and recommendation, not fixed** — adding safe-area CSS without being able to see the result on a real device risks introducing an unverified change for a scenario that can't be checked in this environment.
- **Keyboard behavior**: Capacitor's on-screen-keyboard behavior (resizing vs. overlaying the WebView) depends on platform-level configuration (`@capacitor/keyboard` plugin, not installed here) and OS version. Not verified.
- **Android cleartext traffic in development**: see the http/https note above — this is the most concrete, actionable gap found.
- **Production HTTPS requirement**: satisfied by Android's own default behavior (cleartext blocked by default on API 28+) as long as the production backend is actually served over HTTPS, which is an infrastructure/deployment decision outside this project's source.

## What was NOT run (stated plainly)

- No Android emulator or device was launched.
- No `npx cap sync` / `npx cap run android` build-and-deploy cycle was executed.
- No real Google sign-in attempt inside a Capacitor WebView.
- No real on-device visual/responsive/keyboard/safe-area check.
- No native Google auth plugin was installed (per explicit phase instructions not to add one without a real decision to ship it) — see `docs/firebase-setup.md` for the specific recommendation (`@capacitor-firebase/authentication` or `@codetrix-studio/capacitor-google-auth`) for whoever picks this up next.

## Recommendation for a future phase

Before shipping an Android build: (1) add a dev-only Android network security config allowing cleartext to the local dev backend host, scoped narrowly (not a blanket cleartext allowance); (2) install and wire up a native Google auth plugin instead of relying on the Web SDK's popup/redirect flow; (3) run a real device/emulator pass covering the same responsive/keyboard/safe-area checklist already completed for the browser in this phase.
