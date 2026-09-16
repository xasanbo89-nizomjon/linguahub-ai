# Firebase Setup Guide

Status in this environment (verified 2026-08-06): **no real Firebase project is configured.**

- `www/firebase-config.js` ships with every field blank (`apiKey: ""`, `authDomain: ""`, etc.) — this is intentional, not an oversight; see the comment block at the top of that file.
- `.env` contains only `OPENAI_API_KEY`. None of `GOOGLE_APPLICATION_CREDENTIALS`, `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` are set.
- This is a deliberately safe default: with no config, the app runs correctly in guest-only mode (verified live — see `docs/phase-07-browser-and-release-qa.md`, "Firebase readiness"), the "Sign in with Google" button is honestly disabled with the message *"Sign-in is unavailable: Firebase is not configured for this app"*, and `/api/auth/me` fails safely (503) rather than crashing.

This document is a setup guide for whoever configures a real project. **No real secrets appear anywhere below.**

Re-checked, same result, in Phase 9 (2026-08-06) - see
`docs/firebase-production-checklist.md` for that phase's full checkpoint
and pre-launch checklist, and `docs/android-capacitor-checklist.md` for the
Android-specific SHA-fingerprint and `google-services.json` steps a native
Google sign-in integration will additionally need.

Re-checked again, same result, in Phase 10 (2026-08-06) - see
`docs/firebase-live-login-report.md` and `docs/firebase-admin-live-report.md`
for that phase's checkpoint, and `docs/capacitor-native-auth.md` for the
now-**implemented** (but still device-unverified, no real project or SDK
in this environment) native Android Google sign-in adapter.

## 1. Create or select a Firebase project

1. Go to the [Firebase Console](https://console.firebase.google.com/).
2. Create a new project (or select an existing one). Google Analytics is optional and unrelated to this app.

## 2. Enable the Google sign-in provider

1. In the console: **Build → Authentication → Sign-in method**.
2. Enable **Google** as a sign-in provider.
3. Set a support email (required by Google's consent screen).

## 3. Add authorized domains

Under **Authentication → Settings → Authorized domains**, add every origin the app will actually be served from:

- `localhost` (usually present by default — covers local dev)
- Your production domain (e.g. `app.example.com`), if/when deployed
- Do **not** add a `file://` origin here — it isn't a domain. Electron's `file://` origin is handled differently (see `docs/electron-verification.md`).

## 4. Create a Web App and get the public client config

1. **Project settings → General → Your apps → Add app → Web**.
2. Register the app (nickname only, no hosting setup needed).
3. Copy the resulting config object's values into `www/firebase-config.js`:

```js
window.LINGUAHUB_CONFIG.FIREBASE = Object.assign(
  {
    apiKey: "REPLACE_ME",
    authDomain: "REPLACE_ME.firebaseapp.com",
    projectId: "REPLACE_ME",
    appId: "REPLACE_ME",
    storageBucket: "REPLACE_ME.appspot.com",
    messagingSenderId: "REPLACE_ME"
  },
  window.LINGUAHUB_CONFIG.FIREBASE || {}
);
```

These values are **public by design** — a Firebase web API key only identifies the project to Google's servers; it does not grant access by itself. Real access control comes from the Authentication provider configuration, Authorized domains list, and (if used) Firestore/Realtime Database security rules — none of which live in this file. It is still good practice not to commit real values to a public repository if the project itself should stay private, but this is not a secret in the same sense as the items in step 6.

## 5. Localhost / 127.0.0.1 notes

- Firebase's `signInWithPopup` and `signInWithRedirect` both require the page to be served from an **authorized domain**, over `http://localhost` or `https://`. A raw IP like `http://127.0.0.1:5500` is *not* automatically authorized the same way `localhost` is — prefer running the dev server as `localhost` (not `127.0.0.1`) when testing real Google sign-in, or add the specific host you use to the authorized domains list.
- This project's own backend allowlist (`server.js`, `DEFAULT_ALLOWED_ORIGINS`) already includes both `http://127.0.0.1:5500` and `http://localhost:5500` for CORS — that's separate from Firebase's own authorized-domains list and doesn't need to change.

## 6. Configure backend Admin credentials (never public)

The backend (`middleware/auth.js`, `lib/firebaseAdmin.js`) verifies ID tokens using the **Firebase Admin SDK**, which needs its own, separate, *private* service-account credential. Configure exactly one of:

- `GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service-account.json` (points at a downloaded service account key file — **Project settings → Service accounts → Generate new private key**), or
- The three discrete env vars: `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` (the same key file's fields, useful when a file path isn't practical, e.g. some hosting platforms).

**Never** commit the downloaded JSON key file, and never put any of these values in `www/` — that directory is served to the browser. `.gitignore` already excludes `.env`; keep the service-account JSON out of the repo the same way.

Without Admin credentials configured, authenticated-only routes (`/api/auth/me`) return a safe `503` and guest chat is completely unaffected — verified live in this session (see the Phase 7 report).

## 7. Firebase ID token flow (how this app uses it)

1. Frontend: `www/auth.js` wraps the Firebase Auth Web SDK (compat build, loaded via `<script>` tags from `gstatic.com` — not the ES-module build, so it works under Electron's `file://` origin and Capacitor's webview without a bundler).
2. After sign-in, `LinguaHubAuth.getIdToken()` retrieves a short-lived ID token.
3. `www/app.js`'s `buildAuthHeaders()` attaches it as `Authorization: Bearer <token>` — only when a real user is signed in and a token is actually available; never a stale/undefined value.
4. Backend: `middleware/auth.js`'s `authenticateOptional` verifies the token via Admin SDK and attaches `req.user` if valid, but never rejects the request if the token is missing/invalid (hybrid guest-allowed policy) — chat stays usable either way. `authenticateRequired` (used only by `/api/auth/me`) does reject.

## 8. CORS notes

No changes needed for Firebase itself — `identitytoolkit.googleapis.com` and `securetoken.googleapis.com` (the REST endpoints the Firebase SDK talks to directly from the browser) are already allowed via this project's CSP `connect-src` (see below), and Firebase's own API calls aren't routed through this app's backend at all.

## 9. CSP notes

`server.js`'s Helmet CSP already allows exactly what Firebase needs and nothing more — this should not need to change when you configure a real project:

- `script-src 'self' https://www.gstatic.com` — the Firebase SDK script tags.
- `connect-src ... https://identitytoolkit.googleapis.com https://securetoken.googleapis.com` — the Auth REST calls.
- `frame-src https://*.firebaseapp.com https://accounts.google.com` — the sign-in popup/iframe.
- `img-src ... https://*.googleusercontent.com` — Google profile photos.
- `crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" }` — required for `signInWithPopup`; the stricter default would silently break the popup's `window.opener` handshake.
- `crossOriginEmbedderPolicy: false` — required so the gstatic-hosted SDK script and Google profile images (neither sends a CORP header) aren't blocked.

## 10. Google popup notes

`signInWithPopup` is the primary flow. If a browser blocks the popup (common on strict popup-blocker settings or some in-app browsers), `www/auth.js` is expected to fall back to `signInWithRedirect` — verify this fallback with a real project, since it wasn't exercised in this session (no real project configured).

## 11. Electron limitations

- Electron's `main.js` explicitly allows popups only to the Google/Firebase auth domains via `setWindowOpenHandler` (`accounts.google.com`, `*.firebaseapp.com`) — every other `window.open()` target is denied. This was source-verified in this session; the actual popup flow itself was **not** exercised live (no real Firebase project).
- `config.js` resolves the `file://` origin to the local backend by default — confirmed both by source and by a real Electron runtime launch in this session (see `docs/electron-verification.md`).
- A `file://` origin cannot itself be added to Firebase's Authorized domains list (it isn't a domain) — Firebase Auth in Electron works because the *popup window* navigates to a real HTTPS domain (`accounts.google.com`), not because the app's own origin is authorized.

## 12. Capacitor Android limitation

- `signInWithPopup`/`signInWithRedirect` via the Firebase **Web SDK** inside a Capacitor Android WebView is known to be unreliable across Android versions/WebView implementations (Google has restricted embedded-WebView OAuth in various ways over time). This is a widely known limitation of the Web-SDK-in-a-WebView approach, not something specific to this project's code.
- See "Native plugin recommendation" below.

## 13. Capacitor iOS limitation

- This project currently has **no `@capacitor/ios` platform installed** (only `@capacitor/android` — confirmed via `package.json` in this session). iOS is not currently part of the build at all, so there is nothing iOS-specific to verify or recommend beyond noting it isn't present.
- If iOS is added later, the same WebView-based OAuth caveat as Android applies (arguably more strictly, given Apple's WebView/ASWebAuthenticationSession requirements), and the same native-plugin recommendation below applies.

## 14. Native plugin recommendation (not installed — do not install without a decision to actually ship it)

For a production-quality Capacitor build, replace the Web-SDK popup/redirect flow with **`@capacitor-firebase/authentication`** (or `@codetrix-studio/capacitor-google-auth` specifically for Google sign-in) on native platforms, falling back to the existing Web SDK flow only for the plain browser/Electron targets. This is the standard, widely-used approach for Capacitor + Firebase Google sign-in and avoids the WebView-OAuth restrictions entirely by using the platform's native account chooser.

This phase deliberately does **not** install this plugin — it wasn't already present in the project, and Task 11's instructions are explicit that no native plugin should be added without that being a real decision, not a QA-phase side effect. This is a recommendation for a future phase, not a completed change.

## 15. Real verification checklist (for whoever configures a real project)

Once a real project is set up, verify all of the following for real (none of this was verified in this session — no real project exists here):

- [ ] `firebase.initializeApp` succeeds with no console error
- [ ] `LinguaHubAuth.isAvailable()` returns `true`
- [ ] Clicking "Sign in with Google" opens a real Google account picker
- [ ] After choosing an account, `onAuthStateChanged` fires with a real user object (name/email/photo)
- [ ] The header shows the real name/avatar/email (or an initial-letter fallback if no photo)
- [ ] `GET /api/auth/me` returns `200` with the same identity, backend-verified (not just trusted from the client)
- [ ] Logout clears the UI back to "Sign in with Google" and the backend session check stops attaching a token
- [ ] Refreshing the page while signed in restores the session without requiring a new sign-in
- [ ] The same flow works (or is documented as broken, with the native-plugin plan above) inside an actual Capacitor Android build on a real device/emulator
