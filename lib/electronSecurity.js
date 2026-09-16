"use strict";

// LinguaHub AI - pure Electron navigation/popup allowlist logic.
//
// Extracted out of main.js so it's unit-testable without launching a real
// Electron process (main.js itself calls app.whenReady() at load time,
// which throws immediately if required outside an actual Electron main
// process). Used by both main.js's setWindowOpenHandler (popups) and its
// will-navigate guard (top-level navigation) - the same trusted domains are
// correct for both, since signInWithPopup and its signInWithRedirect
// fallback (www/auth.js) only ever need to reach these two.

function isTrustedGoogleAuthUrl(url) {
return typeof url === "string" && (
url.startsWith("https://accounts.google.com/") ||
/^https:\/\/[^/]+\.firebaseapp\.com\//.test(url)
);
}

module.exports = { isTrustedGoogleAuthUrl };
