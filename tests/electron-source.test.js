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

// Phase 1 (custom title bar) deliberately replaced the earlier "no preload,
// no IPC" guards with these: the window-control IPC is the app's entire
// custom surface, and these tests pin it to exactly that.
const PRELOAD_SRC = fs.readFileSync(path.join(__dirname, "..", "preload.js"), "utf8");
const EXPECTED_CHANNELS = [
  "window:close",
  "window:is-maximized",
  "window:maximized-changed",
  "window:minimize",
  "window:toggle-maximize"
];

function channelsIn(src) {
  const found = new Set();
  (src.match(/["']window:[a-z-]+["']/g) || []).forEach((m) => found.add(m.slice(1, -1)));
  return [...found].sort();
}

test("main.js: the window uses preload.js, sandboxed, with contextIsolation on and nodeIntegration off", () => {
  assert.match(MAIN_SRC, /preload:\s*path\.join\(__dirname,\s*["']preload\.js["']\)/);
  assert.match(MAIN_SRC, /sandbox:\s*true/);
});

test("IPC surface is exactly the five window:* channels, identical in main.js and preload.js", () => {
  assert.deepEqual(channelsIn(MAIN_SRC), EXPECTED_CHANNELS);
  assert.deepEqual(channelsIn(PRELOAD_SRC), EXPECTED_CHANNELS);
  const ipcNames = (MAIN_SRC.match(/ipcMain\.(?:on|handle)\(\s*["']([^"']+)["']/g) || [])
    .map((m) => m.replace(/.*["']([^"']+)["']$/, "$1"));
  ipcNames.forEach((name) => assert.match(name, /^window:/, `unexpected IPC channel: ${name}`));
  assert.equal(ipcNames.length, 4, "four invokable channels (the fifth is main -> renderer only)");
});

test("main.js: every IPC handler authenticates its sender through windowForTrustedSender", () => {
  const handlerBodies = MAIN_SRC.split(/ipcMain\.(?:on|handle)\(/).slice(1);
  assert.equal(handlerBodies.length, 4);
  handlerBodies.forEach((body) => {
    const handler = body.split(/\n\}\);/)[0];
    assert.match(handler, /windowForTrustedSender\(event\)/);
  });
  assert.match(MAIN_SRC, /isTrustedSenderUrl\(frameUrl,\s*indexFileUrl\)/);
});

test("preload.js: only a frozen window.linguahubDesktop is exposed; raw ipcRenderer/Node never reach the page", () => {
  assert.match(PRELOAD_SRC, /contextBridge\.exposeInMainWorld\(\s*["']linguahubDesktop["']\s*,\s*Object\.freeze\(/);
  assert.equal((PRELOAD_SRC.match(/exposeInMainWorld/g) || []).length, 1);
  assert.doesNotMatch(PRELOAD_SRC, /exposeInMainWorld\([^)]*,\s*ipcRenderer/);
  assert.doesNotMatch(PRELOAD_SRC, /require\(["'](?!electron["'])/, "a sandboxed preload may only require electron");
  assert.doesNotMatch(PRELOAD_SRC, /child_process|\bfs\b|ipcRenderer\.sendSync/);
});

test("main.js: the Google auth popup gets a normal frame and no preload (it inherits frameless options otherwise)", () => {
  assert.match(MAIN_SRC, /overrideBrowserWindowOptions/);
  assert.match(MAIN_SRC, /frame:\s*true/);
  assert.match(MAIN_SRC, /preload:\s*undefined/);
});

test("main.js: window is frameless (Windows/Linux) or hiddenInset (macOS) and the menu bar is hidden", () => {
  assert.match(MAIN_SRC, /frame:\s*false/);
  assert.match(MAIN_SRC, /titleBarStyle:\s*"hiddenInset"/);
  assert.match(MAIN_SRC, /setMenuBarVisibility\(false\)/);
});

test("main.js: the installed menu is role-based (editing shortcuts still work) and DevTools/reload are dev-only", () => {
  assert.match(MAIN_SRC, /role:\s*"editMenu"/);
  const devBlock = MAIN_SRC.slice(MAIN_SRC.indexOf("if (!app.isPackaged)"));
  assert.match(devBlock.split("}\n  return")[0], /toggleDevTools/);
  assert.equal((MAIN_SRC.match(/toggleDevTools/g) || []).length, 1, "DevTools must appear only inside the !app.isPackaged block");
});

test("isTrustedSenderUrl accepts only the app's own page (query/hash ignored)", () => {
  const { isTrustedSenderUrl } = require("../lib/electronSecurity.js");
  const index = "file:///C:/app/www/index.html";
  assert.equal(isTrustedSenderUrl(index, index), true);
  assert.equal(isTrustedSenderUrl(index + "#chat", index), true);
  assert.equal(isTrustedSenderUrl(index + "?x=1", index), true);
  assert.equal(isTrustedSenderUrl("https://accounts.google.com/o/oauth2/auth", index), false);
  assert.equal(isTrustedSenderUrl("file:///C:/app/www/other.html", index), false);
  assert.equal(isTrustedSenderUrl("file:///C:/app/www/index.html.evil", index), false);
  assert.equal(isTrustedSenderUrl(undefined, index), false);
  assert.equal(isTrustedSenderUrl(index, ""), false);
  assert.equal(isTrustedSenderUrl(null, null), false);
});

test("main.js: no child_process / shell execution capability exists", () => {
  assert.doesNotMatch(MAIN_SRC, /require\(["']child_process["']\)|execSync|spawnSync|\.exec\(/);
});

test("main.js: window.open() popups are gated by the shared allowlist function, not unconditionally allowed", () => {
  assert.match(MAIN_SRC, /setWindowOpenHandler/);
  // Early-deny shape (Phase 1): untrusted URLs return deny before the allow
  // branch is ever reached.
  assert.match(MAIN_SRC, /if\s*\(!isTrustedGoogleAuthUrl\(url\)\)\s*return\s*\{\s*action:\s*["']deny["']\s*\}/);
  assert.match(MAIN_SRC, /action:\s*["']allow["']/);
  assert.ok(
    MAIN_SRC.indexOf('action: "deny"') < MAIN_SRC.indexOf('action: "allow"'),
    "the deny check must come before the allow return"
  );
});

test("main.js: top-level navigation is restricted via will-navigate (Phase 8 fix)", () => {
  assert.match(MAIN_SRC, /will-navigate/);
  assert.match(MAIN_SRC, /event\.preventDefault\(\)/);
});

test("main.js: loads the app via a real local file path, not a hardcoded/remote URL", () => {
  assert.match(MAIN_SRC, /win\.loadFile\(path\.join\(__dirname,\s*["']www["'],\s*["']index\.html["']\)\)/);
  assert.doesNotMatch(MAIN_SRC, /loadURL\(\s*["']https?:\/\//);
});
