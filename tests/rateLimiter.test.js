"use strict";

// Phase 11: lib/rateLimiter.js - production rate limiting abstraction.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { MemoryStore, RedisStore, createMemoryLimiter, defaultKeyFn } = require("../lib/rateLimiter.js");

function fakeReqRes(overrides) {
  const req = Object.assign({ ip: "1.2.3.4", user: null, body: {} }, overrides);
  const headers = {};
  let statusCode = null;
  let jsonBody = null;
  const res = {
    setHeader: (name, value) => { headers[name] = value; },
    status: (code) => { statusCode = code; return res; },
    json: (body) => { jsonBody = body; return res; }
  };
  return { req, res, headers, getStatus: () => statusCode, getJson: () => jsonBody };
}

test("MemoryStore.hit() counts within the window and resets after it elapses", () => {
  const store = new MemoryStore();
  const now = 1_000_000;
  assert.equal(store.hit("k", 1000, now).count, 1);
  assert.equal(store.hit("k", 1000, now + 100).count, 2);
  // well past the window - the earlier hits have expired
  assert.equal(store.hit("k", 1000, now + 5000).count, 1);
});

test("MemoryStore.sweep() removes keys whose hits have all expired, keeps recent ones", () => {
  const store = new MemoryStore();
  const now = 1_000_000;
  store.hit("stale", 1000, now);
  store.hit("fresh", 1000, now + 10000);
  store.sweep(1000, now + 10000);
  assert.equal(store.size, 1);
});

test("createMemoryLimiter allows requests under the limit and blocks the one that exceeds it", () => {
  const limiter = createMemoryLimiter({ windowMs: 60000, max: 2, keyFn: () => "same-key" });
  try {
    const attempts = [fakeReqRes(), fakeReqRes(), fakeReqRes()];
    let blocked = 0;
    for (const { req, res, getStatus } of attempts) {
      limiter(req, res, () => {});
      if (getStatus() === 429) blocked += 1;
    }
    assert.equal(blocked, 1, "only the 3rd request (over the limit of 2) should be blocked");
  } finally {
    limiter.stop();
  }
});

test("a 429 response sets Retry-After and never exposes the raw internal counter", () => {
  const limiter = createMemoryLimiter({ windowMs: 60000, max: 1, keyFn: () => "k" });
  try {
    const first = fakeReqRes();
    limiter(first.req, first.res, () => {});
    const second = fakeReqRes();
    limiter(second.req, second.res, () => {});
    assert.equal(second.getStatus(), 429);
    assert.ok(second.headers["Retry-After"]);
    assert.ok(!/count|counter|\d+\/\d+/.test(JSON.stringify(second.getJson())));
  } finally {
    limiter.stop();
  }
});

test("different keys have independent budgets", () => {
  const limiter = createMemoryLimiter({ windowMs: 60000, max: 1, keyFn: (req) => req.ip });
  try {
    const a1 = fakeReqRes({ ip: "1.1.1.1" });
    const a2 = fakeReqRes({ ip: "1.1.1.1" });
    const b1 = fakeReqRes({ ip: "2.2.2.2" });
    limiter(a1.req, a1.res, () => {});
    limiter(a2.req, a2.res, () => {});
    limiter(b1.req, b1.res, () => {});
    assert.equal(a2.getStatus(), 429, "second request from the same IP should be blocked");
    assert.equal(b1.getStatus(), null, "a different IP must have its own, unaffected budget");
  } finally {
    limiter.stop();
  }
});

test("skip() bypasses the limiter entirely for requests that don't match", () => {
  const limiter = createMemoryLimiter({
    windowMs: 60000,
    max: 1,
    keyFn: () => "k",
    skip: (req) => req.body.mode !== "deep-thinking"
  });
  try {
    for (let i = 0; i < 5; i += 1) {
      const { req, res, getStatus } = fakeReqRes({ body: { mode: "general" } });
      limiter(req, res, () => {});
      assert.notEqual(getStatus(), 429, "non-matching requests must never be limited by this limiter");
    }
  } finally {
    limiter.stop();
  }
});

test("skip() still applies the limiter for requests that do match", () => {
  const limiter = createMemoryLimiter({
    windowMs: 60000,
    max: 1,
    keyFn: () => "k",
    skip: (req) => req.body.mode !== "deep-thinking"
  });
  try {
    const first = fakeReqRes({ body: { mode: "deep-thinking" } });
    limiter(first.req, first.res, () => {});
    const second = fakeReqRes({ body: { mode: "deep-thinking" } });
    limiter(second.req, second.res, () => {});
    assert.equal(second.getStatus(), 429);
  } finally {
    limiter.stop();
  }
});

test("defaultKeyFn keys a verified uid over IP, and falls back to IP for guests/malformed auth", () => {
  assert.equal(defaultKeyFn({ user: { uid: "abc123" }, ip: "9.9.9.9" }), "uid:abc123");
  assert.equal(defaultKeyFn({ user: null, ip: "9.9.9.9" }), "ip:9.9.9.9");
  assert.equal(defaultKeyFn({ ip: "9.9.9.9" }), "ip:9.9.9.9");
});

test("a malformed-auth request cannot get a fresh budget - it collapses to the same key as a guest", () => {
  const limiter = createMemoryLimiter({ windowMs: 60000, max: 1, keyFn: defaultKeyFn });
  try {
    // authenticateOptional would set req.user = null for BOTH "no token"
    // and "malformed token" - simulated directly here since this test is
    // scoped to the limiter, not the auth middleware.
    const guest = fakeReqRes({ user: null, ip: "5.5.5.5" });
    limiter(guest.req, guest.res, () => {});
    const malformedAuth = fakeReqRes({ user: null, ip: "5.5.5.5" });
    limiter(malformedAuth.req, malformedAuth.res, () => {});
    assert.equal(malformedAuth.getStatus(), 429, "a bad token must share the guest IP budget, not reset it");
  } finally {
    limiter.stop();
  }
});

test("switching mode does not bypass the same limiter's shared key/budget", () => {
  const limiter = createMemoryLimiter({ windowMs: 60000, max: 1, keyFn: defaultKeyFn });
  try {
    const first = fakeReqRes({ user: { uid: "u1" }, body: { mode: "general" } });
    limiter(first.req, first.res, () => {});
    const second = fakeReqRes({ user: { uid: "u1" }, body: { mode: "deep-thinking" } });
    limiter(second.req, second.res, () => {});
    assert.equal(second.getStatus(), 429, "the general limiter's budget must not reset just because the mode changed");
  } finally {
    limiter.stop();
  }
});

test("stop() clears the sweep interval without throwing", () => {
  const limiter = createMemoryLimiter({ windowMs: 1000, max: 10, keyFn: () => "k" });
  assert.doesNotThrow(() => limiter.stop());
});

test("RedisStore throws immediately (fails loudly, not open) when the optional \"redis\" package is not installed", () => {
  // This project deliberately does not depend on "redis" (Phase 11: must
  // never be mandatory for local development) - so in this repo's own
  // test environment, constructing a RedisStore must throw a clear,
  // actionable error rather than silently becoming a no-op/unlimited
  // limiter.
  let threw = false;
  try {
    // eslint-disable-next-line no-new
    new RedisStore("redis://localhost:6379");
  } catch (error) {
    threw = true;
    assert.match(error.message, /redis/i);
  }
  // If "redis" happens to be installed in some environment running this
  // suite, the constructor won't throw here - that's fine, this test only
  // asserts the documented failure mode when it's genuinely absent.
  if (!threw) {
    let hasRedisPackage = true;
    try { require.resolve("redis"); } catch (e) { hasRedisPackage = false; }
    assert.equal(hasRedisPackage, true, 'RedisStore should have thrown since "redis" is not an installed dependency of this project');
  }
});

test("RedisStore requires a URL", () => {
  assert.throws(() => new RedisStore(), /RATE_LIMIT_STORE_URL/);
});
