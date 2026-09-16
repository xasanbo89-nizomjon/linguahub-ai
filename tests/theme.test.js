"use strict";

// Executes the real www/theme.js source inside a sandboxed vm context with
// a fake document/localStorage/matchMedia - no jsdom dependency.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const THEME_SRC = fs.readFileSync(path.join(__dirname, "..", "www", "theme.js"), "utf8");

function createFakeStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); }
  };
}

function createFakeMatchMedia(prefersDark) {
  const listeners = [];
  const mql = {
    matches: prefersDark,
    addEventListener: (event, cb) => listeners.push(cb),
    addListener: (cb) => listeners.push(cb)
  };
  return {
    matchMediaFn: () => mql,
    fireChange: (newMatches) => {
      mql.matches = newMatches;
      listeners.forEach((cb) => cb());
    }
  };
}

function buildSandbox({ storedTheme, prefersDark = false } = {}) {
  const attrs = {};
  const documentElement = {
    setAttribute: (name, value) => { attrs[name] = value; },
    getAttribute: (name) => attrs[name]
  };
  const media = createFakeMatchMedia(prefersDark);

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    localStorage: createFakeStorage(storedTheme ? { "linguahub-ai:theme": storedTheme } : {}),
    document: { documentElement },
    matchMedia: media.matchMediaFn
  };
  sandbox.window = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(THEME_SRC, sandbox, { filename: "theme.js" });

  return { sandbox, attrs, fireSystemChange: media.fireChange };
}

test("defaults to system mode and resolves to light when the OS prefers light", () => {
  const { sandbox, attrs } = buildSandbox({ prefersDark: false });
  assert.equal(sandbox.LinguaHubTheme.getMode(), "system");
  assert.equal(attrs["data-theme"], "light");
});

test("defaults to system mode and resolves to dark when the OS prefers dark", () => {
  const { attrs } = buildSandbox({ prefersDark: true });
  assert.equal(attrs["data-theme"], "dark");
});

test("a stored explicit preference overrides the system default on load", () => {
  const { sandbox, attrs } = buildSandbox({ storedTheme: "dark", prefersDark: false });
  assert.equal(sandbox.LinguaHubTheme.getMode(), "dark");
  assert.equal(attrs["data-theme"], "dark");
});

test("setMode('light') persists and applies immediately", () => {
  const { sandbox, attrs } = buildSandbox({ prefersDark: true });
  sandbox.LinguaHubTheme.setMode("light");
  assert.equal(attrs["data-theme"], "light");
  assert.equal(sandbox.localStorage.getItem("linguahub-ai:theme"), "light");
});

test("theme persists across a fresh load (new script execution against the same storage)", () => {
  const { sandbox } = buildSandbox({ prefersDark: false });
  sandbox.LinguaHubTheme.setMode("dark");

  // Simulate a page reload: fresh attrs/document, same localStorage.
  const attrs2 = {};
  const documentElement2 = {
    setAttribute: (name, value) => { attrs2[name] = value; },
    getAttribute: (name) => attrs2[name]
  };
  sandbox.document = { documentElement: documentElement2 };
  vm.runInContext(THEME_SRC, sandbox, { filename: "theme.js" });

  assert.equal(attrs2["data-theme"], "dark");
});

test("system mode keeps following OS changes live", () => {
  const { attrs, fireSystemChange } = buildSandbox({ prefersDark: false });
  assert.equal(attrs["data-theme"], "light");
  fireSystemChange(true);
  assert.equal(attrs["data-theme"], "dark");
});

test("an explicit user choice is NOT overridden by a later OS theme change", () => {
  const { sandbox, attrs, fireSystemChange } = buildSandbox({ prefersDark: false });
  sandbox.LinguaHubTheme.setMode("light");
  fireSystemChange(true); // OS switches to dark, but user explicitly chose light
  assert.equal(attrs["data-theme"], "light");
});

test("invalid stored value falls back to system mode instead of crashing", () => {
  const { sandbox } = buildSandbox({});
  sandbox.localStorage.setItem("linguahub-ai:theme", "not-a-real-mode");
  // Re-run against the same (now-corrupted) storage.
  const attrs2 = {};
  sandbox.document = { documentElement: { setAttribute: (n, v) => { attrs2[n] = v; }, getAttribute: (n) => attrs2[n] } };
  vm.runInContext(THEME_SRC, sandbox, { filename: "theme.js" });
  assert.equal(sandbox.LinguaHubTheme.getMode(), "system");
});

test("a broken localStorage (throws) never crashes theme resolution", () => {
  const attrs = {};
  const sandbox = {
    console, setTimeout, clearTimeout,
    localStorage: {
      getItem() { throw new Error("storage disabled"); },
      setItem() { throw new Error("storage disabled"); }
    },
    document: { documentElement: { setAttribute: (n, v) => { attrs[n] = v; }, getAttribute: (n) => attrs[n] } },
    matchMedia: () => ({ matches: false, addEventListener() {} })
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  assert.doesNotThrow(() => vm.runInContext(THEME_SRC, sandbox, { filename: "theme.js" }));
  assert.equal(attrs["data-theme"], "light");
});
