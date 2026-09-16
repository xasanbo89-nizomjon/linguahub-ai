"use strict";

// Electron source-level safety checks. main.js itself cannot be required
// directly in this test environment - it calls app.whenReady() at load
// time, which throws immediately unless run by a real Electron main
// process (require("electron") returns a path string, not the API, under
// plain Node - including in this project's own sandboxed test environment,
// which sets ELECTRON_RUN_AS_NODE=1). See docs/electron-runtime-report.md
// for the real-runtime-launch attempt and its exact blocker.
//
// The pure allowlist logic (Phase 8's will-navigate/setWindowOpenHandler
// fix) is tested directly via lib/electronSecurity.js, which main.js
// imports and which has no Electron dependency at all. Everything else
// here is a structural source check against the real main.js text.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { isTrustedGoogleAuthUrl } = require("../lib/electronSecurity.js");
const MAIN_SRC = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");

test("isTrustedGoogleAuthUrl allows the exact Google accounts domain", () => {
  assert.equal(isTrustedGoogleAuthUrl("https://accounts.google.com/o/oauth2/auth"), true);
});

test("isTrustedGoogleAuthUrl allows any *.firebaseapp.com subdomain", () => {
  assert.equal(isTrustedGoogleAuthUrl("https://my-project.firebaseapp.com/__/auth/handler"), true);
});

test("isTrustedGoogleAuthUrl rejects a lookalike domain (prefix/suffix trick)", () => {
  assert.equal(isTrustedGoogleAuthUrl("https://accounts.google.com.evil.com/"), false);
  assert.equal(isTrustedGoogleAuthUrl("https://evil.com/accounts.google.com/"), false);
  assert.equal(isTrustedGoogleAuthUrl("https://notfirebaseapp.com/"), false);
  assert.equal(isTrustedGoogleAuthUrl("http://accounts.google.com/"), false, "must require https, not http");
});

test("isTrustedGoogleAuthUrl rejects a completely unrelated origin", () => {
  assert.equal(isTrustedGoogleAuthUrl("https://example.com/"), false);
  assert.equal(isTrustedGoogleAuthUrl("javascript:alert(1)"), false);
  assert.equal(isTrustedGoogleAuthUrl(""), false);
  assert.equal(isTrustedGoogleAuthUrl(null), false);
  assert.equal(isTrustedGoogleAuthUrl(undefined), false);
});

test("main.js: contextIsolation is enabled and nodeIntegration is disabled", () => {
  assert.match(MAIN_SRC, /contextIsolation:\s*true/);
  assert.match(MAIN_SRC, /nodeIntegration:\s*false/);
});

test("main.js: no preload script is used (none is needed - no custom IPC surface exists)", () => {
  assert.doesNotMatch(MAIN_SRC, /preload\s*:/);
});

test("main.js: no ipcMain/ipcRenderer usage exists (no IPC attack surface)", () => {
  assert.doesNotMatch(MAIN_SRC, /ipcMain|ipcRenderer/);
});

test("main.js: no child_process / shell execution capability exists", () => {
  assert.doesNotMatch(MAIN_SRC, /require\(["']child_process["']\)|execSync|spawnSync|\.exec\(/);
});

test("main.js: window.open() popups are gated by the shared allowlist function, not unconditionally allowed", () => {
  assert.match(MAIN_SRC, /setWindowOpenHandler/);
  assert.match(MAIN_SRC, /isTrustedGoogleAuthUrl\(url\)\s*\?\s*\{\s*action:\s*["']allow["']/);
  assert.match(MAIN_SRC, /action:\s*["']deny["']/, "must have a real deny path, not allow-all");
});

test("main.js: top-level navigation is restricted via will-navigate (Phase 8 fix)", () => {
  assert.match(MAIN_SRC, /will-navigate/);
  assert.match(MAIN_SRC, /event\.preventDefault\(\)/);
});

test("main.js: loads the app via a real local file path, not a hardcoded/remote URL", () => {
  assert.match(MAIN_SRC, /win\.loadFile\(path\.join\(__dirname,\s*["']www["'],\s*["']index\.html["']\)\)/);
  assert.doesNotMatch(MAIN_SRC, /loadURL\(\s*["']https?:\/\//);
});
