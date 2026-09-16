"use strict";

// LinguaHub AI - production-ready rate limiting abstraction (Phase 11).
//
// One interface, two possible stores:
//   - MemoryStore: in-process Map, sliding window. Correct for local
//     development, the test suite, and a genuine single-process
//     deployment. Does NOT share counters across multiple processes or
//     instances - a client could get a fresh budget per instance behind a
//     naive load balancer.
//   - RedisStore: a shared external store for a horizontally-scaled,
//     multi-process/multi-instance deployment, so every instance enforces
//     the same counter. Only constructed if RATE_LIMIT_STORE_URL is set;
//     only actually usable if the "redis" package is additionally
//     installed. Neither is assumed by this project - "redis" is
//     deliberately NOT a dependency in package.json (Phase 11 requires
//     local development to never need it), so without both a configured
//     URL and the package installed, this is an honestly-documented
//     contract, not a working connection. See
//     docs/production-rate-limiting.md.
//
// A rate limiter that fails open (silently behaves as "unlimited") on a
// misconfiguration is worse than one that fails loudly - RedisStore's
// constructor throws immediately if the package isn't installed, rather
// than falling back to pretending to limit anything.

class MemoryStore {
  constructor() {
    this.hits = new Map(); // key -> array of hit timestamps (ms), within the current window
  }

  // Records one hit for `key` and returns { count, resetMs } - the count
  // AFTER this hit, and how many ms until the oldest hit in the window
  // expires (used for the Retry-After header).
  hit(key, windowMs, now) {
    now = now === undefined ? Date.now() : now;
    const windowStart = now - windowMs;
    const kept = (this.hits.get(key) || []).filter((timestamp) => timestamp > windowStart);
    kept.push(now);
    this.hits.set(key, kept);
    const resetMs = Math.max(0, kept[0] + windowMs - now);
    return { count: kept.length, resetMs };
  }

  // Periodic cleanup so a client that stops making requests doesn't stay
  // in memory forever. Phase 1-10's limiter had no cleanup at all - a
  // slow, unbounded memory leak under real traffic (every distinct IP/uid
  // that ever made one request stayed in the Map permanently). Fixed here
  // by a bounded sweep, wired to an unref'd interval in
  // createMemoryLimiter() below - the same "don't let a background timer
  // silently outlive its purpose" lesson as the Phase 10 port-5500 fix.
  sweep(maxAgeMs, now) {
    now = now === undefined ? Date.now() : now;
    const cutoff = now - maxAgeMs;
    for (const [key, timestamps] of this.hits) {
      const kept = timestamps.filter((timestamp) => timestamp > cutoff);
      if (kept.length === 0) this.hits.delete(key);
      else this.hits.set(key, kept);
    }
  }

  get size() {
    return this.hits.size;
  }
}

class RedisStore {
  constructor(url) {
    if (!url) throw new Error("RedisStore requires a RATE_LIMIT_STORE_URL.");
    let redisModule;
    try {
      // eslint-disable-next-line global-require
      redisModule = require("redis");
    } catch (error) {
      throw new Error(
        'RATE_LIMIT_STORE_URL is set, but the "redis" package is not installed in this deployment. ' +
        'Install it ("npm install redis") to use a shared, multi-instance rate-limit store, or unset ' +
        "RATE_LIMIT_STORE_URL to use the in-process limiter (correct only for a single-instance deployment)."
      );
    }
    this.client = redisModule.createClient({ url });
    this.connected = false;
  }

  async connect() {
    await this.client.connect();
    this.connected = true;
  }

  async hit(key, windowMs) {
    const redisKey = `linguahub:ratelimit:${key}`;
    const count = await this.client.incr(redisKey);
    if (count === 1) {
      await this.client.pExpire(redisKey, windowMs);
    }
    const ttl = await this.client.pTTL(redisKey);
    return { count, resetMs: ttl > 0 ? ttl : windowMs };
  }

  async close() {
    if (this.connected) {
      await this.client.quit();
      this.connected = false;
    }
  }
}

// Authenticated requests are keyed by the Firebase-verified uid (never
// anything the client merely claims - req.user is only ever populated by
// middleware/auth.js from a cryptographically verified token), so a
// signed-in user keeps one budget across IP changes. A guest, or a
// request with a missing/malformed token, has req.user === null (see
// authenticateOptional's fail-open-to-guest behavior) and falls back to
// the client IP - the exact same bucket a request with no token at all
// would use, so a malformed Authorization header can never grant a fresh
// budget. Requires authenticateOptional to run BEFORE this key function
// is used (see server.js's route ordering).
function defaultKeyFn(req) {
  return req.user && req.user.uid ? `uid:${req.user.uid}` : `ip:${req.ip || "unknown"}`;
}

// Wraps a MemoryStore as Express middleware. `max` may be a number or a
// function(req) -> number, so a caller can vary the limit per request
// (e.g. a stricter cap only when mode === "deep-thinking") without a
// second, independent counter that a client could use to reset its
// budget by alternating modes.
function createMemoryLimiter({ windowMs, max, keyFn, name, skip }) {
  const store = new MemoryStore();
  const sweepIntervalMs = Math.min(windowMs, 60000);
  const sweepInterval = setInterval(() => store.sweep(windowMs), sweepIntervalMs);
  sweepInterval.unref();

  function middleware(req, res, next) {
    if (typeof skip === "function" && skip(req)) return next();

    const key = (keyFn || defaultKeyFn)(req);
    const effectiveMax = typeof max === "function" ? max(req) : max;
    const { count, resetMs } = store.hit(key, windowMs, Date.now());

    if (count > effectiveMax) {
      res.setHeader("Retry-After", String(Math.ceil(resetMs / 1000)));
      return res.status(429).json({ reply: "❌ Too many requests. Please wait a moment and try again." });
    }
    next();
  }

  middleware.store = store;
  middleware.stop = () => clearInterval(sweepInterval);
  // Not `middleware.name` - every function already has a non-writable own
  // `name` property (its declared name, "middleware" here), so a direct
  // assignment throws under "use strict". This is a separate, writable
  // property for this module's own identification/debugging purposes.
  middleware.limiterName = name || "rate-limiter";
  return middleware;
}

module.exports = { MemoryStore, RedisStore, createMemoryLimiter, defaultKeyFn };
