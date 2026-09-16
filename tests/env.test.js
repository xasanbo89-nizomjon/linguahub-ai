"use strict";

// Phase 11: lib/env.js - production environment validation. validateEnv()
// is pure (takes a plain object, never reads process.env or calls
// process.exit/console itself), so every scenario here is a direct,
// isolated unit test with no server startup involved.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validateEnv, parsePort, parsePositiveInt, parseOrigins, maskSecret } = require("../lib/env.js");

function baseEnv(overrides) {
  return Object.assign({
    NODE_ENV: "development",
    PORT: "3000",
    OPENAI_API_KEY: "sk-test-not-real"
  }, overrides);
}

test("a minimal development env is valid with no FRONTEND_ORIGINS set", () => {
  const result = validateEnv(baseEnv());
  assert.equal(result.ok, true);
  assert.equal(result.isProduction, false);
  assert.deepEqual(result.errors, []);
});

test("production with no OPENAI_API_KEY is a hard error, not a warning", () => {
  const result = validateEnv(baseEnv({ NODE_ENV: "production", OPENAI_API_KEY: "", FRONTEND_ORIGINS: "https://app.example.com" }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /OPENAI_API_KEY/.test(e)));
});

test("development with no OPENAI_API_KEY is only a warning, never blocks startup", () => {
  const result = validateEnv(baseEnv({ OPENAI_API_KEY: "" }));
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => /OPENAI_API_KEY/.test(w)));
});

test("production with no FRONTEND_ORIGINS at all is a hard error (no browser could ever call the API)", () => {
  const result = validateEnv(baseEnv({ NODE_ENV: "production" }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /FRONTEND_ORIGINS/.test(e)));
});

test("a malformed FRONTEND_ORIGINS entry is a hard error in every NODE_ENV, not silently dropped", () => {
  const result = validateEnv(baseEnv({ FRONTEND_ORIGINS: "https://good.example.com,not a url,https://also-good.example.com/with/a/path" }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /malformed/.test(e)));
});

test("a valid FRONTEND_ORIGINS list is parsed into exact origins, deduplicated and trailing-slash-normalized", () => {
  const result = validateEnv(baseEnv({
    NODE_ENV: "production",
    FRONTEND_ORIGINS: "https://app.example.com/, https://app.example.com, https://other.example.com"
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.frontendOrigins.slice().sort(), ["https://app.example.com", "https://other.example.com"]);
});

test("an invalid PORT is a hard error even outside production", () => {
  const result = validateEnv(baseEnv({ PORT: "not-a-port" }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /PORT/.test(e)));
});

test("PORT out of the valid 1-65535 range is rejected", () => {
  assert.equal(validateEnv(baseEnv({ PORT: "0" })).ok, false);
  assert.equal(validateEnv(baseEnv({ PORT: "70000" })).ok, false);
  assert.equal(validateEnv(baseEnv({ PORT: "65535" })).ok, true);
});

test("missing PORT defaults to 3000 without error", () => {
  const result = validateEnv(baseEnv({ PORT: undefined }));
  assert.equal(result.ok, true);
  assert.equal(result.port, 3000);
});

test("RATE_LIMIT_WINDOW_MS / RATE_LIMIT_MAX_REQUESTS / REQUEST_TIMEOUT_MS reject non-positive-integer values", () => {
  assert.equal(validateEnv(baseEnv({ RATE_LIMIT_WINDOW_MS: "-5" })).ok, false);
  assert.equal(validateEnv(baseEnv({ RATE_LIMIT_MAX_REQUESTS: "abc" })).ok, false);
  assert.equal(validateEnv(baseEnv({ REQUEST_TIMEOUT_MS: "0" })).ok, false);
});

test("TRUST_PROXY accepts a numeric hop count and rejects garbage", () => {
  assert.equal(validateEnv(baseEnv({ TRUST_PROXY: "1" })).trustProxy, 1);
  assert.equal(validateEnv(baseEnv({ TRUST_PROXY: "2" })).trustProxy, 2);
  assert.equal(validateEnv(baseEnv({ TRUST_PROXY: "not-a-number" })).ok, false);
});

test('TRUST_PROXY="true" is accepted but produces a warning (unbounded trust)', () => {
  const result = validateEnv(baseEnv({ TRUST_PROXY: "true" }));
  assert.equal(result.ok, true);
  assert.equal(result.trustProxy, true);
  assert.ok(result.warnings.some((w) => /TRUST_PROXY/.test(w)));
});

test("unset TRUST_PROXY defaults to 0 (nothing trusted)", () => {
  assert.equal(validateEnv(baseEnv()).trustProxy, 0);
});

test("partial Firebase Admin config (some but not all vars) is a warning, not a hard error", () => {
  const result = validateEnv(baseEnv({ FIREBASE_PROJECT_ID: "my-project" }));
  assert.equal(result.ok, true);
  assert.equal(result.authIntended, true);
  assert.equal(result.authComplete, false);
  assert.ok(result.warnings.some((w) => /Firebase Admin/.test(w)));
});

test("complete Firebase Admin config (all three vars) is recognized as complete, no warning", () => {
  const result = validateEnv(baseEnv({
    FIREBASE_PROJECT_ID: "my-project",
    FIREBASE_CLIENT_EMAIL: "svc@my-project.iam.gserviceaccount.com",
    FIREBASE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n"
  }));
  assert.equal(result.authIntended, true);
  assert.equal(result.authComplete, true);
  assert.ok(!result.warnings.some((w) => /Firebase Admin/.test(w)));
});

test("no Firebase Admin vars at all means auth is simply not intended - not a warning, not an error (guest-only is a valid deployment posture)", () => {
  const result = validateEnv(baseEnv());
  assert.equal(result.authIntended, false);
  assert.equal(result.ok, true);
  assert.ok(!result.warnings.some((w) => /Firebase/.test(w)));
});

test("GOOGLE_APPLICATION_CREDENTIALS alone counts as complete Firebase Admin config", () => {
  const result = validateEnv(baseEnv({ GOOGLE_APPLICATION_CREDENTIALS: "/path/to/key.json" }));
  assert.equal(result.authIntended, true);
  assert.equal(result.authComplete, true);
});

test("DATABASE_URL being set produces an honest warning that it is currently unused, never a claim of active persistence", () => {
  const result = validateEnv(baseEnv({ DATABASE_URL: "postgres://user:pass@host/db" }));
  assert.ok(result.warnings.some((w) => /unused/.test(w)));
});

test("summary never contains a raw secret value, only presence/length", () => {
  const result = validateEnv(baseEnv({
    OPENAI_API_KEY: "sk-thisIsASecretValueThatMustNeverAppear",
    FIREBASE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nSUPER-SECRET\\n-----END PRIVATE KEY-----\\n"
  }));
  const serialized = JSON.stringify(result.summary);
  assert.doesNotMatch(serialized, /sk-thisIsASecretValueThatMustNeverAppear/);
  assert.doesNotMatch(serialized, /SUPER-SECRET/);
  assert.match(result.summary.OPENAI_API_KEY, /set, length \d+/);
});

test("LINGUAHUB_INTERNAL_TOKEN is masked in summary exactly like other secrets, never the raw value", () => {
  const result = validateEnv(baseEnv({ LINGUAHUB_INTERNAL_TOKEN: "super-secret-internal-token-value" }));
  const serialized = JSON.stringify(result.summary);
  assert.doesNotMatch(serialized, /super-secret-internal-token-value/);
  assert.match(result.summary.LINGUAHUB_INTERNAL_TOKEN, /set, length \d+/);
});

test("LINGUAHUB_INTERNAL_TOKEN being unset is not an error or a warning - trusted context is simply unavailable", () => {
  const result = validateEnv(baseEnv({ LINGUAHUB_INTERNAL_TOKEN: undefined }));
  assert.equal(result.ok, true);
  assert.equal(result.summary.LINGUAHUB_INTERNAL_TOKEN, "(unset)");
  assert.equal(result.warnings.some((w) => /LINGUAHUB_INTERNAL_TOKEN/.test(w)), false);
});

test("unknown NODE_ENV is a warning, treated as development-shaped, never a hard error", () => {
  const result = validateEnv(baseEnv({ NODE_ENV: "staging" }));
  assert.equal(result.ok, true);
  assert.equal(result.isProduction, false);
  assert.ok(result.warnings.some((w) => /NODE_ENV/.test(w)));
});

test("parsePort / parsePositiveInt / parseOrigins / maskSecret behave correctly in isolation", () => {
  assert.equal(parsePort("3000"), 3000);
  assert.equal(parsePort(""), null);
  assert.equal(parsePort("abc"), undefined);
  assert.equal(parsePositiveInt("", 42), 42);
  assert.equal(parsePositiveInt("10", 42), 10);
  assert.equal(parsePositiveInt("-1", 42), undefined);
  assert.deepEqual(parseOrigins("https://a.com,https://b.com").valid, ["https://a.com", "https://b.com"]);
  assert.deepEqual(parseOrigins("https://a.com,bad").invalid, ["bad"]);
  assert.equal(maskSecret(""), "(unset)");
  assert.equal(maskSecret("abc"), "(set, length 3)");
});
