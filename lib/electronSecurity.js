"use strict";

// LinguaHub AI - pure Electron navigation/popup/IPC allowlist logic.
//
// Extracted out of main.js so it's unit-testable without launching a real
// Electron process (main.js itself calls app.whenReady() at load time,
// which throws immediately if required outside an actual Electron main
// process). Used by main.js's setWindowOpenHandler (popups), its
// will-navigate guard (top-level navigation) and its IPC sender check.

// The same trusted domains are correct for both the popup handler and the
// will-navigate guard, since signInWithPopup and its signInWithRedirect
// fallback (www/auth.js) only ever need to reach these two.
function isTrustedGoogleAuthUrl(url) {
  return typeof url === "string" && (
    url.startsWith("https://accounts.google.com/") ||
    /^https:\/\/[^/]+\.firebaseapp\.com\//.test(url)
  );
}

// IPC sender check (Phase 1 custom title bar). The window-control channels
// in main.js act only for the app's own local page - never for a Google
// auth popup or any other frame that might end up inside a window. Query
// string and hash are ignored (the app may add a fragment); the path must
// match exactly.
function isTrustedSenderUrl(url, indexFileUrl) {
  if (typeof url !== "string" || typeof indexFileUrl !== "string" || !indexFileUrl) return false;
  return url.split(/[?#]/)[0] === indexFileUrl.split(/[?#]/)[0];
}

// Permission allowlist (Phase 5, speech input). Electron grants every
// permission request by default; main.js installs handlers that call this
// instead. Only the app's own page may use the MICROPHONE (audio only - never
// the camera, even if a page asks for both) and write to the clipboard
// (the Copy buttons). Everything else - notifications, geolocation, MIDI,
// camera, screen capture... - is denied.
function isPermissionAllowed({ permission, mediaTypes, url, indexFileUrl }) {
  if (!isTrustedSenderUrl(url, indexFileUrl)) return false;
  if (permission === "clipboard-sanitized-write") return true;
  if (permission !== "media") return false;
  // The request handler lists mediaTypes ("audio" / "video"); the check
  // handler passes a single mediaType. No types given means unknown: deny.
  if (!Array.isArray(mediaTypes) || mediaTypes.length === 0) return false;
  return mediaTypes.every((type) => type === "audio");
}

module.exports = { isTrustedGoogleAuthUrl, isTrustedSenderUrl, isPermissionAllowed };
