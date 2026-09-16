"use strict";

// LinguaHub AI - trusted page-context validator/sanitizer (Task: trusted-
// context transport contract).
//
// Only ever invoked AFTER lib/internalAuth.js has already verified the
// caller is LinguaHub's own backend (see server.js's validateChatBody) -
// this module's job is not "is this caller allowed to send context" (that
// is internalAuth's job), it's "is this specific context object itself
// structurally safe to use." Both checks are required; neither substitutes
// for the other.
//
// Deliberately stricter than www/context-adapter.js (the earlier,
// unrelated FRONTEND validation contract for a different, still-
// unconnected chip-context concept - see docs/integration-prep/
// context-adapter-contract.md). That module silently strips unknown
// fields because it's a best-effort UI courtesy filter with no security
// boundary behind it. This one is the actual security boundary for data
// that will be inserted into a real provider request, sent from an
// AUTHENTICATED internal caller - so it fails LOUD (rejects the whole
// request) on anything unexpected, exactly like server.js's own
// FORBIDDEN_REQUEST_FIELDS check already does for the top-level chat body.

// Exactly the nine fields the trusted-context contract defines - a field
// is not here because it might be useful someday.
const ALLOWED_TOP_LEVEL_KEYS = [
"contextType", "module", "page", "language", "userRole",
"examState", "resource", "result", "capabilities"
];

// Case-insensitive, matched against every key at every nesting depth (not
// just the top level) - a forbidden key hidden inside `resource`/`result`/
// `capabilities` is exactly as dangerous as one at the top level. Covers
// the exact list the task names plus documented "obvious case variants"
// (snake_case/camelCase forms already fold together once lowercased).
const FORBIDDEN_KEY_PATTERN = /api[_-]?key|token|authoriz|firebase|password|secret|database[_-]?url|system[_-]?prompt|^model$|temperature|^tools$/i;

// Real prototype-pollution vectors - rejected regardless of the forbidden
// pattern above (they wouldn't otherwise match it).
const PROTOTYPE_POLLUTION_KEYS = ["__proto__", "constructor", "prototype"];

const LIMITS = {
// Whole serialized context object, in bytes.
maxSerializedBytes: 8000,
// Any single string value, anywhere in the structure.
maxStringLength: 4000,
// Any single array, anywhere in the structure.
maxArrayLength: 50,
// How many levels deep an object/array may nest (the top-level context
// object itself is depth 0; resource.details.foo would be depth 2).
maxDepth: 4,
// Keys on any single object, anywhere in the structure.
maxKeysPerObject: 40
};

const KNOWN_EXAM_STATES = ["ACTIVE_EXAM", "PRACTICE", "POST_SUBMISSION"];
// Deliberately distinct from any real exam state - Task: "If examState is
// UNKNOWN or ambiguous, fail safe: treat academic answer-help as
// restricted rather than assuming Practice Mode." Anything that isn't
// exactly one of KNOWN_EXAM_STATES normalizes to this, INCLUDING a
// missing examState field on an otherwise-present context object (if
// LinguaHub sent context at all, "we don't know the exam state" is not
// the same as "there is no exam concept here" - see
// lib/contextBuilder.js's formatTrustedContextMessage for where this
// normalized value is actually turned into model-facing guidance).
const UNKNOWN_EXAM_STATE = "UNKNOWN_TREAT_AS_ACTIVE_EXAM";

function isForbiddenKey(key) {
const normalized = String(key).toLowerCase();
if (PROTOTYPE_POLLUTION_KEYS.includes(normalized)) return true;
return FORBIDDEN_KEY_PATTERN.test(normalized);
}

// Real HTTP request bodies arrive via JSON.parse (express.json()), which
// never triggers the special "__proto__ object-literal" behavior below -
// a "__proto__" key in real JSON becomes an ordinary, safely-enumerable
// own property (verified directly: Object.keys(JSON.parse('{"__proto__":
// {}}')) === ["__proto__"], prototype unchanged). The extra
// getPrototypeOf check here is defense in depth for any OTHER caller of
// this module that might hand it a hand-constructed JS object literal -
// `{ __proto__: {...} }` as literal source code does NOT create an own
// "__proto__" property at all (Object.keys is empty), it actually
// REPLACES the object's prototype, which Object.keys-based scanning alone
// can never see. Anything other than the ordinary Object.prototype (or an
// explicit null-prototype object, also safe) is rejected outright.
function hasTamperedPrototype(value) {
const proto = Object.getPrototypeOf(value);
return proto !== Object.prototype && proto !== null;
}

function isPlainObject(value) {
if (!value || typeof value !== "object" || Array.isArray(value)) return false;
return !hasTamperedPrototype(value);
}

// Recursively checks structural limits (depth/size/key-count) AND scans
// for forbidden/prototype-pollution keys at every level. Returns a single
// { ok, reason } - the first problem found anywhere aborts the whole
// context (never a partial accept).
function scanValue(value, depth) {
if (depth > LIMITS.maxDepth) {
return { ok: false, reason: "context is nested too deeply" };
}
if (value === null || value === undefined) return { ok: true };

const type = typeof value;
if (type === "string") {
if (value.length > LIMITS.maxStringLength) {
return { ok: false, reason: "a context string value is too long" };
}
return { ok: true };
}
if (type === "number" || type === "boolean") return { ok: true };

if (Array.isArray(value)) {
if (value.length > LIMITS.maxArrayLength) {
return { ok: false, reason: "a context array is too long" };
}
for (const item of value) {
const result = scanValue(item, depth + 1);
if (!result.ok) return result;
}
return { ok: true };
}

if (isPlainObject(value)) {
const keys = Object.keys(value);
if (keys.length > LIMITS.maxKeysPerObject) {
return { ok: false, reason: "a context object has too many fields" };
}
for (const key of keys) {
if (isForbiddenKey(key)) {
return { ok: false, reason: `forbidden context field: ${key}` };
}
const result = scanValue(value[key], depth + 1);
if (!result.ok) return result;
}
return { ok: true };
}

// Functions, symbols, class instances, etc. - never a valid context value.
return { ok: false, reason: "context contains an unsupported value type" };
}

// Deep-copies only plain JSON-safe data (the shapes scanValue() already
// approved) into fresh objects/arrays - the sanitized result never shares
// object identity with whatever the caller originally sent, so nothing
// downstream can be affected by the caller mutating its own original
// object after this function returns.
function deepClonePlain(value) {
if (Array.isArray(value)) return value.map(deepClonePlain);
if (isPlainObject(value)) {
const out = {};
for (const key of Object.keys(value)) out[key] = deepClonePlain(value[key]);
return out;
}
return value;
}

function normalizeExamState(examState) {
if (typeof examState === "string" && KNOWN_EXAM_STATES.includes(examState)) {
return examState;
}
return UNKNOWN_EXAM_STATE;
}

// The one exported entry point. Pure - no I/O, no logging, no throwing.
// rawContext === undefined/null is treated as "no context supplied" (ok,
// context: null), matching server.js's own "context is entirely optional"
// contract - this function is never even called unless the request body
// actually has a `context` key at all (see server.js), so undefined here
// would be unusual, but handled safely regardless.
function sanitizeContext(rawContext) {
if (rawContext === undefined || rawContext === null) {
return { ok: true, context: null, reason: null };
}

if (!isPlainObject(rawContext)) {
return { ok: false, context: null, reason: "context must be a plain object" };
}

let serialized;
try {
serialized = JSON.stringify(rawContext);
} catch (error) {
return { ok: false, context: null, reason: "context is not serializable" };
}
if (Buffer.byteLength(serialized, "utf8") > LIMITS.maxSerializedBytes) {
return { ok: false, context: null, reason: "context exceeds the maximum allowed size" };
}

const topLevelKeys = Object.keys(rawContext);
for (const key of topLevelKeys) {
if (isForbiddenKey(key)) {
return { ok: false, context: null, reason: `forbidden context field: ${key}` };
}
if (!ALLOWED_TOP_LEVEL_KEYS.includes(key)) {
return { ok: false, context: null, reason: `unsupported context field: ${key}` };
}
}

const scanResult = scanValue(rawContext, 0);
if (!scanResult.ok) {
return { ok: false, context: null, reason: scanResult.reason };
}

const sanitized = deepClonePlain(rawContext);
// examState is normalized here (not left as whatever raw string the
// caller sent) so every later consumer (lib/contextBuilder.js, and any
// test) works from the same small, closed set of values instead of
// re-implementing this fail-safe rule.
if (Object.prototype.hasOwnProperty.call(sanitized, "examState")) {
sanitized.examState = normalizeExamState(sanitized.examState);
}

return { ok: true, context: sanitized, reason: null };
}

module.exports = {
ALLOWED_TOP_LEVEL_KEYS,
FORBIDDEN_KEY_PATTERN,
LIMITS,
KNOWN_EXAM_STATES,
UNKNOWN_EXAM_STATE,
isForbiddenKey,
normalizeExamState,
sanitizeContext
};
