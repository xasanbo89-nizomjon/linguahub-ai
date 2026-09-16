# Phase 2 — Firebase Google Authentication

Date: 2026-08-05

## 1. Authentication policy

**Hybrid (guest-allowed, identity-aware when logged in).**

- `/api/chat`, `/api/chat/stream`, and the legacy `/chat` route run `authenticateOptional`: if a valid Firebase ID token is sent, the request gets a verified `req.user`; if not (or the token is bad/expired), the request proceeds as a guest exactly as it did before this phase. Chat never returns 401.
- `GET /api/auth/me` runs `authenticateRequired`: 401 without a valid token, 503 if Firebase Admin isn't configured server-side, 200 with the verified identity otherwise.

**Why:** before this phase, chat had zero access control and was fully public. Rule 3 ("do not remove working chat features") and rule 18 ("do not silently change access policy without documenting it") both point the same direction: locking chat behind login would be a regression for every current user, and nothing in this task's brief said to do that. Hybrid preserves 100% of existing behavior for guests while adding a real, verified identity layer for anyone who signs in - the foundation Task 12 (ownership) and future phases (personalization, per-account history) need. If a future phase decides chat *should* require login, that's a deliberate policy change to make explicitly, not a side effect of adding auth.

## 2. Existing auth audit (before this phase)

A full repo search (`firebase`, `initializeApp`, `getAuth`, `signInWithPopup`, `onAuthStateChanged`, `jsonwebtoken`, `firebase-admin`, `Authorization`, `Bearer`, `localStorage`, etc.) found **nothing**. Confirmed before writing any code:

1. Frontend auth code: none.
2. Backend auth code: none.
3. Firebase config: none (no `firebase`/`firebase-admin` in `package.json`).
4. User UI: none - no login/profile/logout elements existed.
5. Session persistence: none.
6. Token flow: none.
7. Unauthenticated access policy: fully open - every route was public.
8. Security risks (pre-phase): none specific to auth, since there was no auth surface to attack; the risk was the *absence* of any identity layer for future features.
9. LocalStorage: not used anywhere in the app (chat history is in-memory DOM only, lost on refresh, both before and after this phase - see §14).

This is the same "brief assumes more than exists" pattern documented in Phase 1: the task brief's "known remaining issues" list matched reality exactly, so this phase is additive, not corrective.

## 3. Features implemented

- Google sign-in via Firebase (`signInWithPopup`, with automatic `signInWithRedirect` fallback when popup isn't viable).
- Auth state restoration via `onAuthStateChanged`, with a distinct "restoring session..." loading state before the first callback fires.
- Avatar (with initial-letter fallback), display name, and email rendered via `textContent` only.
- Logout via Firebase `signOut()`, which also aborts any in-flight chat generation.
- Firebase ID token attached as `Authorization: Bearer <token>` on chat requests, only when a user is actually signed in.
- Backend verification of that token via Firebase Admin, producing a `req.user` the routes can trust.
- `GET /api/auth/me` - a safe, verified-identity-only endpoint.

## 4. Security improvements (verified)

- The backend never trusts a uid/role/email/etc. the client claims - `req.user` is only ever populated from `firebaseAdmin.verifyIdToken()`'s return value. Verified with a test that sends `?uid=attacker-controlled-uid&role=admin` alongside a valid mocked token and confirms the response still reflects the token's real uid (`tests/auth.test.js`).
- Firebase Admin credentials are backend-only (`lib/firebaseAdmin.js`, never referenced from `www/`), never logged (only `error.code` is logged on failure, never the credential or the raw error object).
- Firebase ID tokens are never logged and never written to `localStorage` - verified structurally (`tests/frontend-auth.test.js` scans `www/auth.js`/`www/app.js` for `localStorage` writes) and by design (Firebase's own IndexedDB-backed persistence is the only place a session is cached).
- Raw Firebase verification errors are never returned to the client - `middleware/auth.js`'s `mapVerifyError` always returns a generic, safe message; verified with a test that makes the mock verifier throw an error containing a canary string and asserts it never appears in the HTTP response.
- CORS explicitly allows `Authorization` (no wildcard origin, no reflected-arbitrary-origin) and still rejects unconfigured origins on the new route (403 JSON).
- `.gitignore` now excludes common Firebase service-account filename patterns in addition to `.env`.
- Helmet security headers (CSP, `X-Content-Type-Options`, `X-Frame-Options`, etc.) now apply to every response, including the new auth route.

## 5. Files modified

| File | Reason | Type of change |
|---|---|---|
| `server.js` | Wire up Helmet/CSP, auth middleware, and the new endpoint | Added `helmet()` with an explicit CSP (see §15); added `allowedHeaders: ["Content-Type","Authorization"]` to the existing CORS config; imported `middleware/auth`; added `GET /api/auth/me`; inserted `authenticateOptional` into `/chat`, `/api/chat`, `/api/chat/stream`. No existing route path, validation logic, or response shape changed. |
| `www/index.html` | Add login/profile UI, load Firebase SDK, enable a stricter CSP | Added header markup for login button + profile (avatar/name/email/logout) + an `aria-live` auth-status region; added matching CSS (new rules only, nothing existing removed); replaced `onclick="sendMessage()"` with a real event listener (required so `script-src-attr 'none'` doesn't break the Send button); replaced the inline `<script>` block with `<script src>` tags for the Firebase compat SDK, `firebase-config.js`, `auth.js`, `config.js`, and the newly-extracted `app.js`. |
| `main.js` | Google's OAuth popup was silently blocked by Electron's default `window.open` policy | Added `setWindowOpenHandler` that allows popups only to `accounts.google.com` and `*.firebaseapp.com`, denies everything else. |
| `package.json` | New backend dependencies | `npm install firebase-admin helmet --save` added `firebase-admin` and `helmet` to `dependencies` (this edit was made by `npm`, not hand-edited). |
| `.env.example` | Document the new server-only Firebase Admin variables | Added `GOOGLE_APPLICATION_CREDENTIALS`, `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, `FIREBASE_CHECK_REVOKED`, all blank. |
| `.gitignore` | Prevent an accidentally-downloaded service-account key from being committed | Added `serviceAccountKey.json`, `*-firebase-adminsdk-*.json`, `*.serviceaccount.json`. |

## 6. Files created

| File | Purpose |
|---|---|
| `lib/firebaseAdmin.js` | Firebase Admin SDK initialization (server-only), `isConfigured()` / `verifyIdToken()`. |
| `middleware/auth.js` | `authenticateRequired` (401/503) and `authenticateOptional` (never rejects) Express middleware. |
| `www/firebase-config.js` | Public Firebase Web SDK config object (`window.LINGUAHUB_CONFIG.FIREBASE`) - blank by default. |
| `www/auth.js` | Firebase Auth wrapper: login, logout, state restoration, token retrieval, error mapping. |
| `www/app.js` | The chat app's logic, extracted from `www/index.html`'s inline script (so `script-src` can drop `'unsafe-inline'`), plus the new login/profile/logout UI wiring and token attachment. |
| `tests/auth.test.js` | 12 backend tests: `/api/auth/me`, token verification, error sanitization, optional-auth chat behavior, CORS, 503-when-unconfigured. |
| `tests/frontend-auth.test.js` | 15 frontend-source tests (via Node's built-in `vm`, no new dependency): single-init guard, login/logout delegate to real Firebase methods, no localStorage token writes, Authorization header attachment, logout aborts active generation. |
| `docs/phase-02-authentication.md` | This document. |

## 7. Firebase client configuration

`www/firebase-config.js` holds the public Web SDK config (`apiKey`, `authDomain`, `projectId`, `appId`, `storageBucket`, `messagingSenderId`) under `window.LINGUAHUB_CONFIG.FIREBASE`, all blank by default. A Firebase web API key is not a secret (see the comment in that file for why); real access control is Firebase Security Rules + the Authorized Domains list in the Firebase Console, neither of which live in this repo.

`www/auth.js` initializes the app once, guarded by `if (!firebase.apps.length)` (tested explicitly by running the script twice against the same fake `firebase` global and asserting `initializeApp` was only called once). If the SDK failed to load or the config is blank, `LinguaHubAuth.isAvailable()` is `false` and the rest of the app degrades to guest-only instead of throwing.

The Firebase **compat** SDK (not the modular/ES-module build) is loaded from Google's CDN via plain `<script>` tags. This was a deliberate compatibility choice, not the default recommendation: the modular SDK is ES-module-only, and `type="module"` scripts fail to load over Electron's `file://` origin in many Chromium versions due to CORS-for-modules restrictions. The compat build is a classic global-script include - identical behavior under Live Server, Electron, and Capacitor, and consistent with how every other script in this project is already loaded (no bundler, no modules anywhere in the codebase).

## 8. Firebase Admin configuration

`lib/firebaseAdmin.js` tries, in order: `GOOGLE_APPLICATION_CREDENTIALS` (a path to a service-account JSON file - the standard Google Cloud convention), then the discrete `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` trio (private key newlines normalized from `\n` escapes automatically). If neither is present, `isConfigured()` returns `false`, a startup warning is logged once, and every subsequent `verifyIdToken()` call throws a specific `auth/admin-not-configured` error that `middleware/auth.js` maps to a 503 - it never crashes, never fakes a verified identity, and never blocks guest chat (verified: `tests/auth.test.js` "fails clearly with 503 ... without crashing guest routes").

**Neither is configured in this environment** - `.env` only has `OPENAI_API_KEY`. This is expected and documented (§18): real token verification could not be exercised end-to-end here.

## 9. Token flow

```
User clicks "Sign in with Google" (www/app.js: handleLogin)
  -> LinguaHubAuth.signInWithGoogle() (www/auth.js)
  -> firebase.auth().signInWithPopup(GoogleAuthProvider)   [falls back to signInWithRedirect if popup isn't viable]
  -> Firebase returns a signed-in user; onAuthStateChanged fires
  -> www/app.js renders the profile (avatar/name/email) from the Firebase user object

On each chat request (www/app.js: buildAuthHeaders, called from streamChat/fallbackChat):
  -> if a user is signed in: LinguaHubAuth.getIdToken() (SDK-managed, auto-refreshed, never manually cached)
  -> Authorization: Bearer <ID token> header attached (omitted entirely for guests - never "Bearer undefined")

On the backend (middleware/auth.js):
  -> extractBearerToken(req) -> firebaseAdmin.verifyIdToken(token) -> real cryptographic verification against Google's public keys
  -> req.user = { uid, email, name, picture, emailVerified }   (from the verified token only)
  -> route handler runs (GET /api/auth/me returns req.user directly; chat routes proceed either way)
```

## 10. Profile UI

`renderSignedIn(user)` in `www/app.js` sets `userNameEl.textContent` / `userEmailEl.textContent` (never `innerHTML`, so a crafted `displayName` can't inject markup). If `photoURL` is present it's used as the avatar `src` with `alt="<name> profile picture"`; if absent, or if the image fails to load (`<img>` `error` event), a fallback circle showing the first letter of the name is shown instead - never a broken-image icon. The whole profile area sits in the existing header, reusing the current dark theme (no redesign). Auth status changes (signing in, errors, restoring session) are announced through `#auth-status`, which has `aria-live="polite"`. Both the login and logout buttons are real `<button type="button">` elements (native keyboard/focus support, accessible names from their visible text).

## 11. Logout

`handleLogout()` in `www/app.js`: guarded against double-clicks (`logoutInProgress` flag, button disabled while in progress), aborts `activeChatAbortController` if a generation is in flight (so a logout mid-stream actually stops the request - verified in `tests/frontend-auth.test.js` using a fetch mock that only resolves/rejects on `signal`'s `abort` event), then calls `LinguaHubAuth.signOutUser()`. Errors are shown via `#auth-status` rather than swallowed. Nothing in `localStorage` is touched (nothing auth-related was ever written there - see §14), so there's no "clear all LocalStorage blindly" risk to guard against.

## 12. Chat regression status

- Phase 1's 405 fix: **preserved**. `www/config.js` (the API-URL resolver) was not touched in this phase.
- Streaming: **preserved and re-verified** with a real OpenAI call after all changes, including with a garbage `Authorization` header attached (proving the optional-auth fail-open path doesn't break guest streaming).
- Port 3000 targeting: **preserved** - confirmed via `tests/frontend-auth.test.js` ("requests target port 3000... never port 5500") and a live check.
- No frontend-port request: **preserved** - same test, plus a live check against the actual Live-Server-equivalent process that happened to be running on port 5500 in this environment (see §16), which served this project's `www/index.html` correctly with the new script tags in place.
- All 22 Phase 1 tests still pass unmodified.

## 13. LocalStorage ownership

**Not applicable in this phase, and nothing was added to make it applicable.** The Phase 1 audit already established that this app has no `localStorage` usage anywhere - chat history lives only in the DOM and is lost on refresh, for guests and signed-in users alike, both before and after this phase. Task 12 assumes a pre-existing LocalStorage-keyed chat history to namespace/migrate; since none exists, there is nothing to namespace, nothing to migrate, and nothing to leak across accounts. Inventing a new chat-persistence feature just to have something to namespace would be a new feature disguised as an auth task (against this project's explicit "no fake functionality" / "don't add features beyond what's required" rules), so it was not done. **Recommended for Phase 3** if persisted history is wanted: namespace by `linguahub:chat:guest` vs. `linguahub:chat:<uid>`, with guest history preserved as-is and never auto-assigned to a signed-in account.

## 14. Helmet and CSP

`server.js` now applies Helmet on every response, with an explicit (not default) CSP:

| Directive | Value | Why |
|---|---|---|
| `default-src` | `'self'` | Baseline deny-by-default. |
| `script-src` | `'self' https://www.gstatic.com` | Same-origin scripts (`config.js`, `auth.js`, `app.js`, `firebase-config.js`) plus the Firebase SDK from Google's CDN. No `'unsafe-inline'` - the app's script was extracted to `www/app.js` specifically so this could be strict. |
| `script-src-attr` | `'none'` | Blocks inline event-handler attributes; required removing the one `onclick="sendMessage()"` that existed, replaced with `addEventListener`. |
| `style-src` | `'self' 'unsafe-inline'` | The existing page keeps ~130 lines of CSS in an inline `<style>` block with no nonce infrastructure. Extracting it was judged out of scope for an auth phase (no functional/security benefit proportional to the risk of a larger diff); inline CSS is not a code-execution vector the way inline JS is. **Documented exception.** |
| `img-src` | `'self' data: https://*.googleusercontent.com` | Google account profile photos are served from `*.googleusercontent.com`. |
| `connect-src` | `'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com` | `'self'` covers `/api/*` and `/health`; the other two are Firebase Auth's REST endpoints used internally by the SDK for sign-in and token refresh. |
| `frame-src` | `https://*.firebaseapp.com https://accounts.google.com` | Firebase Auth's popup/redirect flow uses a hidden iframe at the project's `authDomain` (`*.firebaseapp.com`) plus navigation through `accounts.google.com`. |
| `font-src` | `'self'` | No external fonts are used (system Arial). |
| `object-src` | `'none'` | No plugins/embeds used. |
| `base-uri` | `'self'` | Standard hardening. |
| `form-action` | `'self'` | No HTML forms submit anywhere in the app. |
| `frame-ancestors` | `'self'` | The app isn't meant to be embedded by other sites. |

Two additional Helmet options were set explicitly for Firebase compatibility:
- `crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" }` - Helmet's stricter default (`same-origin`) severs the `window.opener` relationship `signInWithPopup` depends on to detect when the popup closes/completes.
- `crossOriginEmbedderPolicy: false` - the default `require-corp` would block the gstatic-hosted SDK and Google profile photos, neither of which send a `Cross-Origin-Resource-Policy` header for us.

**Local development note:** Helmet only runs inside `server.js` - when the page is opened through Live Server on port 5500 (or Electron's `file://`, or a Capacitor webview), *that* origin serves the HTML/CSS/JS with no CSP at all (Live Server doesn't send one). Only requests that land on the Express app (port 3000, or wherever it's deployed) get these headers. This means CSP is fully exercised in the "Express serves its own frontend" topology and in production, but not when using Live Server purely for static-file convenience during development - documented here so it isn't mistaken for an inconsistency.

Live-verified: `curl -i` against a running `node server.js` shows all of the above directives on `/health`, `/api/auth/me`, and static files, with `same-origin-allow-popups` present and no `Cross-Origin-Embedder-Policy` header.

## 15. Tests and commands run

```
npm install firebase-admin helmet --save
node --check main.js server.js lib/firebaseAdmin.js middleware/auth.js www/app.js www/auth.js www/firebase-config.js
node --test
node server.js                                                     # background, for live verification
curl -s -i http://127.0.0.1:3000/health
curl -s -i http://127.0.0.1:3000/api/auth/me                       # no token
curl -s -i http://127.0.0.1:3000/api/auth/me -H "Authorization: Bearer fake.token.here"
curl -s -i -X OPTIONS http://127.0.0.1:3000/api/auth/me -H "Origin: http://127.0.0.1:5500" -H "Access-Control-Request-Method: GET" -H "Access-Control-Request-Headers: Authorization"
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/{config.js,app.js,auth.js,firebase-config.js}
curl -s -N --max-time 20 -X POST http://127.0.0.1:3000/api/chat/stream -H "Authorization: Bearer not-a-real-firebase-token" -H "Content-Type: application/json" -d '{"message":"Reply with exactly the single word: OK"}'   # real OpenAI call, guest fail-open path
curl -s -i http://127.0.0.1:5500/AI-chat-app/www/index.html         # through the real static server active on 5500 in this environment
```

## 16. Test results

- `node --test`: **46/46 passed**, 0 failed (11 Phase 1 config + 11 Phase 1 server + 12 new backend auth + 12 new frontend auth... see exact per-file counts in `tests/`).
- `GET /health`: 200, unauthenticated, Helmet headers present - **PASS**.
- `GET /api/auth/me` no token: 401 - **PASS**. With a token but Admin unconfigured: 503 - **PASS** (matches this environment's actual, documented state).
- CORS preflight for `/api/auth/me` with `Authorization`: 204, `Access-Control-Allow-Headers` includes `Authorization` - **PASS**.
- Static serving of the four new `www/*.js` files: all 200 - **PASS**.
- Real OpenAI streaming call with a garbage `Authorization` header attached: succeeded (fail-open to guest, as designed) - **PASS**.
- The project's `www/index.html`, fetched through the real port-5500 static server active in this environment, serves the updated title and correct script-tag order - **PASS**.
- Interactive Google popup login in a real browser: **NOT RUN** (no GUI/browser automation available in this environment).
- Real Firebase ID token verification against a real project: **NOT RUN** (no Firebase project/credentials available - `.env` has none, none were fabricated).
- Electron popup-open behavior (`setWindowOpenHandler`): **NOT RUN interactively** (no display to launch Electron's GUI here) - source-level fix only, `node --check`-verified.
- Capacitor Android Google sign-in: **NOT RUN**, and separately flagged as a **known limitation, not just an untested path** - see §19.

## 17. Real verification vs. mocked/source-only

| Claim | Status |
|---|---|
| Firebase Admin SDK correctly verifies a real ID token | **NOT RUN** - no Firebase project/credentials available. `lib/firebaseAdmin.js` calls the real `firebase-admin` `verifyIdToken` API in production; only the *wiring* around it (middleware, status codes, error sanitization) was tested, using a mocked `verifyIdToken` (test-only, see `tests/auth.test.js` header comment). |
| Interactive Google sign-in (popup/redirect) completes in a browser | **NOT RUN** - no browser automation in this environment. |
| `signInWithGoogle()` / `signOutUser()` call the real Firebase SDK methods | **REAL SOURCE, MOCKED SDK** - `tests/frontend-auth.test.js` executes the actual `www/auth.js` file via Node's `vm` module and asserts it calls `auth.signInWithPopup` / `auth.signOut` on a fake `firebase` object; the wrapper logic is real, the underlying SDK call target is a test double (necessary since no real Firebase project exists to sign into). |
| Chat/backend/CORS/Helmet/rate-limit behavior | **REAL** - a live `node server.js` process was hit with real HTTP requests via curl, including one real OpenAI streaming call. |
| Electron `window.open` popup allowance | **SOURCE-LEVEL FIX ONLY** - correct per documented Electron behavior (default-deny `window.open` since Electron 14+), syntax-checked, not interactively launched. |

## 18. Remaining issues

- No real Firebase project is configured anywhere in this environment - everything auth-related is real, working code with nowhere to point yet (§8, §17).
- Capacitor Android: Google actively blocks OAuth sign-in inside embedded WebViews (`disallowed_useragent`, a Google policy change, not a bug in this code). Neither `signInWithPopup` nor `signInWithRedirect` will work inside the Capacitor Android webview as shipped. The correct fix is a dedicated plugin (e.g. `@capacitor-firebase/authentication` or `@capacitor/browser` + a custom Custom-Tabs flow) - not installed, since adding a new native plugin is a bigger dependency/build change than this phase's scope. This is a **known, documented limitation**, not an oversight.
- No chat-history persistence exists to namespace by account (§13) - Phase 3 item if wanted.
- The in-memory rate limiter (Phase 1) still keys by IP, not by uid - unchanged in this phase; a per-account limit is a reasonable Phase 3 addition now that verified identity exists.
- `style-src 'unsafe-inline'` remains necessary because the page's CSS wasn't extracted (§14) - a real, documented CSP exception, not a leftover oversight.
- The backend's `/api/auth/me` verification is decoupled from the frontend's signed-in UI state by design (`verifyBackendSession()` only shows a warning on failure, never forces a client-side sign-out) - correct given Firebase is the source of truth (Task 4), but means a user could see "signed in" in the UI while the backend can't currently verify them (exactly the state this environment is in, since Admin isn't configured) - documented, not hidden.

## 19. Rollback notes

Every change is a source-level edit or an additive new file; no data migrations, no schema changes. `firebase-admin` and `helmet` were added via `npm install --save` (reflected in `package.json`/`package-lock.json`) - `npm uninstall firebase-admin helmet` plus reverting the six modified files and deleting the eight created files (§5-§6) fully reverts this phase. `.env` was not touched; no real Firebase credentials exist anywhere in this repo to roll back. No git commit was created.
