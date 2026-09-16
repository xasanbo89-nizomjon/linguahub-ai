"use strict";

// Integration Prep phase - source-level checks against the shipped HTML/CSS/
// JS for requirements that are cross-cutting (span index.html + styles.css +
// multiple .js files) rather than owned by one module's own test file. Real
// module behavior (app-mode resolution, context validation, the auth
// adapter, embedded-mode UI hiding) is covered in its own dedicated test
// file (tests/app-mode.test.js, tests/context-adapter.test.js,
// tests/frontend-auth.test.js, tests/settings-ui.test.js,
// tests/history-ui.test.js) - these are NOT a substitute for that, or for
// real browser verification.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const INDEX_HTML = fs.readFileSync(path.join(__dirname, "..", "www", "index.html"), "utf8");
const STYLES_CSS = fs.readFileSync(path.join(__dirname, "..", "www", "styles.css"), "utf8");
const APP_JS = fs.readFileSync(path.join(__dirname, "..", "www", "app.js"), "utf8");
const STRINGS_JS = fs.readFileSync(path.join(__dirname, "..", "www", "strings.js"), "utf8");

test("the old visible keyboard-shortcut hint text is gone from index.html", () => {
  assert.doesNotMatch(INDEX_HTML, /Enter to send.*Shift\+Enter for a new line/);
});

test("the composer hint element exists, has an id, and is no longer aria-hidden (a disclaimer should reach assistive tech)", () => {
  assert.match(INDEX_HTML, /<div class="composer-hint" id="composer-hint"><\/div>/);
  assert.doesNotMatch(INDEX_HTML, /class="composer-hint" aria-hidden/);
});

test("the composer disclaimer copy is centralized in www/strings.js, not hardcoded in index.html or app.js", () => {
  assert.match(STRINGS_JS, /LinguaHub AI can make mistakes\. Verify important information\./);
  assert.doesNotMatch(INDEX_HTML, /LinguaHub AI can make mistakes/, "must not be hardcoded a second time in the HTML");
  assert.doesNotMatch(APP_JS, /LinguaHub AI can make mistakes/, "must not be hardcoded a second time in app.js - app.js only reads window.LinguaHubStrings");
});

test("app.js populates the composer hint from the centralized strings module, not a literal string", () => {
  assert.match(APP_JS, /composerHintEl\.textContent = window\.LinguaHubStrings\.composerDisclaimer/);
});

test("app-mode.js is loaded in <head>, immediately after theme.js, before any stylesheet (same before-first-paint reasoning)", () => {
  const headMatch = INDEX_HTML.match(/<head>([\s\S]*?)<\/head>/);
  assert.ok(headMatch, "index.html must have a <head>");
  const head = headMatch[1];
  const themeIdx = head.indexOf('<script src="theme.js">');
  const appModeIdx = head.indexOf('<script src="app-mode.js">');
  const firstStylesheetIdx = head.indexOf('<link rel="stylesheet"');
  assert.ok(themeIdx !== -1 && appModeIdx !== -1, "both theme.js and app-mode.js scripts must be present in <head>");
  assert.ok(themeIdx < appModeIdx, "app-mode.js must load after theme.js");
  assert.ok(appModeIdx < firstStylesheetIdx, "app-mode.js must load before any stylesheet - same reasoning as theme.js");
});

test("strings.js and context-adapter.js are loaded before app.js (app.js consumes both)", () => {
  const stringsIdx = INDEX_HTML.indexOf('<script src="strings.js">');
  const contextAdapterIdx = INDEX_HTML.indexOf('<script src="context-adapter.js">');
  const appJsIdx = INDEX_HTML.indexOf('<script src="app.js">');
  assert.ok(stringsIdx !== -1 && contextAdapterIdx !== -1 && appJsIdx !== -1);
  assert.ok(stringsIdx < appJsIdx);
  assert.ok(contextAdapterIdx < appJsIdx);
});

test("embedded-mode CSS rules exist for account UI and the mode selector, gated on [data-app-mode=\"embedded\"]", () => {
  assert.match(STYLES_CSS, /\[data-app-mode="embedded"\][^{]*#auth-area/);
  assert.match(STYLES_CSS, /\[data-app-mode="embedded"\][^{]*#auth-status/, "the separate #auth-status feedback line (e.g. 'Sign-in is unavailable') must also be hidden, not just #auth-area");
  assert.match(STYLES_CSS, /\[data-app-mode="embedded"\][^{]*#mode-select/);
});

test("embedded mode keeps only controls that the app still exposes in the DOM", () => {
  // www/app.js has unconditional top-level #login-btn/#logout-btn
  // .addEventListener() calls - the elements they target must always be
  // present in index.html regardless of app mode.
  assert.match(INDEX_HTML, /id="login-btn"/);
  assert.match(INDEX_HTML, /id="logout-btn"/);
  assert.doesNotMatch(INDEX_HTML, /id="export-chat-btn"/);
  assert.doesNotMatch(INDEX_HTML, /id="import-label-btn"/);
  assert.match(INDEX_HTML, /id="mode-select"/);
});

test("no inline style attributes were introduced by this phase (CSP unchanged - no inline <script> check duplicated here, see tests/styles-source.test.js)", () => {
  assert.doesNotMatch(INDEX_HTML, /style="/);
});

test("app-mode.js, strings.js, and context-adapter.js are all same-origin local files, not a CDN/remote script", () => {
  assert.match(INDEX_HTML, /<script src="app-mode\.js"><\/script>/);
  assert.match(INDEX_HTML, /<script src="strings\.js"><\/script>/);
  assert.match(INDEX_HTML, /<script src="context-adapter\.js"><\/script>/);
});
