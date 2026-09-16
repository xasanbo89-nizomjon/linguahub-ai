"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const config = require("../www/config.js");

function loc(overrides) {
  return Object.assign({ protocol: "http:", hostname: "127.0.0.1", port: "" }, overrides);
}

test("Live Server dev frontend (127.0.0.1:5500) resolves to the local backend, not port 5500", () => {
  const base = config.computeApiBase(loc({ hostname: "127.0.0.1", port: "5500" }));
  assert.equal(base, config.DEV_BACKEND_DEFAULT);
  assert.doesNotMatch(base, /:5500/);
});

test("Live Server dev frontend (localhost:5500) resolves to the local backend", () => {
  const base = config.computeApiBase(loc({ hostname: "localhost", port: "5500" }));
  assert.equal(base, "http://127.0.0.1:3000");
});

test("page served by the Express backend itself uses a same-origin relative URL", () => {
  const base = config.computeApiBase(loc({ hostname: "127.0.0.1", port: "3000" }));
  assert.equal(base, "");
});

test("page served by the backend on a non-default port still resolves same-origin (no hardcoded 3000)", () => {
  const base = config.computeApiBase(loc({ hostname: "127.0.0.1", port: "4000" }));
  assert.equal(base, "");
});

test("production domain does not silently fall back to localhost", () => {
  const base = config.computeApiBase(loc({ protocol: "https:", hostname: "app.example.com", port: "" }));
  assert.equal(base, "");
  assert.doesNotMatch(base, /localhost|127\.0\.0\.1/);
});

test("Electron file:// origin resolves to the local backend", () => {
  const base = config.computeApiBase(loc({ protocol: "file:", hostname: "", port: "" }));
  assert.equal(base, config.DEV_BACKEND_DEFAULT);
});

test("Capacitor iOS capacitor:// origin resolves to the local backend", () => {
  const base = config.computeApiBase(loc({ protocol: "capacitor:", hostname: "localhost", port: "" }));
  assert.equal(base, config.DEV_BACKEND_DEFAULT);
});

test("Capacitor Android default https://localhost origin resolves to the Android-emulator host alias, not 127.0.0.1 (Phase 10 fix)", () => {
  // Real bug found in Phase 10: the Android emulator's own 127.0.0.1 is the
  // emulated device itself, not the host machine running the backend - a
  // real Android emulator could never reach DEV_BACKEND_DEFAULT. 10.0.2.2
  // is the documented Android-emulator-only alias for the host's loopback.
  const base = config.computeApiBase(loc({ protocol: "https:", hostname: "localhost", port: "" }));
  assert.equal(base, config.ANDROID_EMULATOR_BACKEND_DEFAULT);
  assert.equal(base, "http://10.0.2.2:3000");
  assert.notEqual(base, config.DEV_BACKEND_DEFAULT);
});

test("Electron file:// and Capacitor iOS capacitor:// origins are unaffected by the Android emulator fix", () => {
  // Electron and the iOS Simulator share the host machine's own network
  // namespace, unlike the Android emulator - both must keep resolving to
  // 127.0.0.1, not 10.0.2.2 (which is meaningless outside an Android VM).
  assert.equal(config.computeApiBase(loc({ protocol: "file:", hostname: "", port: "" })), config.DEV_BACKEND_DEFAULT);
  assert.equal(config.computeApiBase(loc({ protocol: "capacitor:", hostname: "localhost", port: "" })), config.DEV_BACKEND_DEFAULT);
});

test("a physical Android device (not the emulator) still requires an explicit override - no LAN IP is guessed", () => {
  // 10.0.2.2 only means anything inside the emulator's own virtual NAT; on
  // a real device it resolves to nothing. There is no way to auto-detect
  // the host's real LAN IP from the WebView, so the same explicit-override
  // mechanism (priority 1, tested above) is required there - this test
  // just documents that the auto-default is emulator-shaped, not "works
  // everywhere".
  const base = config.computeApiBase(loc({ protocol: "https:", hostname: "localhost", port: "" }), "http://192.168.1.50:3000");
  assert.equal(base, "http://192.168.1.50:3000");
});

test("explicit override always wins over auto-detection", () => {
  const base = config.computeApiBase(loc({ hostname: "127.0.0.1", port: "5500" }), "https://api.example.com");
  assert.equal(base, "https://api.example.com");
});

test("trailing slashes are normalized on override URLs", () => {
  assert.equal(config.normalizeBaseUrl("http://127.0.0.1:3000/"), "http://127.0.0.1:3000");
  assert.equal(config.normalizeBaseUrl("http://127.0.0.1:3000///"), "http://127.0.0.1:3000");
});

test("buildApiUrl never produces a double slash or duplicated /api", () => {
  assert.equal(config.buildApiUrl("http://127.0.0.1:3000/", "/api/chat/stream"), "http://127.0.0.1:3000/api/chat/stream");
  assert.equal(config.buildApiUrl("", "/api/chat/stream"), "/api/chat/stream");
  assert.equal(config.buildApiUrl("http://127.0.0.1:3000", "api/chat/stream"), "http://127.0.0.1:3000/api/chat/stream");
});

// --- Phase 11: production-hardening additions -----------------------------

test("a real HTTPS production domain never falls back to localhost, 127.0.0.1, or port 5500", () => {
  const base = config.computeApiBase(loc({ protocol: "https:", hostname: "app.example.com", port: "" }));
  assert.equal(base, "");
  assert.doesNotMatch(base, /localhost|127\.0\.0\.1|:5500/);
});

test("a production domain on a non-default HTTPS port still resolves same-origin, never port 5500", () => {
  const base = config.computeApiBase(loc({ protocol: "https:", hostname: "app.example.com", port: "8443" }));
  assert.equal(base, "");
  assert.doesNotMatch(base, /:5500/);
});

test("isValidBaseUrlOverride accepts a bare absolute http(s) origin, with or without a port", () => {
  assert.equal(config.isValidBaseUrlOverride("https://api.example.com"), true);
  assert.equal(config.isValidBaseUrlOverride("https://api.example.com:8443"), true);
  assert.equal(config.isValidBaseUrlOverride("http://127.0.0.1:3000"), true);
});

test("isValidBaseUrlOverride rejects anything that isn't a clean absolute http(s) base URL", () => {
  assert.equal(config.isValidBaseUrlOverride(""), false);
  assert.equal(config.isValidBaseUrlOverride("not a url"), false);
  assert.equal(config.isValidBaseUrlOverride("ftp://example.com"), false);
  assert.equal(config.isValidBaseUrlOverride("javascript:alert(1)"), false);
  assert.equal(config.isValidBaseUrlOverride("https://api.example.com/some/path"), false, "a base URL must not include a path");
  assert.equal(config.isValidBaseUrlOverride("https://api.example.com?x=1"), false, "a base URL must not include a query string");
});

test("an invalid override is never silently used - falls back to auto-detection and reports the bad value", () => {
  const location = loc({ protocol: "https:", hostname: "app.example.com", port: "" });
  const resolved = config.resolve(location, { API_BASE_URL: "not a valid url" });
  assert.equal(resolved.API_BASE_URL, "", "must fall back to the same auto-detected value a missing override would produce");
  assert.equal(resolved.API_BASE_URL_CONFIG_ERROR, "not a valid url", "the bad value must still be reported, not silently swallowed");
});

test("a valid override reports no config error", () => {
  const location = loc({ protocol: "https:", hostname: "app.example.com", port: "" });
  const resolved = config.resolve(location, { API_BASE_URL: "https://api.example.com" });
  assert.equal(resolved.API_BASE_URL, "https://api.example.com");
  assert.equal(resolved.API_BASE_URL_CONFIG_ERROR, null);
});

test("no scenario in this file ever produces an API base targeting port 5500 or a file:// resolution", () => {
  const scenarios = [
    loc({ hostname: "127.0.0.1", port: "5500" }),
    loc({ hostname: "localhost", port: "5500" }),
    loc({ protocol: "file:", hostname: "", port: "" }),
    loc({ protocol: "capacitor:", hostname: "localhost", port: "" }),
    loc({ protocol: "https:", hostname: "localhost", port: "" }),
    loc({ protocol: "https:", hostname: "app.example.com", port: "" })
  ];
  for (const location of scenarios) {
    const base = config.computeApiBase(location);
    assert.doesNotMatch(base, /:5500/);
    assert.doesNotMatch(base, /^file:/);
  }
});
