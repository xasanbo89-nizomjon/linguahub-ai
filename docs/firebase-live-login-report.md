# Firebase Live Login Report (Phase 10, Task 5)

## Status: BLOCKED - no real Firebase project configured

Re-checked directly at the start of this phase, same method as every prior
phase:

```
$ node -e "require('dotenv').config(); ['FIREBASE_PROJECT_ID','FIREBASE_CLIENT_EMAIL','FIREBASE_PRIVATE_KEY','GOOGLE_APPLICATION_CREDENTIALS'].forEach(k => console.log(k, process.env[k] ? 'set' : 'unset'))"
FIREBASE_PROJECT_ID unset
FIREBASE_CLIENT_EMAIL unset
FIREBASE_PRIVATE_KEY unset
GOOGLE_APPLICATION_CREDENTIALS unset
$ grep -E "apiKey|projectId|appId" www/firebase-config.js
apiKey: "",
projectId: "",
appId: "",
```

No real Firebase client configuration or Admin credentials exist anywhere
in this environment (not in `.env`, not in `www/firebase-config.js`, not
provided in this session). Per this phase's explicit rule, no credentials
were invented. **Real login: BLOCKED**, same root cause and same
conclusion as Phases 7, 8, and 9.

## The 20-item checklist: classified honestly, item by item

| # | Item | Status |
|---|---|---|
| 1 | Open LinguaHub AI | real (every e2e suite does this) |
| 2 | Guest mode loads | **PASS**, real - `e2e/smoke.js`, `e2e/auth-error-matrix.js` |
| 3 | Click Google Login | **BLOCKED** - button is honestly disabled (`e2e/auth-error-matrix.js`, `e2e/keyboard.js` both confirm this live) |
| 4 | Google authentication UI opens | **NOT RUN** - needs a real project |
| 5 | Complete login | **NOT RUN** - needs a real project and a real Google account |
| 6-8 | Avatar/name/email render | **source-only** - `renderSignedIn()` in `www/app.js` reviewed; uses `textContent` only (no `innerHTML`), so a malicious display name can't inject markup - not exercised with a real user |
| 9 | Auth state survives refresh | **NOT RUN** - needs a real persisted Firebase session |
| 10 | ID token attached to protected requests | **real** (mechanism) - `Authorization: Bearer <token>` header logic exercised with a mocked token in `tests/frontend-auth.test.js`; confirmed absent for a real guest in a real browser (`e2e/auth-error-matrix.js`) |
| 11 | `/api/auth/me` returns the verified user | **NOT RUN** (success path) - the failure path (no/garbage token) IS verified real: 401/503 with a safe message, `e2e/auth-error-matrix.js` |
| 12 | Backend derives uid from the verified token | **real** (source + automated) - `middleware/auth.js`'s `toSafeUser()` only ever reads from `decodedToken`, never from `req.body`/`req.query`; `tests/auth.test.js`, "frontend-supplied identity (query params) is ignored" |
| 13 | Frontend-supplied uid is ignored | **real** (automated) - same test as #12, exercised from the request side |
| 14 | Logout succeeds | **automated (mocked)** - `tests/frontend-auth.test.js` |
| 15 | Logout aborts active generation | **real** - `tests/frontend-auth.test.js`, "app.js: logout aborts an active streaming generation" genuinely exercises the abort wiring, independent of whether Firebase itself is real |
| 16 | Guest history remains separate | **real (structural)** - `tests/chatStore.test.js`, namespace isolation exercised without needing a real login |
| 17 | Authenticated namespace based on Firebase uid | **real (structural)** - `www/history-ui.js` reads `user.uid` directly, confirmed by source and by the same structural test |
| 18 | Switching users changes namespace | **NOT RUN** - needs two real accounts |
| 19 | No token in LocalStorage history | **real** - `e2e/security.js` scans real LocalStorage chat-history keys after a real send/save cycle; none found. Also newly re-confirmed structurally this phase for the native-Android code path specifically (`tests/native-auth-adapter.test.js`) |
| 20 | No token in console/network logs | **real (structural)** - `www/auth.js` never logs a token value anywhere (only `error.code`/`error.message`); re-confirmed this phase for the new native backend by a dedicated structural test (`tests/native-auth-adapter.test.js`, "never logs a raw ID token") |

## What changed this phase for the parts that don't need a real project

Nothing about the *web* login flow changed - `www/auth.js`'s web backend
is byte-for-byte the same logic as Phase 9 (only reorganized to sit
alongside the new native backend, with 18 pre-existing tests in
`tests/frontend-auth.test.js` re-run and still passing unchanged). What's
new is the **native Android** backend, covered in full in
`docs/capacitor-native-auth.md` - it cannot be exercised for real either,
for the same missing-Firebase-project reason plus the missing-Android-SDK
reason (`docs/android-runtime-report.md`).

## What a real verification pass will need

Unchanged from `docs/firebase-production-checklist.md` (Phase 9): a real
Firebase project with Google sign-in enabled, real values in
`www/firebase-config.js`, real Admin credentials in `.env`. Additionally,
for Android specifically: `google-services.json` placed in `android/app/`,
SHA-1/SHA-256 fingerprints registered in the Firebase Console, and a real
Android SDK/device to build and run against - see
`docs/android-runtime-report.md` and `docs/capacitor-native-auth.md`.
