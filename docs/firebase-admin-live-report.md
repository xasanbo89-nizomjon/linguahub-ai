# Firebase Admin Live Verification Report (Phase 10, Task 6)

## Status: BLOCKED - no real Admin credentials; backend logic re-verified

Same environment state as `docs/firebase-live-login-report.md`: no
`GOOGLE_APPLICATION_CREDENTIALS` and none of the three discrete
`FIREBASE_*` server variables are set. `lib/firebaseAdmin.js`'s own
`isConfigured()` therefore returns `false`, confirmed live via the
backend's own startup warning, unchanged this phase:

```
⚠️  Firebase Admin is not configured (set GOOGLE_APPLICATION_CREDENTIALS, or
FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY).
Authenticated-only routes will respond 503 until configured; guest chat is
unaffected.
```

## What was re-verified this phase (source + automated, not real credentials)

`lib/firebaseAdmin.js` was re-read in full this phase, alongside
`middleware/auth.js`, to confirm nothing regressed from Phase 8/9 and that
the code is genuinely ready for real credentials whenever they're
provided:

| Requirement | Verified |
|---|---|
| Tries `GOOGLE_APPLICATION_CREDENTIALS` first | ✅ source |
| Falls back to the three discrete `FIREBASE_*` vars | ✅ source |
| Normalizes `\n`-escaped private keys | ✅ `normalizePrivateKey()`, source |
| Guards against double-initialization | ✅ `if (!admin.apps.length)`, source |
| Never logs the credential itself | ✅ only `error.message` on init failure, source |
| Fails to an honest `configured = false` rather than crashing | ✅ re-confirmed live this phase (backend starts and serves guest chat normally with the warning above) |
| `verifyIdToken` throws a distinguishable, safe error when unconfigured | ✅ `auth/admin-not-configured` code, mapped to a 503 with a safe message, never a raw error - `middleware/auth.js`'s `mapVerifyError()` |
| `FIREBASE_CHECK_REVOKED` wiring exists | ✅ source (`admin.auth().verifyIdToken(idToken, CHECK_REVOKED)`) - not exercised against a real revoked token this phase, same as every prior phase |

## Real tests run this phase (real backend, real requests, mocked/absent Firebase)

| Test | Result |
|---|---|
| Valid mocked token → `/api/auth/me` returns the identity from the verified token | ✅ `tests/auth.test.js` |
| Frontend-supplied identity (query params) is ignored - uid always from the verified token | ✅ `tests/auth.test.js` |
| `/api/chat` (optional auth) accepts a request carrying a valid token without changing the existing validation contract | ✅ `tests/auth.test.js` |
| `/api/chat` still works as a guest even with a garbage token (fails open, not 401) | ✅ `tests/auth.test.js` |
| `/api/auth/me` with no token → 401, safe message | ✅ `e2e/auth-error-matrix.js` (real browser + real backend) |
| `/api/auth/me` with an invalid/garbage token → 503 (admin-not-configured), no raw error | ✅ `e2e/auth-error-matrix.js` |
| `/health` remains public and unauthenticated regardless of Admin config state | ✅ `tests/auth.test.js` |
| CORS preflight for `/api/auth/me` allows the `Authorization` header | ✅ `tests/auth.test.js` |
| No raw Firebase error, private key, token, or stack trace ever reaches a client response | ✅ verified by source (every error path in `middleware/auth.js` maps to a fixed safe string) and by the real 503 bodies observed above containing only the safe message |

**Required auth route fails clearly with 503 when Firebase Admin is not
configured, without crashing guest routes** - re-confirmed this phase,
`tests/auth.test.js`, 12/12 passing.

## What could not be verified without real credentials

Loading a real service-account file or a real project's discrete env
vars, a real backend-restart-reloads-config check against real
credentials, revoked-token checking against a real revoked token, and the
success path of `/api/auth/me` and protected chat requests (a real,
valid, cryptographically verified token reaching the backend). All are
**NOT RUN**, unchanged from every prior phase, for the same reason: no
real Firebase project exists in this environment.

## What a real verification pass will need

1. A real Firebase project with a service-account key generated (Project
   settings → Service accounts → Generate new private key).
2. Either `GOOGLE_APPLICATION_CREDENTIALS` pointing at that key file, or
   the three discrete `FIREBASE_*` values, in `.env` (never committed).
3. Restart the backend and confirm the startup warning above disappears.
4. Re-run `e2e/auth-error-matrix.js` and manually complete a real login to
   exercise the success paths listed as NOT RUN above.
