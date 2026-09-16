# Firebase Real Verification (Phase 8)

## Status: no real Firebase project configured — real login NOT RUN

Checked directly at the start of Phase 8, the same way as Phase 7:

```
$ grep -oE '^[A-Z_]+=' .env
OPENAI_API_KEY=
$ env | grep -iE "firebase|google_app"
(nothing)
$ cat www/firebase-config.js   # every field still ""
```

No real Firebase client config or Admin credentials were provided anywhere in this session (not in `.env`, not as environment variables, not pasted into the conversation). Per the phase's own instructions, real credentials are never invented — this document records exactly what that means was and wasn't verified.

## Client configuration (Task 2): NOT RUN (real), source-verified

`www/firebase-config.js` ships blank; `www/auth.js` correctly detects this (`hasUsableConfig()`) and reports `isAvailable() === false`. This was re-confirmed live in a real browser this phase (see `e2e/auth-error-matrix.js`, check "missing Firebase config: sign-in button is honestly disabled with a clear message" — **real**, passing).

What could not be verified without a real project: duplicate-initialization guarding against a *real* `firebase.apps.length` (the guard exists and is exercised by a mocked-Firebase unit test — **automated** — but never against the real SDK), browser persistence behavior (Firebase's own IndexedDB-backed default — never exercised), and the unauthorized-domain error path (needs a real project with a real authorized-domains list to trigger).

## Admin configuration (Task 3): NOT RUN (real), source-verified

`lib/firebaseAdmin.js` was re-read in full this phase. It already correctly: tries `GOOGLE_APPLICATION_CREDENTIALS` first, falls back to the three discrete `FIREBASE_*` variables, normalizes `\n`-escaped private keys, guards against double-initialization (`if (!admin.apps.length)`), never logs the credential itself (only `error.message` on failure), and fails to an honest `configured = false` state (503 on protected routes, guest chat unaffected) rather than crashing. None of this required a code change - it was already correct from Phase 2. This project's actual current state (`configured === false`) was re-confirmed live via `tests/auth.test.js`'s "required auth route fails clearly with 503..." test (**automated**, mocked Firebase Admin, passing) and via a real backend request in `e2e/auth-error-matrix.js` (**real**, passing).

What could not be verified: loading a *real* service-account file or a real project's discrete env vars, a real backend-restart-reloads-config check against real credentials, revoked-token checking (`FIREBASE_CHECK_REVOKED=true`, code path exists and is wired to `admin.auth().verifyIdToken(idToken, checkRevoked)` but has never been exercised against a real revoked token).

## Real Google login end-to-end (Task 4): NOT RUN

None of the 20 checklist items in the phase instructions could be exercised for real - they all require an actual Google account picker, which requires a real, authorized Firebase project. Exact blocker: no real Firebase project exists in this environment, and none was provided.

What WAS verified for the parts of this flow that don't require a real project:

| Item | Classification | Result |
|---|---|---|
| Login button visible | real | Visible, correctly `disabled` |
| Login loading state | source-only | `loginInProgress` guard reviewed, not exercised without a real click flow |
| Google popup opens | NOT RUN | needs real project |
| Popup cancellation handled | automated (mocked) | `tests/frontend-auth.test.js`, `auth/popup-closed-by-user` maps to "Sign-in was cancelled." |
| Popup blocked handled | automated (mocked) | falls back to `signInWithRedirect` correctly (new Phase 8 test) |
| Unauthorized domain handled | automated (mocked) | maps to a safe, clear message (new Phase 8 test) |
| Successful login returns user | NOT RUN | needs real project |
| Avatar/name/email display | source-only | `renderSignedIn()` reviewed; textContent-only (no innerHTML), so a malicious display name can't inject markup - not exercised with a real user |
| Refresh restores session | NOT RUN | needs a real persisted Firebase session |
| ID token attached to API request | real | confirmed via `Authorization: Bearer <token>` header logic; exercised with a *mocked* token value in `tests/frontend-auth.test.js`, and confirmed the header is correctly ABSENT for a real guest in a real browser (`e2e/auth-error-matrix.js`) |
| Backend verifies token | real (for the "fails safely" direction) | a real invalid/garbage/expired-shaped token sent to the real, unconfigured backend correctly gets 503, not a crash - `e2e/auth-error-matrix.js` |
| `/api/auth/me` returns verified user | NOT RUN (success path) | needs a real, configured Admin SDK; the failure path IS verified real |
| Logout works | automated (mocked) + real (UI) | mocked Firebase signOut is called correctly; a real click on the disabled-state Logout control isn't applicable since no session exists to log out of |
| Logout aborts active generation | real | `tests/frontend-auth.test.js`, "app.js: logout aborts an active streaming generation" - genuinely exercises the abort wiring, independent of whether Firebase itself is real |
| Guest/user history isolation | real (structural) | `tests/chatStore.test.js`, "guest and user namespaces are isolated from each other" - exercises the real namespacing logic without needing a real login |
| Switching account changes namespace | NOT RUN | needs two real accounts |
| No token in LocalStorage chat data | real | `e2e/security.js`, scans real LocalStorage chat-history keys for token-shaped values after a real send/save cycle - none found |
| No raw token in console/network logs | source-only + automated | `www/auth.js` never logs a token value anywhere (only `error.code`/`error.message` on failure); `middleware/auth.js` logs only `error?.code`, never the token or the full error object - verified by reading the actual source, not by capturing real console output during a real login (none occurred) |

## Auth error matrix (Task 5)

See `docs/phase-08-final-hardening.md` §Auth error matrix for the full table. Summary: everything reachable without a real Firebase project was tested for real or automated; everything requiring a real popup/redirect/revoked-token was left NOT RUN and is listed as such, never faked.

**One real, confirmed bug was found and fixed here**: `www/auth.js`'s `safeError()` helper fell back to the raw Firebase error's own `.message` for any error code not in its small safe-message allowlist - meaning most real Firebase error codes (anything outside the ~6 explicitly mapped ones) would have shown the user raw internal Firebase error text instead of a safe message. Found by a new test (`tests/frontend-auth.test.js`, "an unrecognized/unknown Firebase error code still gets a safe generic message") that intentionally used an error code outside the mapped set - the test failed against the *old* code, confirming the bug was real, not hypothetical. Fixed by removing the raw-message fallback entirely; unmapped codes now always get the fixed generic message.

## What a real verification pass will need

1. A real Firebase project (Console → Authentication → Sign-in method → enable Google; add authorized domains) — see `docs/firebase-setup.md`.
2. Real values in `www/firebase-config.js` (public, safe to have client-side).
3. Real Admin credentials in `.env` (`GOOGLE_APPLICATION_CREDENTIALS` or the three `FIREBASE_*` vars) — private, server-only.
4. Re-run `e2e/auth-error-matrix.js` and manually walk the Task 4 checklist in a real browser with a real Google account.
