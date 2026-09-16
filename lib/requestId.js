"use strict";

// LinguaHub AI - request ID generation and propagation (Phase 11).
//
// Every request gets a real, collision-resistant ID (crypto.randomUUID(),
// not an incrementing counter - a counter resets on every process restart
// and collides trivially across a multi-process deployment). An upstream
// X-Request-Id is reused only when it is already a well-formed UUID -
// this is safe to accept even from an untrusted client precisely because
// it's format-validated first (a UUID can't carry a log-injection payload
// or an oversized value), not because the client is trusted.

const crypto = require("crypto");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isTrustedRequestId(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

function requestIdMiddleware(req, res, next) {
  const upstream = req.headers["x-request-id"];
  req.id = isTrustedRequestId(upstream) ? upstream : crypto.randomUUID();
  res.setHeader("X-Request-Id", req.id);
  next();
}

module.exports = { requestIdMiddleware, isTrustedRequestId };
