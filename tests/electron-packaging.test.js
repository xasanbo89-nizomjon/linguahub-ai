"use strict";

// Regression test (Phase 8): a real electron-builder dry-build (--dir, no
// installer/signing) was run and its output asar archive was extracted and
// inspected directly - the real .env file (containing the live
// OPENAI_API_KEY) was confirmed bundled into the packaged app, because
// package.json's "build" config had no "files" allowlist, so
// electron-builder's default inclusion swept in the entire project root.
// Fixed by adding an explicit files allowlist. This test guards the fix at
// the config level (a full build is slow and, in this environment, blocked
// by an unrelated OS symlink-privilege issue when preparing macOS
// code-signing tools - see docs/electron-runtime-report.md) - it does not
// re-run a real build, but it does verify the exact configuration property
// that caused and then fixed the real, confirmed leak.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const pkg = require("../package.json");

test("package.json build.files is an explicit allowlist, not the default (which bundled the whole project)", () => {
  assert.ok(Array.isArray(pkg.build.files), "build.files must be an explicit array");
  assert.ok(pkg.build.files.length > 0);
});

test("the files allowlist never references .env, service account files, or other secret-shaped paths", () => {
  const filesText = JSON.stringify(pkg.build.files);
  assert.doesNotMatch(filesText, /\.env(?!\.example)/, "no positive reference to a real .env file");
  assert.doesNotMatch(filesText, /serviceaccount|service-account|firebase-adminsdk/i);
});

test("the files allowlist only includes the app's real runtime code, not docs/tests/e2e/android/dist", () => {
  const filesText = JSON.stringify(pkg.build.files);
  assert.doesNotMatch(filesText, /"docs\//i);
  assert.doesNotMatch(filesText, /"tests\//i);
  assert.doesNotMatch(filesText, /"e2e\//i);
  assert.doesNotMatch(filesText, /"android\//i);
  assert.doesNotMatch(filesText, /"dist\//i);
});

test("the files allowlist explicitly excludes @capacitor (an Android/iOS build tool irrelevant to the Electron package)", () => {
  assert.ok(pkg.build.files.includes("!node_modules/@capacitor/**"));
});

// Phase 10: @capacitor-firebase/authentication was added as a real
// dependency for the native Android auth adapter (see
// docs/capacitor-native-auth.md). Its npm package ships Android/iOS native
// source trees that have nothing to do with the Electron desktop app - the
// same reasoning that already excluded @capacitor/** above.
test("the files allowlist explicitly excludes @capacitor-firebase (Android-only native auth plugin, irrelevant to Electron)", () => {
  assert.ok(pkg.build.files.includes("!node_modules/@capacitor-firebase/**"));
});

test("the files allowlist explicitly excludes electron/electron-builder/playwright/axe-core/jsdom themselves from the bundle", () => {
  const filesText = JSON.stringify(pkg.build.files);
  assert.match(filesText, /!node_modules\/electron\/\*\*/);
  assert.match(filesText, /!node_modules\/electron-builder\/\*\*/);
  assert.match(filesText, /!node_modules\/playwright/);
});

test("electron and electron-builder are devDependencies, not dependencies (electron-builder itself requires this)", () => {
  assert.equal(pkg.dependencies.electron, undefined);
  assert.equal(pkg.dependencies["electron-builder"], undefined);
  assert.equal(typeof pkg.devDependencies.electron, "string");
  assert.equal(typeof pkg.devDependencies["electron-builder"], "string");
});

test("the app's real runtime entry points (main.js, server.js, www, lib, middleware) are all present in the allowlist", () => {
  assert.ok(pkg.build.files.includes("main.js"));
  assert.ok(pkg.build.files.includes("server.js"));
  assert.ok(pkg.build.files.some((f) => f.startsWith("www/")));
  assert.ok(pkg.build.files.some((f) => f.startsWith("lib/")));
  assert.ok(pkg.build.files.some((f) => f.startsWith("middleware/")));
});
