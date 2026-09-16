# Production Rate Limiting (Phase 11)

## The Phase 1-10 limiter's real limitation

`server.js` previously had a single, ad-hoc in-memory sliding-window
limiter applied only to the three chat routes, keyed by `req.ip` alone,
with **no periodic cleanup** (every distinct IP that ever made one
request stayed in memory forever - a slow, unbounded leak under real
traffic) and **no way to share counters across multiple processes** - a
horizontally-scaled deployment (multiple Node instances behind a load
balancer) would give each instance its own independent budget, letting a
client multiply its effective limit by the instance count simply by
landing on a different backend each time.

## What Phase 11 changes

`lib/rateLimiter.js` extracts this into a reusable abstraction
(`MemoryStore`, `RedisStore`, `createMemoryLimiter`) and `server.js` now
applies **three tiers**, all real and active today:

| Tier | Scope | Default budget | Keyed by |
|---|---|---|---|
| `generalLimiter` | every route (`app.use`, registered before any route - including static assets and health checks) | 300 req/min per key (`GENERAL_RATE_LIMIT_MAX_REQUESTS`) | client IP |
| `chatLimiter` | `/chat`, `/api/chat`, `/api/chat/stream` | 30 req/window (`RATE_LIMIT_MAX_REQUESTS`, window `RATE_LIMIT_WINDOW_MS`) | verified uid, or IP for guests |
| `deepThinkingLimiter` | the same three routes, but only counts requests where `mode === "deep-thinking"` | 10 req/window (`DEEP_THINKING_RATE_LIMIT_MAX_REQUESTS`) | same as `chatLimiter` |

### Why Deep Thinking gets its own, stricter limit

Of the four enabled modes (`lib/aiModes.js`), Deep Thinking is
objectively the most expensive: it's the only mode using the stronger
`gpt-4.1` model (every other enabled mode uses the cheaper
`gpt-4.1-mini`), has the largest `maxOutputTokens` tied with Codex, and
the longest `timeoutMs` (90s vs. 60s). A client alternating between modes
still shares the SAME `chatLimiter` key/budget regardless of which mode
it requests (mode is never part of the rate-limit key) - `deepThinkingLimiter`
is a strictly *additional* gate on top of that shared budget, not a
separate, resettable one. Verified directly:
`tests/rateLimiter.test.js`, "switching mode does not bypass the same
limiter's shared key/budget", and `tests/server-production.test.js`, "the
deep-thinking limiter is stricter... and cannot be bypassed by switching
modes".

### Identity-aware keying, and why a malformed token can't bypass it

`defaultKeyFn(req)` returns `uid:<uid>` when `req.user.uid` exists
(populated only by `middleware/auth.js` from a cryptographically verified
Firebase ID token - never anything the client merely claims) and falls
back to `ip:<ip>` otherwise. `authenticateOptional` already reduces
*every* failure case (no token, expired token, garbage token, wrong
project) to `req.user = null` - the exact same state a request with no
token at all produces - so a malformed `Authorization` header can never
grant a fresh budget; it collapses to the same guest/IP bucket. Verified
directly: `tests/rateLimiter.test.js`, "a malformed-auth request cannot
get a fresh budget - it collapses to the same key as a guest".

This required reordering `authenticateOptional` to run **before** the
rate limiters on the chat routes (it used to run after) - a real,
confirmed defect: `req.user` didn't exist yet when the old limiter ran,
so uid-based keying was structurally impossible under the old order.

### Retry-After and no internal counters exposed

A `429` response sets `Retry-After` (seconds until the oldest hit in the
current window expires) and returns only the same safe, fixed message
every other error path in this app uses - never the raw hit count or
window internals. Verified: `tests/rateLimiter.test.js`, "a 429 response
sets Retry-After and never exposes the raw internal counter".

### Cleanup: the Phase 1-10 memory leak, fixed

`MemoryStore.sweep()` is called on an interval (bounded to
`min(windowMs, 60000)`, `.unref()`'d so it never keeps the process alive
on its own) that removes any key whose hits have all expired. Each
limiter's `.stop()` clears this interval - called from
`lib/gracefulShutdown.js` during shutdown, so no interval outlives the
process. Verified: `tests/rateLimiter.test.js`, "MemoryStore.sweep()
removes keys whose hits have all expired, keeps recent ones".

## Horizontal scaling: `RedisStore` - a real, honest contract, NOT active

`lib/rateLimiter.js` also exports `RedisStore`, a shared-counter
implementation (Redis `INCR` + `PEXPIRE`) matching the same `hit(key,
windowMs)` interface `MemoryStore` implements. **This project's
`package.json` does not depend on `redis`** - Phase 11 explicitly
requires local development to never need it. Constructing a `RedisStore`
when the `redis` package isn't installed throws immediately and clearly,
rather than silently behaving like an unlimited/no-op limiter - a rate
limiter that fails open on misconfiguration is worse than one that fails
loudly. Verified: `tests/rateLimiter.test.js`, "RedisStore throws
immediately (fails loudly, not open) when the optional 'redis' package is
not installed".

**Current status: shared-store runtime is NOT RUN.** `RATE_LIMIT_STORE_URL`
is recognized and validated as a well-formed URL by `lib/env.js`, but
nothing in `server.js` currently constructs or uses a `RedisStore` - the
three limiters wired into `server.js` today all use `MemoryStore`
regardless of whether `RATE_LIMIT_STORE_URL` is set. This is stated
plainly rather than implied: **wiring `RedisStore` into `server.js`'s
actual limiter construction, adding `redis` as a real dependency, and
verifying it against a real Redis instance are all future work**, not
completed this phase.

### What a future phase would need to do to activate it

1. Add `redis` to `package.json`'s `dependencies` (currently deliberately
   absent).
2. In `server.js`, when `envResult.rateLimitStoreUrl` is set, construct a
   `RedisStore`, `await store.connect()` before `app.listen()`, and pass
   it into `createMemoryLimiter`-equivalent middleware (or a new
   `createSharedLimiter` using the same interface) instead of the default
   `MemoryStore`.
3. Add `store.close()` to the graceful-shutdown cleanup path (the same
   place `docs/production-environment.md`'s future DB pool would plug
   into).
4. Add a real integration test against an actual Redis instance (this
   phase has none available, matching the same "don't fake it" principle
   applied throughout every phase of this project to Firebase/Android/
   database readiness).

### Single-instance deployments need nothing extra

If this application runs as a single Node process (the deployment shape
this project's own `docs/deployment-preflight-checklist.md` recommends
starting with), `MemoryStore` is already fully correct - there's only one
process's memory to keep counters in. `RedisStore` only matters once a
deployment runs **multiple concurrent instances** of this same backend
behind a load balancer.
