// LinguaHub AI - Firebase Authentication wrapper (Google sign-in).
//
// Loaded after the Firebase compat SDK (firebase-app-compat.js,
// firebase-auth-compat.js), firebase-config.js, and (Phase 10) the vendored
// Capacitor core + native Firebase Authentication plugin bundles. Exposes a
// small, defensive API on window.LinguaHubAuth so the rest of the app never
// talks to the `firebase` global (or the native plugin) directly. Every
// entry point is wrapped so that a missing/invalid configuration, a blocked
// popup, a native sign-in cancellation, or an SDK load failure degrades to
// "sign-in unavailable" - it never breaks chat, which must keep working for
// guests regardless of auth state.
//
// Two backends, selected exactly once at load time, never mixed:
//   - web:    the existing Firebase Web SDK (compat) popup/redirect flow -
//             used in the browser, Electron, and Capacitor iOS (unchanged
//             from Phase 1-9). Firebase itself owns session persistence
//             (IndexedDB-backed by default).
//   - native: the native @capacitor-firebase/authentication plugin - used
//             only when actually running as a native Android app (Phase 10).
//             The native platform's own Firebase Auth SDK (backed by
//             google-services.json, via Android's Credential Manager) owns
//             session persistence; this file caches only the last known
//             user object in memory (never localStorage) so the existing
//             synchronous getCurrentUser() contract keeps working.
// This file never writes the user or their ID token to localStorage under
// either backend - onAuthStateChanged is the single source of truth.

var LinguaHubAuth = (function () {
"use strict";

var GOOGLE_POPUP_FALLBACK_CODES = [
"auth/popup-blocked",
"auth/operation-not-supported-in-this-environment"
];

var ERROR_MESSAGES = {
"auth/popup-blocked": "Your browser blocked the sign-in popup. Please allow popups for this site and try again.",
"auth/popup-closed-by-user": "Sign-in was cancelled.",
"auth/cancelled-popup-request": "Sign-in was cancelled.",
"auth/unauthorized-domain": "This domain is not authorized for Google sign-in. Contact the app administrator.",
"auth/network-request-failed": "Network error during sign-in. Check your connection and try again.",
"auth/operation-not-supported-in-this-environment": "Google sign-in isn't supported in this app environment.",
"auth/admin-restricted-operation": "Google sign-in is restricted for this project.",
"config-missing": "Sign-in is unavailable: Firebase is not configured for this app.",
"sdk-missing": "Sign-in is unavailable: the Firebase SDK failed to load.",
"native-cancelled": "Sign-in was cancelled."
};

// Never falls back to the raw Firebase (or native plugin) error's own
// message - every call site used to pass error.message as a "fallback",
// which meant any error code NOT in ERROR_MESSAGES (i.e. most of them)
// leaked its raw internal text straight to the user instead of a safe
// generic message (found via a real error-matrix test, Phase 8). Only a
// fixed, known-safe string is ever shown for an unmapped code.
function safeError(code) {
return {
code: code || "unknown",
message: ERROR_MESSAGES[code] || "Sign-in failed. Please try again."
};
}

function hasUsableConfig(config) {
return Boolean(config && config.apiKey && config.projectId && config.appId);
}

// --- Web backend (Firebase compat SDK) - unchanged from Phase 1-9 --------

var config = (window.LINGUAHUB_CONFIG && window.LINGUAHUB_CONFIG.FIREBASE) || {};
var sdkPresent = typeof firebase !== "undefined" && !!firebase.initializeApp;
var webAvailable = false;
var auth = null;

if (!sdkPresent) {
console.warn("[LinguaHub AI] Firebase SDK did not load; running in guest-only mode.");
} else if (!hasUsableConfig(config)) {
console.warn("[LinguaHub AI] Firebase is not configured (www/firebase-config.js); running in guest-only mode.");
} else {
try {
if (!firebase.apps.length) {
firebase.initializeApp(config);
}
auth = firebase.auth();
webAvailable = true;
} catch (error) {
console.error("[LinguaHub AI] Firebase initialization failed:", error.message);
webAvailable = false;
}
}

// --- Native backend (Phase 10: @capacitor-firebase/authentication) -------
//
// Only ever selected when actually running as a native Android app -
// never in the browser, Electron, or (should this project add iOS later)
// a Capacitor iOS build, which keeps using the web backend above. Detected
// once, at load time, exactly like the web backend - "runtime platform
// detection", never re-evaluated mid-session, so the two backends can
// never both be considered active at once ("no duplicate signed-in
// states").
//
// www/firebase-config.js's blank public web values do NOT gate this path:
// native sign-in gets its Firebase project configuration from
// google-services.json (bundled into the native app at build time - see
// docs/android-firebase-configuration.md), not from that file.

function detectNativePlugin() {
try {
if (typeof window === "undefined" || !window.Capacitor) return null;
if (typeof window.Capacitor.isNativePlatform !== "function" || !window.Capacitor.isNativePlatform()) return null;
if (typeof window.Capacitor.getPlatform !== "function" || window.Capacitor.getPlatform() !== "android") return null;
var bridge = window.capacitorFirebaseAuthentication;
if (!bridge || !bridge.FirebaseAuthentication) return null;
return bridge.FirebaseAuthentication;
} catch (error) {
console.error("[LinguaHub AI] Native auth plugin detection failed:", error.message);
return null;
}
}

var nativePlugin = detectNativePlugin();
var isNative = Boolean(nativePlugin);
var cachedNativeUser = null;

// The plugin's User type uses `photoUrl` (lowercase "url"); every other
// part of this app (app.js, settings-ui.js) already reads the Firebase
// compat SDK's `photoURL` (capital "URL") - normalized here once so no
// caller needs to know which backend is active. getIdToken is attached as
// a bound method so getIdToken() below has one call path regardless of
// backend.
function normalizeNativeUser(user) {
if (!user) return null;
return {
uid: user.uid,
email: user.email || null,
displayName: user.displayName || null,
photoURL: user.photoUrl || null,
getIdToken: function (forceRefresh) {
return nativePlugin.getIdToken(forceRefresh ? { forceRefresh: true } : undefined).then(function (result) {
return result && result.token ? result.token : null;
}).catch(function (error) {
console.warn("[LinguaHub AI] Could not obtain a fresh native ID token:", error.code || error.message);
return null;
});
}
};
}

function nativeOnAuthStateChanged(callback) {
var unsubscribed = false;

// Prime immediately with the current state - mirrors the compat SDK's
// onAuthStateChanged contract of an always-async, single initial call,
// since the plugin's own 'authStateChange' listener is documented to
// fire only on subsequent changes, not the state at registration time.
nativePlugin.getCurrentUser().then(function (result) {
if (unsubscribed) return;
cachedNativeUser = normalizeNativeUser(result && result.user);
callback(cachedNativeUser);
}).catch(function (error) {
console.error("[LinguaHub AI] Native getCurrentUser failed:", error.message);
if (!unsubscribed) callback(null);
});

var handlePromise = nativePlugin.addListener("authStateChange", function (change) {
if (unsubscribed) return;
cachedNativeUser = normalizeNativeUser(change && change.user);
callback(cachedNativeUser);
});

return function unsubscribe() {
unsubscribed = true;
handlePromise.then(function (handle) {
return handle.remove();
}).catch(function () { /* already torn down - nothing to clean up */ });
};
}

function nativeSignInWithGoogle() {
return nativePlugin.signInWithGoogle().then(function (result) {
cachedNativeUser = normalizeNativeUser(result && result.user);
return cachedNativeUser;
}).catch(function (error) {
// The native Credential Manager sheet being dismissed/cancelled by the
// user is the one native-specific outcome worth a distinct (still
// safe, still generic) message; anything else falls back to
// safeError()'s fixed generic string exactly like the web path.
var code = error && (error.code || (/cancel/i.test(String(error.message)) ? "native-cancelled" : null));
throw safeError(code);
});
}

function nativeSignOutUser() {
return nativePlugin.signOut().then(function () {
cachedNativeUser = null;
}).catch(function (error) {
throw safeError(error && error.code);
});
}

// --- External identity adapter (Integration Prep phase) ------------------
//
// NOT used anywhere in this app today - inert until a future host
// (LinguaHub) calls it. Lets a future LinguaHub-side bridge script supply
// an ALREADY-resolved Google/Firebase identity ("one login, not two" - see
// docs/integration-prep/shared-auth-contract.md) instead of this app
// initiating its own popup/redirect sign-in flow. This is deliberately NOT
// a new auth provider or a new token system: the adapter is expected to
// wrap the same kind of Firebase user / ID-token this module already
// exposes everywhere else in this file - getIdToken() must still resolve
// to a real, freshly-issued Firebase ID token, verified server-side
// exactly as today by the existing, unmodified middleware/auth.js. This
// module never fabricates a user, never trusts a plain user id handed to
// it, and never persists anything the adapter provides in any client-side
// store.
var externalAdapter = null;

function provideExternalIdentity(adapter) {
var hasRequiredShape = adapter &&
typeof adapter.getCurrentUser === "function" &&
typeof adapter.onAuthStateChanged === "function" &&
typeof adapter.getIdToken === "function";
if (!hasRequiredShape) {
console.error("[LinguaHub AI] provideExternalIdentity() requires getCurrentUser/onAuthStateChanged/getIdToken functions - ignoring an incomplete adapter.");
return;
}
externalAdapter = adapter;
}

// --- Unified public API - dispatches to whichever backend is active ------

var available = isNative || webAvailable;

function isAvailable() {
return Boolean(externalAdapter) || available;
}

function getCurrentUser() {
if (externalAdapter) return externalAdapter.getCurrentUser();
if (isNative) return cachedNativeUser;
return webAvailable && auth ? auth.currentUser : null;
}

function onAuthStateChanged(callback) {
if (externalAdapter) return externalAdapter.onAuthStateChanged(callback);
if (isNative) return nativeOnAuthStateChanged(callback);

if (!webAvailable) {
// Keep the calling code's contract identical either way: async,
// single initial call with the (always-null) user.
var timer = setTimeout(function () {
callback(null);
}, 0);
return function unsubscribe() {
clearTimeout(timer);
};
}
return auth.onAuthStateChanged(callback, function (error) {
console.error("[LinguaHub AI] Auth state observer error:", error.message);
callback(null);
});
}

function completeRedirectSignIn() {
// Native sign-in never redirects the page - only the web backend's
// popup-blocked fallback does.
if (isNative || !webAvailable) return Promise.resolve(null);
return auth.getRedirectResult().then(function (result) {
return result && result.user ? result.user : null;
}).catch(function (error) {
console.warn("[LinguaHub AI] Redirect sign-in did not complete:", error.code || error.message);
return null;
});
}

function signInWithGoogle() {
if (isNative) return nativeSignInWithGoogle();

if (!webAvailable) {
return Promise.reject(safeError(sdkPresent ? "config-missing" : "sdk-missing"));
}

var provider = new firebase.auth.GoogleAuthProvider();

return auth.signInWithPopup(provider).then(function (result) {
return result.user;
}).catch(function (error) {
if (GOOGLE_POPUP_FALLBACK_CODES.indexOf(error.code) !== -1) {
// Popup isn't viable in this runtime (e.g. blocked, or an embedded
// webview that refuses window.open) - fall back to a full redirect.
// The result is picked up by completeRedirectSignIn() on next load.
return auth.signInWithRedirect(provider).then(function () {
return null;
});
}
throw safeError(error.code);
});
}

function signOutUser() {
if (isNative) return nativeSignOutUser();
if (!webAvailable) return Promise.resolve();
return auth.signOut().catch(function (error) {
throw safeError(error.code);
});
}

function getIdToken(forceRefresh) {
if (externalAdapter) return externalAdapter.getIdToken(Boolean(forceRefresh));
var user = getCurrentUser();
if (!user) return Promise.resolve(null);
return user.getIdToken(Boolean(forceRefresh)).catch(function (error) {
console.warn("[LinguaHub AI] Could not obtain a fresh ID token:", error.code || error.message);
return null;
});
}

return {
isAvailable: isAvailable,
getCurrentUser: getCurrentUser,
onAuthStateChanged: onAuthStateChanged,
completeRedirectSignIn: completeRedirectSignIn,
signInWithGoogle: signInWithGoogle,
signOutUser: signOutUser,
getIdToken: getIdToken,
provideExternalIdentity: provideExternalIdentity
};
})();
