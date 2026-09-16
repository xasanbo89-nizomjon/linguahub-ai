"use strict";

// Phase 10, Task 17: structural/unit coverage for the native Android auth
// backend added to www/auth.js (see docs/capacitor-native-auth.md). Runs
// the REAL www/auth.js source (no rewrite/mock of the production code
// itself) in a sandboxed vm context with a fake window.Capacitor + fake
// native FirebaseAuthentication plugin bridge - the same "real source,
// fake environment" approach tests/frontend-auth.test.js already uses for
// the web backend.
//
// No Android SDK, emulator, or device is available in this environment
// (see docs/android-runtime-report.md) - this suite is explicitly NOT a
// substitute for real on-device verification (Task 13 of Phase 10 is
// honestly marked NOT RUN/BLOCKED for that reason). It only locks in the
// adapter's own dispatch/normalization logic: which backend gets selected,
// that the synchronous getCurrentUser() contract survives being backed by
// an async native bridge, and that native errors never leak raw text.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const AUTH_SRC = fs.readFileSync(path.join(__dirname, "..", "www", "auth.js"), "utf8");

function makeFakeNativePlugin(overrides) {
  const listeners = {};
  const plugin = Object.assign({
    getCurrentUser: async () => ({ user: null }),
    addListener: async (eventName, cb) => {
      listeners[eventName] = cb;
      return { remove: async () => { delete listeners[eventName]; } };
    },
    signInWithGoogle: async () => ({
      user: { uid: "native-user", email: "native@example.com", displayName: "Native User", photoUrl: "https://example.com/p.png" }
    }),
    signOut: async () => {},
    getIdToken: async () => ({ token: "native-id-token" })
  }, overrides);
  plugin.__emit = (eventName, payload) => { if (listeners[eventName]) listeners[eventName](payload); };
  return plugin;
}

function buildNativeAuthSandbox({ platform = "android", pluginOverrides = {} } = {}) {
  const nativePlugin = makeFakeNativePlugin(pluginOverrides);
  const sandbox = {
    console, setTimeout, clearTimeout,
    // Blank web config, on purpose: native availability must never depend
    // on www/firebase-config.js (that file stays blank on Android - native
    // sign-in is configured entirely via google-services.json).
    LINGUAHUB_CONFIG: { FIREBASE: { apiKey: "", projectId: "", appId: "" } },
    Capacitor: {
      isNativePlatform: () => true,
      getPlatform: () => platform
    },
    capacitorFirebaseAuthentication: { FirebaseAuthentication: nativePlugin }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(AUTH_SRC, sandbox, { filename: "auth.js" });
  return { sandbox, nativePlugin };
}

test("auth.js: on native Android, isAvailable() is true even though the web Firebase config is blank", () => {
  const { sandbox } = buildNativeAuthSandbox();
  assert.equal(sandbox.LinguaHubAuth.isAvailable(), true);
});

test("auth.js: on a non-Android native platform, the native Android plugin path is NOT selected", () => {
  const { sandbox } = buildNativeAuthSandbox({ platform: "ios" });
  // Blank web config + not-Android native platform -> unavailable, exactly
  // like a plain browser with no config. Locks in that the gate really
  // checks getPlatform() === "android", not just isNativePlatform().
  assert.equal(sandbox.LinguaHubAuth.isAvailable(), false);
});

test("auth.js: on the web (no window.Capacitor at all), the native path is never selected", () => {
  const sandbox = { console, setTimeout, clearTimeout, LINGUAHUB_CONFIG: { FIREBASE: { apiKey: "", projectId: "", appId: "" } } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(AUTH_SRC, sandbox, { filename: "auth.js" });
  assert.equal(sandbox.LinguaHubAuth.isAvailable(), false);
});

test("auth.js: signInWithGoogle on native Android calls the native plugin, not any web popup", async () => {
  const { sandbox, nativePlugin } = buildNativeAuthSandbox();
  let calls = 0;
  const originalSignIn = nativePlugin.signInWithGoogle;
  nativePlugin.signInWithGoogle = async () => { calls += 1; return originalSignIn(); };
  const user = await sandbox.LinguaHubAuth.signInWithGoogle();
  assert.equal(calls, 1);
  assert.equal(user.uid, "native-user");
});

test("auth.js: the native plugin's photoUrl (lowercase) is normalized to photoURL for the rest of the app", async () => {
  const { sandbox } = buildNativeAuthSandbox();
  const user = await sandbox.LinguaHubAuth.signInWithGoogle();
  assert.equal(user.photoURL, "https://example.com/p.png");
  assert.equal(user.photoUrl, undefined, "must not leak the plugin's own casing - callers only know photoURL");
});

test("auth.js: getCurrentUser() stays synchronous on native Android, backed by the auth-state cache", async () => {
  const { sandbox } = buildNativeAuthSandbox({
    pluginOverrides: { getCurrentUser: async () => ({ user: { uid: "restored-native-user" } }) }
  });
  let received;
  sandbox.LinguaHubAuth.onAuthStateChanged((user) => { received = user; });
  // Real async native bridge call - wait for the microtask/timer queue to settle.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(received.uid, "restored-native-user");
  assert.equal(
    sandbox.LinguaHubAuth.getCurrentUser().uid,
    "restored-native-user",
    "getCurrentUser() must return synchronously once primed, exactly like the web backend's auth.currentUser"
  );
});

test("auth.js: the native authStateChange listener updates the cache for later synchronous getCurrentUser() calls", async () => {
  const { sandbox, nativePlugin } = buildNativeAuthSandbox();
  sandbox.LinguaHubAuth.onAuthStateChanged(() => {});
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sandbox.LinguaHubAuth.getCurrentUser(), null);

  nativePlugin.__emit("authStateChange", { user: { uid: "changed-user", email: "c@example.com" } });
  assert.equal(sandbox.LinguaHubAuth.getCurrentUser().uid, "changed-user");

  nativePlugin.__emit("authStateChange", { user: null });
  assert.equal(sandbox.LinguaHubAuth.getCurrentUser(), null, "sign-out via the native listener must clear the cache");
});

test("auth.js: getIdToken() on native Android calls the plugin's getIdToken", async () => {
  const { sandbox } = buildNativeAuthSandbox();
  await sandbox.LinguaHubAuth.signInWithGoogle();
  const token = await sandbox.LinguaHubAuth.getIdToken();
  assert.equal(token, "native-id-token");
});

test("auth.js: getIdToken() resolves to null (not a throw) when no native user is signed in", async () => {
  const { sandbox } = buildNativeAuthSandbox();
  const token = await sandbox.LinguaHubAuth.getIdToken();
  assert.equal(token, null);
});

test("auth.js: native signOutUser() calls the plugin and clears the cached user", async () => {
  const { sandbox } = buildNativeAuthSandbox();
  await sandbox.LinguaHubAuth.signInWithGoogle();
  assert.notEqual(sandbox.LinguaHubAuth.getCurrentUser(), null);
  await sandbox.LinguaHubAuth.signOutUser();
  assert.equal(sandbox.LinguaHubAuth.getCurrentUser(), null);
});

test("auth.js: a native sign-in failure is reported as a safe error, never the raw plugin error text", async () => {
  const { sandbox } = buildNativeAuthSandbox({
    pluginOverrides: {
      signInWithGoogle: async () => { throw new Error("some raw native stack trace detail that must never reach the UI"); }
    }
  });
  await assert.rejects(() => sandbox.LinguaHubAuth.signInWithGoogle(), (err) => {
    assert.doesNotMatch(err.message, /raw native stack trace/);
    return true;
  });
});

test("auth.js: completeRedirectSignIn() on native Android is a safe no-op (native sign-in never redirects the page)", async () => {
  const { sandbox } = buildNativeAuthSandbox();
  const result = await sandbox.LinguaHubAuth.completeRedirectSignIn();
  assert.equal(result, null);
});

test("auth.js never writes a token to localStorage, including in the new native backend (structural check)", () => {
  assert.doesNotMatch(AUTH_SRC, /localStorage\s*[.[]\s*(setItem|['"`]?\w)/);
});

test("auth.js never logs a raw ID token, including in the new native backend (structural check)", () => {
  // Every console.* call in the file is enumerated and checked individually
  // so this can't be fooled by (or falsely flag) unrelated surrounding text
  // - each one must only reference error.code/error.message, a fixed
  // string, or a non-token identifier, never a bare token/result value.
  const consoleCalls = AUTH_SRC.match(/console\.\w+\([^;]*?\);/g) || [];
  assert.ok(consoleCalls.length > 0, "sanity check: this file should contain console calls to inspect");
  for (const call of consoleCalls) {
    // Strip quoted string literals first - human-readable labels like
    // "...fresh native ID token:" legitimately contain the word "token"
    // and are not the thing being flagged; only a bare token identifier
    // passed as an actual logged *value* (outside any string literal) is.
    const withoutStringLiterals = call.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''");
    assert.doesNotMatch(withoutStringLiterals, /\btoken\b/, `a console call must never reference a raw token value: ${call}`);
  }
});
