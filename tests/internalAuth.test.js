"use strict";

// Covers lib/internalAuth.js in isolation - pure, no HTTP, no server.js.
// End-to-end request-level behavior (actual 403s over real HTTP) is
// covered separately in tests/trustedContext.test.js.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const internalAuth = require("../lib/internalAuth.js");

const ORIGINAL_TOKEN = process.env.LINGUAHUB_INTERNAL_TOKEN;

function withToken(value, fn) {
  process.env.LINGUAHUB_INTERNAL_TOKEN = value;
  try {
    fn();
  } finally {
    if (ORIGINAL_TOKEN === undefined) delete process.env.LINGUAHUB_INTERNAL_TOKEN;
    else process.env.LINGUAHUB_INTERNAL_TOKEN = ORIGINAL_TOKEN;
  }
}

test("verifyInternalToken accepts the exact configured token", () => {
  withToken("real-internal-secret-abc123", () => {
    assert.equal(internalAuth.verifyInternalToken("real-internal-secret-abc123"), true);
  });
});

test("verifyInternalToken rejects a wrong token", () => {
  withToken("real-internal-secret-abc123", () => {
    assert.equal(internalAuth.verifyInternalToken("wrong-token"), false);
  });
});

test("verifyInternalToken rejects a missing/undefined provided token", () => {
  withToken("real-internal-secret-abc123", () => {
    assert.equal(internalAuth.verifyInternalToken(undefined), false);
    assert.equal(internalAuth.verifyInternalToken(null), false);
    assert.equal(internalAuth.verifyInternalToken(""), false);
  });
});

test("verifyInternalToken fails closed when no server-side token is configured at all - never an accidental bypass", () => {
  withToken(undefined, () => {
    delete process.env.LINGUAHUB_INTERNAL_TOKEN;
    assert.equal(internalAuth.verifyInternalToken("anything"), false);
    assert.equal(internalAuth.verifyInternalToken(""), false, "two empty/missing values must never be treated as matching");
    assert.equal(internalAuth.verifyInternalToken(undefined), false);
  });
});

test("verifyInternalToken fails closed when the server-side token is configured as an empty string", () => {
  withToken("", () => {
    assert.equal(internalAuth.verifyInternalToken(""), false);
    assert.equal(internalAuth.verifyInternalToken("anything"), false);
  });
});

test("isInternalAuthConfigured reflects whether a real token is set", () => {
  withToken("real-token", () => {
    assert.equal(internalAuth.isInternalAuthConfigured(), true);
  });
  withToken(undefined, () => {
    delete process.env.LINGUAHUB_INTERNAL_TOKEN;
    assert.equal(internalAuth.isInternalAuthConfigured(), false);
  });
});

test("safeTokenMatch never throws on mismatched-length inputs (crypto.timingSafeEqual would)", () => {
  assert.equal(internalAuth.safeTokenMatch("short", "a-much-longer-token-value"), false);
  assert.equal(internalAuth.safeTokenMatch("a-much-longer-token-value", "short"), false);
});

test("safeTokenMatch rejects non-string inputs safely instead of throwing", () => {
  assert.equal(internalAuth.safeTokenMatch(123, "token"), false);
  assert.equal(internalAuth.safeTokenMatch("token", null), false);
  assert.equal(internalAuth.safeTokenMatch(undefined, undefined), false);
});

test("getProvidedTokenFromRequest reads the exact documented header name (case-insensitive per HTTP/Express convention)", () => {
  const reqWithHeader = { headers: { "x-linguahub-internal-token": "abc123" } };
  assert.equal(internalAuth.getProvidedTokenFromRequest(reqWithHeader), "abc123");
});

test("getProvidedTokenFromRequest returns null when the header is absent, not undefined or a crash", () => {
  assert.equal(internalAuth.getProvidedTokenFromRequest({ headers: {} }), null);
  assert.equal(internalAuth.getProvidedTokenFromRequest({ headers: undefined }), null);
});

test("HEADER_NAME is the exact documented header, lowercased (Node normalizes incoming header names to lowercase)", () => {
  assert.equal(internalAuth.HEADER_NAME, "x-linguahub-internal-token");
});
