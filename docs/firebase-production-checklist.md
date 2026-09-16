# Firebase Production Checklist

Status as of Phase 9: **no real Firebase project is configured in this
environment**, same as every prior phase. This document records exactly
what was re-checked this phase, and exactly what a real production rollout
still needs. Nothing here is invented - every unchecked item below requires
a real Firebase project this session never had access to.

## Current state (re-verified this phase)

```
$ node -e "require('dotenv').config(); ['FIREBASE_PROJECT_ID','FIREBASE_CLIENT_EMAIL','FIREBASE_PRIVATE_KEY','GOOGLE_APPLICATION_CREDENTIALS'].forEach(k => console.log(k, process.env[k] ? 'set' : 'unset'))"
FIREBASE_PROJECT_ID unset
FIREBASE_CLIENT_EMAIL unset
FIREBASE_PRIVATE_KEY unset
GOOGLE_APPLICATION_CREDENTIALS unset
```

`www/firebase-config.js` ships with every field blank. `www/auth.js`
correctly detects this and reports `isAvailable() === false`; the sign-in
button is honestly disabled rather than faking a working state. This was
re-confirmed live this phase via `e2e/auth-error-matrix.js` (7/7 passing).

## Pre-launch checklist

Use this checklist when a real Firebase project becomes available. Each
item links to the code that already implements it (nothing needs to be
built - only configured and exercised for real).

| # | Item | Status | Where |
|---|---|---|---|
| 1 | Create a Firebase project in the [Firebase Console](https://console.firebase.google.com/) | Not provisioned | - |
| 2 | Authentication → Sign-in method → enable **Google** | Not provisioned | - |
| 3 | Authentication → Settings → Authorized domains: add every real domain the app will be served from (plus `localhost` for local dev) | Not provisioned | - |
| 4 | Copy the real client config (`apiKey`, `authDomain`, `projectId`, etc.) into `www/firebase-config.js` | Not done | `www/firebase-config.js` (blank fields, safe to fill - these are public, client-side values) |
| 5 | Generate a service-account key (Project settings → Service accounts → Generate new private key) | Not done | store as `GOOGLE_APPLICATION_CREDENTIALS` path, or split into `FIREBASE_PROJECT_ID`/`FIREBASE_CLIENT_EMAIL`/`FIREBASE_PRIVATE_KEY` in `.env` |
| 6 | Set the three discrete `FIREBASE_*` vars **or** `GOOGLE_APPLICATION_CREDENTIALS` in `.env` (never both committed, never committed at all) | Not done | `lib/firebaseAdmin.js` already reads either form correctly, tries `GOOGLE_APPLICATION_CREDENTIALS` first |
| 7 | Restart the backend and confirm `configured === true` (no more 503 on `/api/auth/me`) | Not done - can't verify without step 6 | `middleware/auth.js` |
| 8 | Real Google popup sign-in in a real browser | NOT RUN | `www/auth.js`, `signInWithGoogle()` |
| 9 | Popup-blocked fallback to `signInWithRedirect` | automated (mocked) only | `www/auth.js` |
| 10 | ID token attaches to `/api/chat*` requests as `Authorization: Bearer <token>` | real (mechanism), NOT RUN (real token) | `www/auth.js` |
| 11 | Backend verifies the real token and populates `req.user` | NOT RUN | `middleware/auth.js` |
| 12 | `GET /api/auth/me` returns the real verified identity | NOT RUN | `server.js` |
| 13 | Guest/signed-in LocalStorage namespace isolation with a real account | real (structural, mocked identity) | `tests/chatStore.test.js` |
| 14 | Logout clears session and returns to guest state | automated (mocked) only | `www/auth.js` |
| 15 | (Optional) enable `FIREBASE_CHECK_REVOKED=true` and confirm a revoked token is actually rejected | Not done - needs a real revoked token | `lib/firebaseAdmin.js` |
| 16 | Register Android SHA-1/SHA-256 fingerprints for native Google sign-in (see `docs/android-capacitor-checklist.md`) | Not provisioned | Firebase Console → Project settings → Android app |

## What is already correct without a real project (source-verified)

- `lib/firebaseAdmin.js`: tries `GOOGLE_APPLICATION_CREDENTIALS` first, falls
  back to the three discrete vars, normalizes `\n`-escaped private keys,
  guards against double-initialization, never logs the credential itself,
  fails to an honest `configured = false` (503 on protected routes, guest
  chat unaffected) rather than crashing.
- `middleware/auth.js`: never trusts client-supplied identity - `req.user`
  is only ever populated from a cryptographically verified token; every
  verification failure maps to a generic, safe message, never the raw
  Firebase error.
- `www/auth.js`: `safeError()` maps every known Firebase error code to a
  safe message, and (a real bug found and fixed in Phase 8) any *unmapped*
  code now also gets the fixed generic message instead of leaking raw
  Firebase error text.

## What a real verification pass will need

1. A real Firebase project with Google sign-in enabled and the right
   authorized domains (items 1-3 above).
2. Real values in `www/firebase-config.js` and `.env` (items 4-6).
3. Re-run `e2e/auth-error-matrix.js` and manually walk items 8-14 above in
   a real browser with a real Google account.
