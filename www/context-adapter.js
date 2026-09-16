"use strict";

// LinguaHub AI - page-context validation contract (Integration Prep phase,
// Task 8/11).
//
// NOT connected to any real LinguaHub data today - nothing in this
// repository calls setContext() with real values. This module exists so
// the *shape* of "safe context a future LinguaHub page may hand to the
// assistant" is defined, validated, and testable now, before any real
// integration writes code against it.
//
// Frontend context is never authoritative (Task 8's own explicit rule):
// this validation is a client-side allowlist for what may reach the
// context chip UI. The backend must independently re-validate anything a
// future integration actually sends with a chat request - this module
// makes no claim about, and does not change, server-side trust boundaries
// (lib/aiModes.js, lib/contextBuilder.js are both untouched).

var LinguaHubContextAdapter = (function () {

// Exactly the fields named in docs/integration-prep/context-adapter-contract.md
// - not one more. A field being "possibly useful someday" is not a reason
// to allow it; each of these is here because a specific, named, currently
// real UI need (the context chip - Task 11) or a documented future one
// justifies it.
var ALLOWED_FIELDS = [
"source", "route", "module", "pageType", "language", "userRole",
"testId", "sectionId", "questionId", "attemptId", "submitted", "resultSummary"
];

// Detection-only, not the sole line of defense: matched key names that are
// unambiguous signs of something that must never travel as "page context" -
// secrets, tokens, hidden answers, admin/evaluator-only data. A key
// matching this is rejected even if it happened to also be spelled like an
// allowed field; the allowlist above is still the actual gate (a forbidden
// name never appears in ALLOWED_FIELDS), this exists to fail loudly and
// specifically when a caller clearly tried to pass one of these, rather
// than lumping it in with an ordinary unrecognized-field rejection.
var FORBIDDEN_FIELD_PATTERN = /token|secret|key|password|credential|apikey|answerkey|correctanswer|hiddenanswer|adminnote|evaluatornote|systemprompt|env(iron)?/i;

function isPlainObject(value) {
return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Only display-safe primitives survive - never nested objects/arrays,
// which could otherwise smuggle arbitrary structured data (including a
// forbidden field one level down) past a flat key-name allowlist.
function isSafePrimitive(value) {
return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

// Pure - takes any candidate context object, returns exactly what's safe
// to use plus a full accounting of what was rejected and why. Never
// throws; a malformed/hostile input degrades to an empty safe context, the
// same "fail safe, not fake" philosophy as this app's config/auth modules.
function validate(rawContext) {
if (!isPlainObject(rawContext)) {
return { ok: true, context: {}, rejectedFields: [], reason: rawContext == null ? null : "not-an-object" };
}

var context = {};
var rejectedFields = [];

Object.keys(rawContext).forEach(function (key) {
if (FORBIDDEN_FIELD_PATTERN.test(key) || ALLOWED_FIELDS.indexOf(key) === -1) {
rejectedFields.push(key);
return;
}
var value = rawContext[key];
if (!isSafePrimitive(value)) {
rejectedFields.push(key);
return;
}
context[key] = value;
});

return { ok: true, context: context, rejectedFields: rejectedFields, reason: null };
}

function isEmptyContext(context) {
return !context || Object.keys(context).length === 0;
}

// Formats a validated context into the chip's short label style shown in
// docs/integration-prep/context-adapter-contract.md's examples ("Reading ·
// Cambridge 18 · Q17") - joins whichever of module/testId/questionId/
// pageType/resultSummary are actually present, in that priority order,
// skipping anything absent. Never invents a placeholder value for a
// missing field.
function formatChipLabel(context) {
if (isEmptyContext(context)) return null;
var parts = [context.module, context.testId, context.questionId, context.pageType, context.resultSummary]
.filter(function (v) { return v !== undefined && v !== null && v !== ""; });
return parts.length ? parts.join(" · ") : null;
}

// DOM-touching (unlike validate()/formatChipLabel() above, which are pure)
// - updates the existing #context-chip-text/.context-chip elements
// (index.html, unchanged structure from Phase 13/14) from a validated
// context. Nothing in this app calls this today; it exists so a future
// integration has one real, tested function to call instead of writing new
// chip-manipulation code. Falls back to the same honest "No active
// context" default the chip already shows when there is nothing to show.
function applyContext(rawContext) {
var result = validate(rawContext);
var chipEl = typeof document !== "undefined" ? document.getElementById("context-chip") : null;
var chipTextEl = typeof document !== "undefined" ? document.getElementById("context-chip-text") : null;
var label = formatChipLabel(result.context);

if (chipTextEl) chipTextEl.textContent = label || "No active context";
if (chipEl) chipEl.classList.toggle("has-context", Boolean(label));

return result;
}

return {
ALLOWED_FIELDS: ALLOWED_FIELDS,
validate: validate,
isEmptyContext: isEmptyContext,
formatChipLabel: formatChipLabel,
applyContext: applyContext
};
})();

// Node (tests) export.
if (typeof module !== "undefined" && module.exports) {
module.exports = LinguaHubContextAdapter;
}

if (typeof window !== "undefined") {
window.LinguaHubContextAdapter = LinguaHubContextAdapter;
}
