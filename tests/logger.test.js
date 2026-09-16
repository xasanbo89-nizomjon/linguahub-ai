"use strict";

// Phase 11: lib/logger.js - structured logging with redaction.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createLogger, redact } = require("../lib/logger.js");

function collectingLogger(options) {
  const lines = [];
  const logger = createLogger(Object.assign({ write: (line) => lines.push(line) }, options));
  return { logger, lines };
}

test("JSON mode emits one parseable JSON object per call, with level/message/time", () => {
  const { logger, lines } = collectingLogger({ json: true, level: "debug" });
  logger.info("hello", { foo: "bar" });
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.level, "info");
  assert.equal(parsed.message, "hello");
  assert.equal(parsed.foo, "bar");
  assert.ok(parsed.time);
});

test("human-readable mode is not raw JSON but still contains the message and level", () => {
  const { logger, lines } = collectingLogger({ json: false, level: "debug" });
  logger.warn("careful");
  assert.match(lines[0], /WARN/);
  assert.match(lines[0], /careful/);
});

test("level filtering: a logger at 'warn' drops debug/info, keeps warn/error", () => {
  const { logger, lines } = collectingLogger({ json: true, level: "warn" });
  logger.debug("nope");
  logger.info("nope");
  logger.warn("yes");
  logger.error("yes");
  assert.equal(lines.length, 2);
});

test('level "silent" drops everything', () => {
  const { logger, lines } = collectingLogger({ json: true, level: "silent" });
  logger.error("should not appear");
  assert.equal(lines.length, 0);
});

test("redact() masks known-sensitive field names, case-insensitively, without mutating the input", () => {
  const input = { Authorization: "Bearer abc", token: "xyz", safe: "ok" };
  const output = redact(input);
  assert.equal(output.Authorization, "[REDACTED]");
  assert.equal(output.token, "[REDACTED]");
  assert.equal(output.safe, "ok");
  assert.equal(input.Authorization, "Bearer abc", "the original object must not be mutated");
});

test("redact() recurses into nested objects", () => {
  const output = redact({ user: { uid: "abc", idToken: "secretvalue" } });
  assert.equal(output.user.idToken, "[REDACTED]");
  assert.equal(output.user.uid, "abc");
});

test("a logged call never leaks a sensitive field, end to end", () => {
  const { logger, lines } = collectingLogger({ json: true, level: "debug" });
  logger.error("provider error", { requestId: "abc-123", token: "sk-should-not-appear", systemPrompt: "you are..." });
  const serialized = lines.join("\n");
  assert.doesNotMatch(serialized, /sk-should-not-appear/);
  assert.doesNotMatch(serialized, /you are\.\.\./);
  assert.match(serialized, /abc-123/);
});

test("child() carries base fields onto every subsequent call", () => {
  const { logger, lines } = collectingLogger({ json: true, level: "debug" });
  const child = logger.child({ requestId: "req-1" });
  child.info("did a thing", { extra: 1 });
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.requestId, "req-1");
  assert.equal(parsed.extra, 1);
});

test("default level is 'info' when unspecified and LOG_LEVEL is not set", () => {
  const previous = process.env.LOG_LEVEL;
  delete process.env.LOG_LEVEL;
  try {
    const { logger, lines } = collectingLogger({ json: true });
    logger.debug("dropped");
    logger.info("kept");
    assert.equal(lines.length, 1);
  } finally {
    if (previous !== undefined) process.env.LOG_LEVEL = previous;
  }
});
