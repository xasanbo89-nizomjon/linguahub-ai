"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const contextAdapter = require("../www/context-adapter.js");

test("an empty/absent context validates to an empty safe context, not an error", () => {
  assert.deepEqual(contextAdapter.validate(undefined).context, {});
  assert.deepEqual(contextAdapter.validate(null).context, {});
  assert.deepEqual(contextAdapter.validate({}).context, {});
});

test("a non-object context (string/number/array) is rejected safely, never thrown", () => {
  assert.deepEqual(contextAdapter.validate("not an object").context, {});
  assert.deepEqual(contextAdapter.validate(42).context, {});
  assert.deepEqual(contextAdapter.validate(["route", "module"]).context, {});
});

test("every explicitly allowed field passes through unchanged", () => {
  const raw = {
    source: "linguahub",
    route: "/lessons/12/quiz",
    module: "Past Tense Verbs",
    pageType: "reading",
    language: "en",
    userRole: "student",
    testId: "cambridge-18",
    sectionId: "reading-1",
    questionId: "q17",
    attemptId: "attempt-9",
    submitted: true,
    resultSummary: "3 of 5 correct"
  };
  const result = contextAdapter.validate(raw);
  assert.deepEqual(result.context, raw);
  assert.deepEqual(result.rejectedFields, []);
});

test("ALLOWED_FIELDS matches exactly the documented allowlist - no field present merely because it might be useful", () => {
  const expected = [
    "source", "route", "module", "pageType", "language", "userRole",
    "testId", "sectionId", "questionId", "attemptId", "submitted", "resultSummary"
  ];
  assert.deepEqual(contextAdapter.ALLOWED_FIELDS.slice().sort(), expected.slice().sort());
});

test("forbidden fields (tokens, secrets, hidden answers, admin data) are always rejected, never passed through", () => {
  const raw = {
    module: "Reading",
    firebaseToken: "eyJhbGciOi...",
    apiKey: "sk-abc123",
    openaiKey: "sk-abc123",
    correctAnswer: "B",
    hiddenAnswer: "B",
    answerKey: ["A", "B", "C"],
    adminNote: "flag this student",
    evaluatorNote: "weak grammar",
    systemPrompt: "you are a helpful assistant",
    environmentVariables: "DB_URL=...",
    password: "hunter2",
    credential: "abc"
  };
  const result = contextAdapter.validate(raw);
  assert.deepEqual(result.context, { module: "Reading" });
  assert.ok(result.rejectedFields.includes("firebaseToken"));
  assert.ok(result.rejectedFields.includes("apiKey"));
  assert.ok(result.rejectedFields.includes("openaiKey"));
  assert.ok(result.rejectedFields.includes("correctAnswer"));
  assert.ok(result.rejectedFields.includes("hiddenAnswer"));
  assert.ok(result.rejectedFields.includes("answerKey"));
  assert.ok(result.rejectedFields.includes("adminNote"));
  assert.ok(result.rejectedFields.includes("evaluatorNote"));
  assert.ok(result.rejectedFields.includes("systemPrompt"));
  assert.ok(result.rejectedFields.includes("environmentVariables"));
  assert.ok(result.rejectedFields.includes("password"));
  assert.ok(result.rejectedFields.includes("credential"));
});

test("an unrecognized field not on the allowlist is rejected even if it looks harmless", () => {
  const result = contextAdapter.validate({ module: "Reading", favoriteColor: "blue", internalDebugFlag: true });
  assert.deepEqual(result.context, { module: "Reading" });
  assert.ok(result.rejectedFields.includes("favoriteColor"));
  assert.ok(result.rejectedFields.includes("internalDebugFlag"));
});

test("a nested object/array value on an otherwise-allowed key is rejected - only flat primitives are safe", () => {
  const result = contextAdapter.validate({
    module: "Reading",
    resultSummary: { score: 3, total: 5, hiddenAnswerKey: "B" }
  });
  assert.deepEqual(result.context, { module: "Reading" });
  assert.ok(result.rejectedFields.includes("resultSummary"), "an object value must be rejected even though the key itself is allowed - it could smuggle forbidden data one level down");
});

test("isEmptyContext reports true for an absent/empty context and false once any real field exists", () => {
  assert.equal(contextAdapter.isEmptyContext({}), true);
  assert.equal(contextAdapter.isEmptyContext(null), true);
  assert.equal(contextAdapter.isEmptyContext({ module: "Reading" }), false);
});

test("formatChipLabel builds the documented 'Module · Test · Question' style label, skipping absent fields", () => {
  assert.equal(
    contextAdapter.formatChipLabel({ module: "Reading", testId: "Cambridge 18", questionId: "Q17" }),
    "Reading · Cambridge 18 · Q17"
  );
});

test("formatChipLabel returns null (never a fake placeholder) for an empty context", () => {
  assert.equal(contextAdapter.formatChipLabel({}), null);
  assert.equal(contextAdapter.formatChipLabel(null), null);
});

test("formatChipLabel never includes a forbidden or unrecognized field, even if present on the raw (unvalidated) object passed to it directly", () => {
  // formatChipLabel only reads its own known label-worthy keys - passing it
  // an unvalidated object directly (bypassing validate()) must still never
  // leak an arbitrary field into the visible label.
  const label = contextAdapter.formatChipLabel({ module: "Reading", secretToken: "abc" });
  assert.equal(label, "Reading");
  assert.doesNotMatch(label, /abc/);
});
