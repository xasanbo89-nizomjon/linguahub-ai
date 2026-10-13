"use strict";

// Source-level guards for the Phase 1 header cleanup (see git log
// "phase1: header cleanup"). Behavior was verified in a real Electron run.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (f) => fs.readFileSync(path.join(__dirname, "..", "www", f), "utf8");
const INDEX_HTML = read("index.html");
const STYLES_CSS = read("styles.css");
const APP_JS = read("app.js");
const header = INDEX_HTML.slice(INDEX_HTML.indexOf('<div class="header">'), INDEX_HTML.indexOf('<div id="auth-status"'));

test("header keeps only: sidebar toggle, chat title, status, mode selector and the chat menu", () => {
  assert.match(header, /id="conversation-title"/);
  assert.match(header, /id="mode-select"/);
  assert.match(header, /id="chat-menu-btn"/);
  assert.match(header, /id="sidebar-toggle-btn"/);
});

test("header no longer has the WOW toggle, diamond, refresh icon, guest avatar, context chip or LH mark", () => {
  assert.doesNotMatch(header, /wow-mode-btn|WOW MODE/);
  assert.doesNotMatch(header, /header-account|No active context|context-chip/);
  assert.doesNotMatch(header, /class="lh-mark/);
  assert.doesNotMatch(header, /◈|⟲|✨/);
  assert.doesNotMatch(INDEX_HTML, /id="wow-mode-btn"|id="header-account-btn"|id="context-chip"/);
});

test("Clear chat and Tutor dashboard moved into the chat menu and kept their IDs (handlers untouched)", () => {
  const menu = header.slice(header.indexOf('id="chat-menu-list"'));
  assert.match(menu, /id="tutor-dashboard-btn"/);
  assert.match(menu, /id="clear-chat-btn"/);
  assert.match(INDEX_HTML, /<script src="chat-menu\.js"><\/script>/);
});

test("WOW Effects is still a Settings toggle", () => {
  assert.match(read("settings-ui.js"), /settings-wow-effects/);
});

test("online status is hidden; only offline (and busy) show - driven by navigator.onLine events", () => {
  assert.match(STYLES_CSS, /\.status-bar\[data-state="online"\]\s*\{\s*display:\s*none/);
  assert.match(APP_JS, /navigator\.onLine === false/);
  assert.match(APP_JS, /addEventListener\("offline", renderStatus\)/);
  assert.match(APP_JS, /addEventListener\("online", renderStatus\)/);
});

test("app.js has no leftover header-account wiring", () => {
  assert.doesNotMatch(APP_JS, /headerAccount/);
});

test("embedded mode hides the whole mode picker, not just the select", () => {
  assert.match(STYLES_CSS, /\[data-app-mode="embedded"\][^{]*\.mode-picker/);
});
