"use strict";

// Runs the real www/titlebar.js in a vm sandbox with a tiny fake DOM and a
// fake window.linguahubDesktop (what preload.js exposes), plus source-level
// checks that the markup/CSS keep the title bar Electron-only.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const WWW = path.join(__dirname, "..", "www");
const TITLEBAR_SRC = fs.readFileSync(path.join(WWW, "titlebar.js"), "utf8");
const INDEX_HTML = fs.readFileSync(path.join(WWW, "index.html"), "utf8");
const STYLES_CSS = fs.readFileSync(path.join(WWW, "styles.css"), "utf8");
const THEME_CSS = fs.readFileSync(path.join(WWW, "theme.css"), "utf8");

function makeEl(attrs) {
  const a = Object.assign({}, attrs);
  const listeners = {};
  const el = {
    attrs: a,
    getAttribute: (k) => (k in a ? a[k] : null),
    setAttribute: (k, v) => { a[k] = String(v); },
    removeAttribute: (k) => { delete a[k]; },
    hasAttribute: (k) => k in a,
    addEventListener: (type, cb) => { (listeners[type] = listeners[type] || []).push(cb); },
    contains: (other) => el.children.includes(other) || other === el,
    children: [],
    fire: (type, event) => (listeners[type] || []).forEach((cb) => cb(event))
  };
  return el;
}

function build({ withApi = true, maximized = false } = {}) {
  const root = makeEl({});
  const bar = makeEl({});
  const buttons = {
    minimize: makeEl({ "data-titlebar-action": "minimize" }),
    "toggle-maximize": makeEl({ "data-titlebar-action": "toggle-maximize" }),
    close: makeEl({ "data-titlebar-action": "close" })
  };
  buttons["toggle-maximize"].attrs["aria-label"] = "Maximize";
  bar.children = Object.values(buttons);
  Object.values(buttons).forEach((b) => { b.closest = (sel) => (sel === "[data-titlebar-action]" ? b : null); });

  const calls = [];
  let maxListener = null;
  const api = {
    platform: "win32",
    minimize: () => calls.push("minimize"),
    toggleMaximize: () => calls.push("toggleMaximize"),
    close: () => calls.push("close"),
    isMaximized: () => Promise.resolve(maximized),
    onMaximizeChange: (cb) => { maxListener = cb; return () => {}; }
  };
  const byId = { titlebar: bar, "titlebar-maximize-btn": buttons["toggle-maximize"] };
  const document = {
    readyState: "complete",
    documentElement: root,
    getElementById: (id) => byId[id] || null,
    addEventListener: () => {}
  };
  const window = withApi ? { linguahubDesktop: api } : {};
  window.document = document;
  vm.runInNewContext(TITLEBAR_SRC, { window, document });
  return { root, bar, buttons, calls, fireMaximize: (v) => maxListener(v), maxListener: () => maxListener };
}

test("titlebar.js: without window.linguahubDesktop (browser / Android) it does nothing at all", () => {
  const { root } = build({ withApi: false });
  assert.equal(root.hasAttribute("data-desktop"), false);
});

test("titlebar.js: inside Electron it marks <html data-desktop=platform> synchronously", () => {
  const { root } = build();
  assert.equal(root.getAttribute("data-desktop"), "win32");
});

test("titlebar.js: each button calls exactly its own API method", () => {
  const { bar, buttons, calls } = build();
  ["minimize", "toggle-maximize", "close"].forEach((name) => {
    bar.fire("click", { target: buttons[name] });
  });
  assert.deepEqual(calls, ["minimize", "toggleMaximize", "close"]);
});

test("titlebar.js: clicking the empty drag area does nothing", () => {
  const { bar, calls } = build();
  bar.fire("click", { target: { closest: () => null } });
  assert.deepEqual(calls, []);
});

test("titlebar.js: maximize state drives data-maximized and the toggle button's label", async () => {
  const { root, buttons, fireMaximize } = build({ maximized: true });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(root.hasAttribute("data-maximized"), true);
  assert.equal(buttons["toggle-maximize"].getAttribute("aria-label"), "Restore");
  fireMaximize(false);
  assert.equal(root.hasAttribute("data-maximized"), false);
  assert.equal(buttons["toggle-maximize"].getAttribute("aria-label"), "Maximize");
  fireMaximize(true);
  assert.equal(buttons["toggle-maximize"].getAttribute("title"), "Restore");
});

test("index.html: titlebar.js loads right after theme.js and before every stylesheet, blocking", () => {
  const t = INDEX_HTML.indexOf('<script src="titlebar.js">');
  assert.ok(t > INDEX_HTML.indexOf('<script src="theme.js">'));
  assert.ok(t < INDEX_HTML.indexOf('<link rel="stylesheet"'));
  const tag = INDEX_HTML.slice(t, INDEX_HTML.indexOf(">", t) + 1);
  assert.doesNotMatch(tag, /defer|async|type="module"/);
});

test("index.html: the title bar has minimize / maximize / close buttons with accessible names", () => {
  const bar = INDEX_HTML.slice(INDEX_HTML.indexOf('id="titlebar"'), INDEX_HTML.indexOf('id="sidebar-backdrop"'));
  assert.match(bar, /data-titlebar-action="minimize"[^>]*aria-label="Minimize"/);
  assert.match(bar, /data-titlebar-action="toggle-maximize"[^>]*aria-label="Maximize"/);
  assert.match(bar, /data-titlebar-action="close"[^>]*aria-label="Close"/);
  assert.match(bar, /LinguaHub/);
});

test("styles: the title bar is display:none unless data-desktop is set, is a drag region, and buttons are no-drag", () => {
  assert.match(STYLES_CSS, /\.titlebar\{\s*display:\s*none;/);
  const shown = STYLES_CSS.split("html[data-desktop] .titlebar{")[1].split("}")[0];
  assert.match(shown, /-webkit-app-region:\s*drag/);
  assert.match(shown, /z-index:\s*var\(--z-titlebar\)/);
  assert.match(STYLES_CSS.split(".titlebar-btn{")[1].split("}")[0], /-webkit-app-region:\s*no-drag/);
  assert.match(STYLES_CSS.split(".titlebar-controls{")[1].split("}")[0], /-webkit-app-region:\s*no-drag/);
});

test("styles: the close button hovers red; the title bar uses theme tokens only (follows light/dark)", () => {
  assert.match(STYLES_CSS, /\.titlebar-btn-close:hover:not\(:disabled\)[^{]*\{\s*background:\s*var\(--titlebar-close-hover\)/);
  assert.match(THEME_CSS, /--titlebar-close-hover:\s*#E81123/i);
  const titlebarCss = STYLES_CSS.slice(STYLES_CSS.indexOf("Desktop title bar"), STYLES_CSS.indexOf("---- Sidebar ----"));
  assert.match(titlebarCss, /background:\s*var\(--surface-2\)/);
  assert.doesNotMatch(titlebarCss, /#[0-9a-fA-F]{3,8}\b|rgba?\(/);
});

test("theme: the title-bar height is 0 by default and 40px only under :root[data-desktop]", () => {
  assert.match(THEME_CSS, /--titlebar-height:\s*0px/);
  assert.match(THEME_CSS, /:root\[data-desktop\]\{\s*--titlebar-height:\s*40px/);
  assert.match(THEME_CSS, /--z-titlebar:\s*60/);
});

test("styles: the app shell, mobile drawer and backdrop all reserve --titlebar-height", () => {
  assert.equal((STYLES_CSS.match(/calc\(100vh - var\(--titlebar-height\)\)/g) || []).length, 2);
  assert.match(STYLES_CSS, /\.sidebar\{[^}]*top:\s*var\(--titlebar-height\)/);
  assert.match(STYLES_CSS, /\.lh-drawer-backdrop\{[^}]*inset:\s*var\(--titlebar-height\)/);
});

test("package.json: preload.js is part of the packaged app's files allowlist", () => {
  const pkg = require("../package.json");
  assert.ok(pkg.build.files.includes("preload.js"));
});
