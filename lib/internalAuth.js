"use strict";

// LinguaHub AI - internal service-to-service authentication for trusted
// page context (Task: trusted-context transport contract).
//
// Completely separate from middleware/auth.js (Firebase end-user identity,
// unchanged by this file). This is a SECOND, independent authentication
// mechanism: a single shared secret (LINGUAHUB_INTERNAL_TOKEN) that only
// LinguaHub's own backend is expected to hold, sent as the
// X-LinguaHub-Internal-Token header. It authenticates the CALLER (is this
// really LinguaHub's backend?), never an end user - Firebase auth
// (authenticateOptional, req.user) keeps doing that job exactly as before,
// completely independently of whether trusted context is also present.
//
// Nothing in this repository sends this header today - LinguaHub does not
// exist in this project. Every call site that supplies trusted `context`
// in a request body MUST pass through verifyInternalToken() first (see
// server.js's validateChatBody) - ordinary public/guest chat requests
// never touch this file at all.

const crypto = require("crypto");

const HEADER_NAME = "x-linguahub-internal-token";

function isNonEmptyString(value) {
return typeof value === "string" && value.length > 0;
}

// Constant-time comparison so a wrong-length or wrong-content token takes
// the same time to reject either way - crypto.timingSafeEqual itself
// throws on mismatched buffer lengths, so that case is handled explicitly
// first rather than being allowed to throw (and, separately, two empty/
// missing values must never be treated as "matching").
function safeTokenMatch(provided, expected) {
if (!isNonEmptyString(provided) || !isNonEmptyString(expected)) return false;
const providedBuf = Buffer.from(provided, "utf8");
const expectedBuf = Buffer.from(expected, "utf8");
if (providedBuf.length !== expectedBuf.length) return false;
return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

// Reads the configured token fresh on every call (not cached at module
// load) so tests can set/unset process.env.LINGUAHUB_INTERNAL_TOKEN
// between cases without needing to reload this module.
function getConfiguredToken() {
return process.env.LINGUAHUB_INTERNAL_TOKEN;
}

function isInternalAuthConfigured() {
return isNonEmptyString(getConfiguredToken());
}

// Fails closed by construction: if no token is configured server-side at
// all, this returns false for every input, including an empty/missing
// provided value - there is no configuration state in which trusted
// context can ever be accepted without a real, explicitly-set server-side
// secret.
function verifyInternalToken(providedToken) {
const expected = getConfiguredToken();
if (!isNonEmptyString(expected)) return false;
return safeTokenMatch(providedToken, expected);
}

// Reads the token from a real Express request the same way every call
// site should - one place that knows the exact header name, so it's never
// spelled differently (or cased differently) in more than one file.
function getProvidedTokenFromRequest(req) {
const value = req.headers ? req.headers[HEADER_NAME] : undefined;
return typeof value === "string" ? value : null;
}

module.exports = {
HEADER_NAME,
isInternalAuthConfigured,
verifyInternalToken,
getProvidedTokenFromRequest,
// Exported for tests only - never used by application code, which always
// goes through verifyInternalToken()/getProvidedTokenFromRequest().
safeTokenMatch
};
