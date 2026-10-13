"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const { BACKGROUND, THEME_MODES, isThemeMode, readThemePref, writeThemePref, backgroundFor } = require("../lib/themePref.js");

const THEME_CSS = fs.readFileSync(path.join(__dirname, "..", "www", "theme.css"), "utf8");
const THEME_SRC = fs.readFileSync(path.join(__dirname, "..", "www", "theme.js"), "utf8");
const MAIN_SRC = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lh-theme-")), "theme.json");
}

test("themePref: window backgrounds equal --bg of each palette in theme.css", () => {
  const light = THEME_CSS.split(':root[data-theme="light"]')[1].split("}")[0];
  const dark = THEME_CSS.split(':root[data-theme="dark"]')[1].split("}")[0];
  assert.match(light, new RegExp("--bg:\\s*" + BACKGROUND.light, "i"));
  assert.match(dark, new RegExp("--bg:\\s*" + BACKGROUND.dark, "i"));
  assert.equal(backgroundFor(true), BACKGROUND.dark);
  assert.equal(backgroundFor(false), BACKGROUND.light);
});

test("themePref: only system/light/dark are valid modes", () => {
  assert.deepEqual(THEME_MODES, ["system", "light", "dark"]);
  THEME_MODES.forEach((m) => assert.equal(isThemeMode(m), true));
  ["", "Dark", "auto", null, undefined, 1, {}].forEach((m) => assert.equal(isThemeMode(m), false));
});

test("themePref: write then read round-trips every mode", () => {
  const file = tmpFile();
  THEME_MODES.forEach((m) => {
    assert.equal(writeThemePref(file, m), true);
    assert.equal(readThemePref(file), m);
  });
});

test("themePref: missing, corrupt or tampered files fall back to system and never throw", () => {
  const file = tmpFile();
  assert.equal(readThemePref(file), "system");
  fs.writeFileSync(file, "{not json");
  assert.equal(readThemePref(file), "system");
  fs.writeFileSync(file, JSON.stringify({ mode: "neon" }));
  assert.equal(readThemePref(file), "system");
  fs.writeFileSync(file, "null");
  assert.equal(readThemePref(file), "system");
});

test("themePref: an invalid mode is never written; an unwritable path returns false", () => {
  const file = tmpFile();
  assert.equal(writeThemePref(file, "neon"), false);
  assert.equal(fs.existsSync(file), false);
  assert.equal(writeThemePref(path.join(file, "nope", "x.json"), "dark"), false);
});

test("main.js: restores the theme before creating the window and mirrors changes", () => {
  assert.match(MAIN_SRC, /nativeTheme\.themeSource\s*=\s*readThemePref\(themeFile\)/);
  assert.ok(MAIN_SRC.indexOf("readThemePref(themeFile)") < MAIN_SRC.lastIndexOf("createWindow();"));
  assert.match(MAIN_SRC, /backgroundColor:\s*windowBackground\(\)/);
  assert.match(MAIN_SRC, /ipcMain\.on\("window:set-theme"[\s\S]*?isThemeMode\(mode\)[\s\S]*?writeThemePref\(themeFile,\s*mode\)/);
});

function runTheme({ api, stored, prefersDark }) {
  const attrs = {};
  const window = {
    localStorage: { getItem: () => (stored === undefined ? null : stored), setItem: () => {} },
    matchMedia: () => ({ matches: Boolean(prefersDark), addEventListener() {} }),
    linguahubDesktop: api
  };
  const document = { documentElement: { setAttribute: (k, v) => { attrs[k] = v; } } };
  window.document = document;
  const ctx = vm.createContext({ window, document });
  vm.runInContext(THEME_SRC + "\nthis.__T = LinguaHubTheme;", ctx);
  return { attrs, theme: ctx.__T };
}

test("theme.js: reports the active mode to the desktop shell at startup and on every change", () => {
  const sent = [];
  const { theme } = runTheme({ api: { setTheme: (m) => sent.push(m) }, stored: "dark" });
  assert.deepEqual(sent, ["dark"]);
  theme.setMode("light");
  theme.setMode("system");
  assert.deepEqual(sent, ["dark", "light", "system"]);
});

test("theme.js: system mode resolves via prefers-color-scheme and is reported as 'system'", () => {
  const sent = [];
  const { attrs } = runTheme({ api: { setTheme: (m) => sent.push(m) }, prefersDark: true });
  assert.equal(attrs["data-theme"], "dark");
  assert.deepEqual(sent, ["system"]);
});

test("theme.js: works with no desktop API (browser/Android) and survives a throwing one", () => {
  assert.equal(runTheme({ api: undefined, stored: "light" }).attrs["data-theme"], "light");
  assert.equal(runTheme({ api: { setTheme() { throw new Error("boom"); } }, stored: "dark" }).attrs["data-theme"], "dark");
});

test("index.html declares color-scheme and theme.css sets it per palette (native controls follow the theme)", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "www", "index.html"), "utf8");
  assert.match(html, /<meta name="color-scheme" content="light dark">/);
  assert.match(THEME_CSS.split(':root[data-theme="light"]')[1].split("}")[0], /color-scheme:\s*light/);
  assert.match(THEME_CSS.split(':root[data-theme="dark"]')[1].split("}")[0], /color-scheme:\s*dark/);
});
