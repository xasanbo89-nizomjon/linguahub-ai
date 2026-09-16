# Phase 1 — Audit and Stabilization (LinguaHub AI, formerly Xasan AI / Hasan AI)

Date: 2026-08-05

## 1. Project structure summary

This is a small, dependency-light project — not a bundler/framework app. Actual layout (build artifacts and `node_modules` omitted):

```
index.html                  Redirect stub -> www/index.html (used when the repo root is served)
main.js                     Electron main process, loads www/index.html via file://
server.js                   Express backend (static hosting + OpenAI chat API)
capacitor.config.json       Capacitor shell config (webDir: www)
package.json                npm scripts, Electron Builder config, dependencies
www/index.html              The entire frontend app: markup + CSS + JS in one file
www/config.js                *** NEW *** centralized API base URL resolver
android/                    Generated Capacitor Android project (native build files)
tests/                      *** NEW *** regression tests (Node built-in test runner)
docs/                       *** NEW *** this document
.env / .env.example         Backend secrets (.env is git-ignored; .env.example is new)
```

There is exactly **one** frontend page and **one** backend file. No client-side router, no SPA framework, no build step, no bundler. `www/index.html` is served both by Express (`express.static`) and loaded directly by Electron (`file://`) and Capacitor (bundled webview assets).

Technologies actually present in the code: HTML/CSS/JS, Node.js/Express, the `openai` SDK, `cors`, `dotenv`, Electron, Capacitor (Android only — no `ios/` folder present), SSE-style streaming over `fetch`.

Technologies mentioned in the project brief but **not present** in the current codebase (confirmed by repo-wide search): Firebase / Google Authentication, PostgreSQL, LocalStorage. No `firebase`, `pg`, or `localStorage` reference exists anywhere in the source. These are documented here as an honest gap rather than being fabricated — no placeholder/fake code was added for them (see rules in the task brief: no fake functionality, no placeholder code).

## 2. Root cause of the 405 error

**File:** `www/index.html` (the inline `<script>` block), pre-existing logic that computed the API base URL:

```js
const API_BASE = (() => {
  const { protocol, hostname, port } = window.location;
  if ((protocol === "http:" || protocol === "https:") && port === "3000") {
    return "";
  }
  return "http://127.0.0.1:3000";
})();
```

At the time of this audit, this logic **already correctly redirected requests away from port 5500** for the specific case described in the bug report (Live Server on `127.0.0.1:5500` → falls into the `else` branch → `http://127.0.0.1:3000`). Live verification (curl simulating a request from `Origin: http://127.0.0.1:5500` straight to `http://127.0.0.1:3000/api/chat/stream`) confirms the POST reaches Express and is validated (400 for an empty test message), not rejected with 405. Nothing currently listens on port 5500 for `/api/chat/stream`, so a request literally sent there would fail with connection-refused, not a same-origin 405 — consistent with the frontend not being misconfigured to call `:5500` for this specific dev topology.

However, the original logic had a **real, unfixed defect matching the spirit of the bug report**: it hardcoded the literal string `"3000"` and only recognized "same-origin" when the port was exactly `3000`. Any other deployment — Express run on a different `PORT` (e.g. `4000`), or a genuine production domain served over `https://` with no explicit port — fell through to the `else` branch and got a **hardcoded `http://127.0.0.1:3000`**, i.e. exactly the "production fallback to localhost" anti-pattern the task explicitly warns against. That would misroute production requests to a URL that doesn't exist outside the developer's own machine.

**Fix implemented:** replaced the inline logic with a centralized, testable resolver (`www/config.js`, loaded via `<script src="config.js"></script>` before the app script) that:
- Explicitly recognizes known local dev static-file ports (`5500`, `5501` — VS Code Live Server defaults) and routes them to the local backend default, regardless of what port the backend itself runs on.
- Treats "served by this Express instance" as same-origin (relative URL) for **any** loopback or production origin that isn't a known dev-frontend port — so it no longer hardcodes `3000`.
- Recognizes Electron (`file:`), Capacitor iOS (`capacitor://`), and Capacitor Android's default webview origin (`https://localhost`, no port) and routes all three to the local backend default.
- Never returns a hardcoded `127.0.0.1`/`localhost` URL for a real production domain.
- Supports an explicit override via `window.LINGUAHUB_CONFIG.API_BASE_URL`, settable in an inline script before `config.js` loads — for future split-origin deployments (frontend and backend on different hosts).

This is unit-tested directly (`tests/config.test.js`, 11 cases covering every branch above) and is the single source of truth — no other file duplicates an API base URL constant.

## 3. Bugs found

1. **Hardcoded-port / production-localhost-fallback defect** in the original inline `API_BASE` resolver (`www/index.html`) — described above. Real, would misroute in production or on a non-3000 `PORT`.
2. **No centralized/testable API config** — the URL-resolution logic lived inline inside a `<script>` tag with no way to unit test it or override it for split-origin deployments.
3. **Premature stream-abort bug I introduced and caught during live verification**: my first attempt at SSE cancellation cleanup listened on `req.on("close")`. In Node/Express, a request's `close` event fires as soon as the (small, already-buffered) JSON body has been fully read — almost immediately — **not** when the client actually disconnects. This caused every streaming request to abort itself instantly, hang with no data and no error, and never close the connection. Caught via a real end-to-end streaming test against the live server (see §10) and fixed by listening on `res.on("close")` instead, which correctly fires when the underlying connection actually closes. Verified fixed with both a successful full-stream test and a genuine mid-stream client-abort test.
4. **No message length limit** — `validateChatBody` accepted any non-empty string up to the 10 MB JSON body limit, allowing a single request to consume arbitrarily large amounts of OpenAI tokens/cost.
5. **No rate limiting** on the chat endpoints.
6. **No centralized error handler** — malformed JSON bodies, oversized payloads, and blocked CORS origins all fell through to Express's default error handler (inconsistent, non-JSON in some cases).
7. **No `/api/*` 404 handler** — unmatched API routes fell through to Express's default HTML 404 page instead of a consistent JSON response.
8. **No `.env.example`** existed, so required configuration wasn't discoverable without reading `server.js` source.
9. **No environment validation** — a missing `OPENAI_API_KEY` produced no warning until the first chat request failed.
10. **Product name inconsistency** — "Xasan AI" / "Xasan AI Ultra" appeared across the page title, header, status text, health response, system prompts, Electron `productName`, Capacitor `appName`, and Android `strings.xml`, not matching the intended "LinguaHub AI" branding.

No SPA-fallback/wildcard route bug, no `/api/api` duplication, and no GET-only route mismatch were found — the routing was already structurally correct (see §8).

## 4. Bugs fixed

All ten items in §3 were fixed. See §5 for the exact file-by-file changes.

## 5. Files modified

| File | Reason | Type of change |
|---|---|---|
| `www/index.html` | Use centralized config instead of inline URL logic; rename branding | Replaced inline `API_BASE` IIFE with `<script src="config.js">` + `apiUrl()` helper; updated `<title>`, `<h1>`, and busy-status text to "LinguaHub AI" |
| `server.js` | Fix streaming-cancellation bug, add security hardening, centralize errors, rename branding, make testable | See detailed list below |
| `package.json` | Rename user-facing branding, add test script | `description` and `build.productName` → "LinguaHub AI"; added `"test": "node --test"`. `name` ("xasan-ai") and `build.appId` ("com.xasan.ai") intentionally **left unchanged** — see §10/rename policy below |
| `capacitor.config.json` | Rename user-facing app name | `appName` → "LinguaHub AI". `appId` ("com.xasan.ai") intentionally **left unchanged** |
| `android/app/src/main/res/values/strings.xml` | Rename user-facing Android app name | `app_name` and `title_activity_main` → "LinguaHub AI". `package_name`/`custom_url_scheme` ("com.xasan.ai") intentionally **left unchanged** — they must match `applicationId`/`namespace` in `android/app/build.gradle` |
| `index.html` (repo-root redirect stub) | Rename branding | `<title>` and link text → "LinguaHub AI" |

`server.js` changes in detail:
- Added a startup warning (`console.warn`) if `OPENAI_API_KEY` is missing.
- `ALLOWED_ORIGINS` is now `DEFAULT_ALLOWED_ORIGINS` (unchanged defaults) merged with an optional `FRONTEND_ORIGINS` env var (comma-separated), deduplicated. No behavior change unless the new env var is set.
- `/health` now returns `{ status, service: "linguahub-ai", timestamp, environment }` instead of `{ status, service: "Xasan AI Ultra" }`.
- `SYSTEM_PROMPTS` persona text renamed from "Xasan …" to "LinguaHub …" (content only — keys/structure unchanged).
- Added `MAX_MESSAGE_LENGTH` (default 8000 chars, env-overridable) enforced in `validateChatBody`.
- Added `chatRateLimiter` — an in-memory, per-IP sliding-window limiter (default 30 requests / 60s, env-overridable), applied to `/chat`, `/api/chat`, and `/api/chat/stream`.
- Fixed the streaming-cancellation listener (`req.on("close")` → `res.on("close")`, see bug #3 above) and guarded `res.write`/`res.end` calls with `res.writableEnded` checks.
- Added a JSON 404 handler scoped to `/api/*`.
- Added a centralized 4-arg Express error handler (malformed JSON → 400, oversized body → 413, blocked CORS origin → 403, anything else → 500) — all JSON, no stack traces or internal paths exposed to the client.
- Wrapped `app.listen(...)` in `if (require.main === module)` and added `module.exports = app;` so the app can be imported and tested without binding a port — **no behavior change when run normally via `node server.js`**.

## 6. Files created

| File | Purpose |
|---|---|
| `www/config.js` | Centralized, unit-testable API base URL resolver (see §2, §7) |
| `.env.example` | Documents required/optional backend env vars with no real secrets |
| `tests/config.test.js` | 11 unit tests for the API URL resolution logic |
| `tests/server.test.js` | 11 integration tests for Express routing, CORS, validation, error handling, and rate limiting |
| `docs/phase-01-audit-and-stabilization.md` | This document |

## 7. API URL behavior

Resolution logic lives in `www/config.js` (`computeApiBase`), applied once per page load into `window.LINGUAHUB_CONFIG.API_BASE_URL` / `.apiUrl(path)`.

| Context | `location` | Resolved base |
|---|---|---|
| Live Server dev frontend | `http://127.0.0.1:5500` or `http://localhost:5500` | `http://127.0.0.1:3000` |
| Served by Express itself (dev or prod, any port) | `http://<host>:<any-port>` | `""` (same-origin relative) |
| Production domain, no override | `https://app.example.com` | `""` (same-origin relative — never a hardcoded localhost URL) |
| Electron | `file://...` | `http://127.0.0.1:3000` |
| Capacitor iOS | `capacitor://localhost` | `http://127.0.0.1:3000` |
| Capacitor Android (default webview) | `https://localhost` (no port) | `http://127.0.0.1:3000` |
| Any of the above, with `window.LINGUAHUB_CONFIG = { API_BASE_URL: "..." }` set before `config.js` loads | — | the explicit override (trailing slash stripped) |

This matches the project's actual architecture: Express serves both the static frontend and the API from the same origin (`app.use(express.static(...))` in `server.js`), so same-origin relative URLs are the correct default for both dev-served-by-Express and production, without needing per-environment configuration. A split-origin deployment (frontend on a separate static host from the API) is supported via the explicit override, documented in `www/config.js`'s header comment.

## 8. Express routing

Final middleware/route order in `server.js` (top to bottom):

1. `dotenv` config load, `OPENAI_API_KEY` presence warning
2. `cors(...)` — origin allow-list (defaults + `FRONTEND_ORIGINS`)
3. `express.json({ limit: "10mb" })`
4. `express.static(www/)`
5. `GET /health`
6. `POST /chat` (legacy), `POST /api/chat`, `POST /api/chat/stream` — each behind `chatRateLimiter`
7. `app.use("/api", ...)` — JSON 404 for anything under `/api/*` not matched above
8. Centralized error-handling middleware (4-arg, last)
9. `app.listen(PORT)` only when run directly (`require.main === module`)

No route duplication exists: there is no `app.use('/api', router)` combined with a router that also prefixes `/api`, so `/api/api/chat/stream` is not reachable. No SPA wildcard route exists (this isn't a client-routed SPA), so `express.static` — which only ever handles `GET`/`HEAD` — can never intercept the `POST /api/chat/stream` request; this was confirmed empirically (§13).

## 9. CORS, Helmet, and CSP

**CORS:** origin allow-list, unchanged defaults (`http://127.0.0.1:5500`, `http://localhost:5500`, `http://127.0.0.1:3000`, `http://localhost:3000`, `capacitor://localhost`, `http://localhost`) plus an optional `FRONTEND_ORIGINS` env var for production origins. No `Origin` header (Electron `file://`, curl, native webviews) is allowed through; unrecognized origins get a clean 403 JSON via the new centralized error handler (previously an unstyled 500). Preflight `OPTIONS` requests are handled by the `cors` package and verified live (§13) to return `204` with the correct `Access-Control-Allow-*` headers, including `Content-Type`.

**Helmet / CSP:** **not present in this codebase** — `helmet` is not a dependency, and no CSP headers are set anywhere in `server.js`. The task brief assumed Helmet/CSP were already part of the stack; a repo-wide search confirms they are not. Per the "no fake functionality / no placeholder code" rule, **Helmet and CSP were not added in this phase**, since doing so would be a new security-posture feature (with real risk of breaking the existing inline `<script>` in `www/index.html`, which has no nonce/hash infrastructure) rather than a fix to something broken. This is flagged as a concrete Phase 2 recommendation (§17), not silently skipped.

Similarly, **Firebase Google Auth is not present** in the code, so there was nothing to verify CSP compatibility against.

## 10. Streaming verification

- **Route:** `POST /api/chat/stream`, headers `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, headers flushed via `res.flushHeaders()` — all confirmed via live `curl -i` (§13).
- **Parser:** frontend buffers by `\n\n`-delimited SSE events, parses `data: {...}` JSON, handles `[DONE]` and `{error}` payloads. Unchanged from the pre-existing implementation (it was already correct) except the URL is now built via `apiUrl()`.
- **Cancellation:** fixed a real bug during this phase — see §3, item 3. Backend now correctly aborts the upstream OpenAI request (`AbortSignal` passed into `openai.chat.completions.create`) when the response connection closes, verified with a genuine mid-stream client abort (curl `timeout 1.2s`) that left the server logging nothing, crashing nothing, and still answering `/health` immediately after.
- **No stop button exists in the current UI.** There is only a single disable-while-busy "Send" button; no cancel/stop control was present before this phase. Per the "do not add features beyond what's required" and "do not create fake functionality" rules, **no stop button was added** — the backend-side cancellation plumbing above is real and tested, but nothing in the current UI triggers it yet (only a manual network/tab close would). This is called out explicitly as a Phase 2 UI item (§17), not silently claimed as done.
- **Provider test status:** ✅ **RUN** — a real end-to-end streaming call was made against the live OpenAI API (credentials were available in `.env`), requesting the single word "OK"; the server returned `data: {"delta":"OK"}` followed by `data: [DONE]` and closed cleanly.

## 11. Authentication regression status

No authentication system (Firebase or otherwise) exists in the current codebase — confirmed by repo-wide search (§1). There is nothing to regress and nothing to verify here; this is not a gap introduced by this phase, it reflects the actual starting state. Documented explicitly rather than silently assumed.

## 12. Security improvements

- Chat message length capped (`MAX_MESSAGE_LENGTH`, default 8000 chars) — prevents unbounded-cost single requests.
- Per-IP rate limiting added to all three chat routes (no new dependency; in-memory sliding window).
- Malformed JSON, oversized bodies, and blocked CORS origins now return safe, consistent JSON errors instead of Express's default (potentially HTML/stack-trace-bearing) error page.
- Startup warning when `OPENAI_API_KEY` is missing, instead of silent failure on first request.
- `/health` no longer risks leaking anything beyond status/service/timestamp/environment (it never did leak secrets, but the shape is now explicit and tested to not contain `sk-`-prefixed content).
- Confirmed (unchanged, already correct): the OpenAI API key is backend-only, never sent to or readable from the frontend; the model is hardcoded server-side (frontend cannot choose a model); system prompts are selected from a fixed server-side dictionary keyed by `mode` (frontend cannot inject an arbitrary system prompt).

## 13. Tests and commands run

```
node --test
node server.js                                   # background, for live verification
curl -s -i http://127.0.0.1:3000/health
curl -s -i -X OPTIONS http://127.0.0.1:3000/api/chat/stream -H "Origin: http://127.0.0.1:5500" -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: Content-Type"
curl -s -i -X POST http://127.0.0.1:3000/api/chat/stream -H "Origin: http://127.0.0.1:5500" -H "Content-Type: application/json" -d '{"message":""}'
curl -s -i http://127.0.0.1:3000/api/chat/stream                      # GET, wrong method
curl -s -i --max-time 2 http://127.0.0.1:5500/api/chat/stream         # confirm nothing listens on 5500
curl -s -N --max-time 20 -X POST http://127.0.0.1:3000/api/chat/stream -H "Origin: http://127.0.0.1:5500" -H "Content-Type: application/json" -d '{"message":"Reply with exactly the single word: OK"}'   # real OpenAI streaming test
timeout 1.2 curl -s -N --max-time 20 -X POST http://127.0.0.1:3000/api/chat/stream ... # mid-stream client abort
node -e "JSON.parse(require('fs').readFileSync('capacitor.config.json','utf8'))"
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"
```

## 14. Test results

- `node --test`: **22/22 passed**, 0 failed, 0 skipped (11 in `tests/config.test.js`, 11 in `tests/server.test.js`).
- `GET /health`: **200**, correct JSON shape, no secret leakage — **PASS**.
- CORS preflight from `http://127.0.0.1:5500`: **204**, correct `Access-Control-Allow-*` headers — **PASS**.
- `POST /api/chat/stream` from `Origin: http://127.0.0.1:5500` to port `3000`: reaches Express, validated (400 for empty test message, not 404/405) — **PASS** (this is the exact bug scenario from the report).
- `GET /api/chat/stream`: **404** JSON, not a crash, not HTML — **PASS** (see §3/§14 note: this is 404, not a literal 405; both are safe/non-crashing, true 405 semantics were not implemented — noted as a minor Phase 2 polish item, not claimed as fixed).
- Nothing listens on port `5500` for `/api/chat/stream` — **PASS**.
- Real OpenAI streaming round trip: **PASS** (RUN, not mocked — credentials were available).
- Mid-stream client abort: server does not crash, logs nothing alarming, `/health` immediately responsive afterward — **PASS**.
- Electron/Capacitor/Android config files (`capacitor.config.json`, `package.json`, `strings.xml`) still parse/are well-formed after rename edits — **PASS**.
- Interactive Google/Firebase login: **NOT RUN** — no Firebase code exists in this project (see §11); not applicable.
- Browser-level UI test (clicking Send in an actual browser tab): **NOT RUN** — no headless browser tooling (Puppeteer/Playwright) is installed in this project and none was added, per "don't add a large testing framework if one doesn't already exist." The equivalent behavior was verified at the HTTP layer instead (curl simulating the exact browser request), which is the layer where the reported bug and its fix actually live.
- Electron app launch / Capacitor Android build: **NOT RUN** — launching Electron or running a Gradle build was out of scope ("do not deploy"); source-level configuration was verified instead (main.js loads `www/index.html` unchanged; `capacitor.config.json` still valid JSON; native Android `strings.xml` updated but not rebuilt/synced, since `npx cap sync` / Gradle build would touch generated build artifacts outside this phase's scope).

## 15. Limitations

- The in-memory rate limiter and origin allow-list only work correctly for a single Node process; a multi-instance/load-balanced production deployment would need a shared store (Redis, etc.) — noted, not implemented, since this project runs as a single process today.
- No stop/cancel UI control exists (§10) — the backend cancellation path is real and tested, but nothing in the UI calls it yet.
- Helmet/CSP and Firebase Auth are absent, as they were in the starting codebase (§9, §11) — not added, since the brief's "current stack" description didn't match the actual repository content for these items.
- Packaged/installed Electron builds (via `electron-builder`) do not bundle or launch `server.js` — the desktop app still expects a backend already running at `127.0.0.1:3000` (via `npm start`, which runs both concurrently). This is a pre-existing architectural characteristic, not something introduced or changed in this phase; flagged for Phase 2 if a fully standalone desktop build is desired.
- True HTTP `405 Method Not Allowed` semantics were not implemented for wrong-method requests to `/api/chat/stream` — it currently returns `404` (via the new `/api/*` catch-all), which is safe and non-crashing but not strictly RFC-precise.

## 16. Changed-file inventory

Modified: `www/index.html`, `server.js`, `package.json`, `capacitor.config.json`, `android/app/src/main/res/values/strings.xml`, `index.html`.
Created: `www/config.js`, `.env.example`, `tests/config.test.js`, `tests/server.test.js`, `docs/phase-01-audit-and-stabilization.md`.
Untouched (intentionally, per the "don't rename internal identifiers" rule): `main.js`, `package.json`'s `name` field, `package.json`'s `build.appId`, `capacitor.config.json`'s `appId`, `strings.xml`'s `package_name`/`custom_url_scheme`, `android/app/build.gradle`, all of `node_modules/`, `package-lock.json`.

## 17. Rollback notes

Every change in this phase is a source-level edit to plain-text files (no migrations, no schema changes, no data mutation, no dependency version bumps — no new npm packages were installed). To roll back: revert the six modified files and delete the five created files listed in §16. `.env` (real secrets) was never touched. No git commit was created in this phase (per instructions), so the working tree can be restored file-by-file if needed.
