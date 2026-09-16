"use strict";

// Phase 11: lib/requestId.js - request ID generation and propagation.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { requestIdMiddleware, isTrustedRequestId } = require("../lib/requestId.js");

function fakeReqRes(headers) {
  const req = { headers: headers || {} };
  const responseHeaders = {};
  const res = { setHeader: (name, value) => { responseHeaders[name] = value; } };
  return { req, res, responseHeaders };
}

test("generates a real UUID when no upstream X-Request-Id is present", () => {
  const { req, res, responseHeaders } = fakeReqRes();
  requestIdMiddleware(req, res, () => {});
  assert.match(req.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.equal(responseHeaders["X-Request-Id"], req.id);
});

test("reuses a well-formed upstream UUID instead of generating a new one", () => {
  const upstream = "550e8400-e29b-41d4-a716-446655440000";
  const { req, res } = fakeReqRes({ "x-request-id": upstream });
  requestIdMiddleware(req, res, () => {});
  assert.equal(req.id, upstream);
});

test("rejects a malformed/arbitrary upstream value and generates a real ID instead", () => {
  const { req, res } = fakeReqRes({ "x-request-id": "'; DROP TABLE requests; --" });
  requestIdMiddleware(req, res, () => {});
  assert.notEqual(req.id, "'; DROP TABLE requests; --");
  assert.match(req.id, /^[0-9a-f-]{36}$/i);
});

test("two requests with no upstream header never collide", () => {
  const ids = new Set();
  for (let i = 0; i < 200; i += 1) {
    const { req, res } = fakeReqRes();
    requestIdMiddleware(req, res, () => {});
    ids.add(req.id);
  }
  assert.equal(ids.size, 200);
});

test("calls next() exactly once", () => {
  const { req, res } = fakeReqRes();
  let calls = 0;
  requestIdMiddleware(req, res, () => { calls += 1; });
  assert.equal(calls, 1);
});

test("isTrustedRequestId validates UUID shape only", () => {
  assert.equal(isTrustedRequestId("550e8400-e29b-41d4-a716-446655440000"), true);
  assert.equal(isTrustedRequestId("not-a-uuid"), false);
  assert.equal(isTrustedRequestId(""), false);
  assert.equal(isTrustedRequestId(undefined), false);
  assert.equal(isTrustedRequestId(12345), false);
});
