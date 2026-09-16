# Production Environment Configuration (Phase 11)

This document explains every server-side environment variable this
project recognizes, how it's validated, and what happens when it's
missing or malformed. Validation itself lives in `lib/env.js`
(`validateEnv()`), called once at `server.js` startup - never per-request,
never printing a secret value, never silently accepting a broken
production configuration.

## Validation philosophy

- **In production** (`NODE_ENV=production`): a missing or malformed
  *required* value is a loud startup failure - `server.js` logs every
  error and exits with code 1 before ever calling `app.listen()`. A
  production deployment that starts at all has already passed validation.
- **Outside production**: the same checks run, but problems become
  warnings, not failures - local development never needs a full
  production-shaped `.env`.
- **Never a secret value in a log line**: `lib/env.js`'s `summary` object
  reports only presence and length (`"(set, length 51)"` /
  `"(unset)"`), never the value itself. This is what `server.js` logs at
  startup - re-run `node server.js` and inspect the "server started" log
  line to see exactly what a real deployment would report.

## Variables

| Variable | Required in production? | Default | Notes |
|---|---|---|---|
| `NODE_ENV` | recommended | `development` | Anything other than `development`/`production`/`test` is a warning, treated as development-shaped. |
| `PORT` | no | `3000` | Must be an integer 1-65535. |
| `FRONTEND_ORIGINS` | **yes** | *(none - local dev origins only)* | Comma-separated list of exact `https://host` / `http://host` origins (no path/query/trailing slash). A malformed entry is a hard error in every `NODE_ENV`. In production, an **empty** list is a hard error too - see "Why FRONTEND_ORIGINS is required in production" below. |
| `OPENAI_API_KEY` | **yes** | *(none)* | Chat requests fail without it either way; only *startup* behavior differs (warning in dev, hard error in production). |
| `DATABASE_URL` | no | *(unset)* | **Currently unused** - see `docs/phase-11-production-preparation.md`, Task 11, and the "Database" section below. Setting it produces an honest warning that it has no effect yet, never a claim of active persistence. |
| `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` | no (optional feature) | *(unset)* | All three together, or `GOOGLE_APPLICATION_CREDENTIALS` alone, enable Firebase Admin. Setting *some but not all* three is a warning (a likely misconfiguration) - see `docs/firebase-production-checklist.md`. |
| `GOOGLE_APPLICATION_CREDENTIALS` | no | *(unset)* | Path to a service-account JSON key file; takes precedence over the three discrete vars if both are set. |
| `RATE_LIMIT_WINDOW_MS` | no | `60000` | The chat-endpoint rate-limit window, in ms. Must be a positive integer. |
| `RATE_LIMIT_MAX_REQUESTS` | no | `30` | Max chat requests per key (uid or IP) per window. |
| `DEEP_THINKING_RATE_LIMIT_MAX_REQUESTS` | no | `10` | A stricter, separate budget that only counts Deep Thinking mode requests - see `docs/production-rate-limiting.md`. |
| `GENERAL_RATE_LIMIT_MAX_REQUESTS` | no | `300` | A basic per-IP request budget applied to *every* route (including static assets and health checks) as a DoS backstop. |
| `RATE_LIMIT_STORE_URL` | no | *(unset)* | A shared store URL (e.g. `redis://...`) for a horizontally-scaled, multi-instance deployment. Validated as a well-formed URL if set; see `docs/production-rate-limiting.md` for exactly what is and isn't wired up around it. |
| `REQUEST_TIMEOUT_MS` | no | `120000` | Bounds any single HTTP request/response cycle at the Node `http.Server` level (`server.requestTimeout`) - distinct from each AI mode's own generation timeout in `lib/aiModes.js`. |
| `TRUST_PROXY` | recommended behind a reverse proxy | `0` (trust nothing) | `"true"` (unbounded chain, warned about) or a non-negative integer hop count (e.g. `"1"` for exactly one reverse proxy). See `docs/production-network-and-cors.md`. |
| `LOG_LEVEL` | no | `info` | One of `debug`/`info`/`warn`/`error`/`silent`. |
| `SHUTDOWN_TIMEOUT_MS` | no | `10000` | How long graceful shutdown waits before force-closing remaining connections; see `docs/phase-11-production-preparation.md`, Task 12. |
| `MAX_MESSAGE_LENGTH` | no | *(each mode's own limit)* | An optional operator-set ceiling on top of each AI mode's own `maxInputChars` - unchanged from Phase 1. |

## Why FRONTEND_ORIGINS is required in production

`server.js`'s built-in `DEFAULT_ALLOWED_ORIGINS` are all local-development
origins (`127.0.0.1`/`localhost` on ports 3000/5500). In production, if
`FRONTEND_ORIGINS` is left empty, **no real browser could ever call this
API** - every cross-origin request would be rejected by CORS. This is
exactly the kind of silent, hard-to-diagnose production failure `lib/env.js`
is designed to catch at startup instead of discovering it later from a
confused user report.

## Guest-only vs. authenticated production deployments

Firebase Admin variables are entirely optional. If none are set, this is
a deliberate, fully-supported **guest-only** deployment - readiness
(`GET /ready`) does not require Firebase, and chat continues to work
normally (see `docs/phase-02-authentication.md`'s access policy,
unchanged since Phase 2). If *any* Firebase variable is set, that signals
intent to enable authenticated routes, and `/ready` then requires
`lib/firebaseAdmin.js`'s `isConfigured() === true` - see
`docs/production-healthchecks.md`.

## Frontend/runtime configuration

The frontend has its own, separate runtime configuration in
`www/config.js` and `www/firebase-config.js` - these are **not** server
environment variables (they ship as static files, publicly readable, so
they must never contain a secret). See `docs/production-network-and-cors.md`
for `API_BASE_URL` and `docs/firebase-production-checklist.md` for the
Firebase client config.

## Static asset caching

`server.js`'s `express.static` now sets `Cache-Control` explicitly:
`index.html` is always `no-cache` (so a fresh deploy's HTML shell is never
served stale), and everything else gets a short `max-age=300,
must-revalidate`. This project has no bundler/content-hashing build step
(a deliberate, unchanged architecture decision), so long/immutable caching
is intentionally *not* used - it would risk serving a stale `app.js`
indefinitely after a real deploy. See
`docs/phase-11-production-preparation.md`, Task 15.

## Database (Task 11) - current status

**No PostgreSQL (or any other database) client is wired into this
application.** `DATABASE_URL` is recognized by `lib/env.js` (validated as
a well-formed URL if set) purely so a future implementation has a
consistent place to configure it - setting it today has zero effect and
produces an explicit startup warning saying so.

Current persistence model, unchanged since Phase 1:

| Data | Where it lives today |
|---|---|
| Chat history/conversations | Browser `localStorage`, namespaced per guest/signed-in-user (`www/chatStore.js`) - never sent to or stored by the server |
| Auth identity | Firebase (Google's own infrastructure) - this app never stores credentials |
| Rate-limit counters | In-process memory (`lib/rateLimiter.js`'s `MemoryStore`), or optionally a shared store - see `docs/production-rate-limiting.md` |
| Logs | stdout only (see `docs/production-logging.md`) - no log database |

**Consequence: cross-device chat sync remains unavailable** - a
conversation started on one device/browser is not visible on another,
because nothing server-side persists it. This is unchanged from every
prior phase and is a real, current limitation, not an oversight.

### If a future phase adds PostgreSQL: the recommended contract

Not implemented this phase (explicitly out of scope - "do not build a
large new database layer"). If a future phase does add it, the repository
interface below is the recommended shape, chosen to slot into the
existing architecture with minimal disruption:

```js
// lib/repositories/conversationRepository.js (illustrative - not implemented)
// A real implementation would need: a pg.Pool (not a single Client - see
// "pooling" below), parameterized queries only (never string-built SQL),
// and every method scoped to a verified uid (never a client-supplied one -
// same principle middleware/auth.js already enforces for every existing
// route).
class ConversationRepository {
  async getConversation(uid, conversationId) { /* ... */ }
  async listConversations(uid) { /* ... */ }
  async saveMessage(uid, conversationId, message) { /* ... */ }
  async deleteConversation(uid, conversationId) { /* ... */ }
}
```

Requirements a real implementation would need to satisfy, all currently
undone:

- **Pooling**: `pg.Pool`, not a single long-lived `Client` - sized to the
  deployment's concurrency, with a bounded `idleTimeoutMillis` and
  `connectionTimeoutMillis` so a database outage fails fast (surfaced via
  `/ready`, see `docs/production-healthchecks.md`) rather than hanging
  every request.
- **Ownership enforcement**: every query scoped by the verified `uid` from
  `req.user` (never a client-supplied id) - the exact same principle
  `middleware/auth.js` already enforces for identity itself.
- **Migrations**: a real migration tool (e.g. `node-pg-migrate`), checked
  into the repo, run explicitly as a deploy step - never
  auto-run/auto-created at server startup.
- **Indexes**: at minimum `(uid, conversation_id)` and
  `(uid, updated_at)` for the obvious list/lookup access patterns.
- **Safe shutdown**: `pool.end()` called from the same graceful-shutdown
  path already implemented in `lib/gracefulShutdown.js` (which already
  accepts additional cleanup callbacks via its `limiters` array pattern -
  a DB pool's `.stop()`-shaped wrapper would slot in the same way).
- **Readiness**: `/ready` would need a real `SELECT 1`-style check (with
  its own short timeout, so a slow DB doesn't hang the readiness probe)
  gated behind whether `DATABASE_URL` is actually set - guest-only
  deployments without a database configured must not be marked unready
  for a dependency they were never configured to have.

None of this is implemented. This section exists so a future phase has an
accurate starting point, not so this phase can claim database readiness
it does not have.
