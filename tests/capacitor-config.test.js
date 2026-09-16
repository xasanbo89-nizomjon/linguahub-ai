"use strict";

// Phase 8, Task 14: Capacitor config validation. Source-level only - no
// Android/iOS SDK or emulator is available in this environment (see
// docs/capacitor-runtime-report.md).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const CONFIG_PATH = path.join(__dirname, "..", "capacitor.config.json");
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

test("capacitor.config.json is valid JSON with the required fields", () => {
  assert.equal(typeof config.appId, "string");
  assert.ok(config.appId.length > 0);
  assert.equal(typeof config.appName, "string");
  assert.ok(config.appName.length > 0);
  assert.equal(typeof config.webDir, "string");
});

test("capacitor.config.json's webDir points at the real, existing frontend directory", () => {
  const wwwPath = path.join(__dirname, "..", config.webDir);
  assert.ok(fs.existsSync(wwwPath), `webDir "${config.webDir}" does not exist`);
  assert.ok(fs.existsSync(path.join(wwwPath, "index.html")), "webDir must contain index.html");
});

test("capacitor.config.json has no server.url override (uses the default bundled-webview origin, matching config.js's assumptions)", () => {
  // www/config.js's computeApiBase() specifically special-cases the DEFAULT
  // Capacitor origins (capacitor://localhost, and Android's https://localhost
  // with no port) - a custom server.url would change what origin the
  // WebView actually uses and could silently break that resolution logic.
  assert.equal(config.server, undefined);
});

test("capacitor.config.json's appId follows reverse-domain-notation format", () => {
  assert.match(config.appId, /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/i);
});

// Phase 10, Task 9/11: the native Google Auth plugin config. skipNativeAuth
// must stay false (native auth is the whole point - see
// docs/capacitor-native-auth.md's decision), and providers must list only
// google.com - this app has no Apple/Facebook/GitHub/etc. sign-in, and an
// empty or wrong providers list would either fail to load the Google native
// SDK at all or needlessly initialize third-party SDKs this app never uses
// (see the plugin's own "Third-Party SDKs" warning).
test("capacitor.config.json configures the native Firebase Authentication plugin for Google-only, native auth", () => {
  const pluginConfig = config.plugins && config.plugins.FirebaseAuthentication;
  assert.ok(pluginConfig, "plugins.FirebaseAuthentication config must exist");
  assert.equal(pluginConfig.skipNativeAuth, false);
  assert.deepEqual(pluginConfig.providers, ["google.com"]);
});
