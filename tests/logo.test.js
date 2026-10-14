"use strict";

// Phase 5, step 1: the logo (bubble with A / Я / ع), where it is used, and the generated icons.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const Logo = require("../www/logo.js");
const Icons = require("../scripts/build-icons.js");

const root = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");

test("the three copies of the logo geometry agree: logo.js, logo.svg and the static markup in index.html", () => {
  const svg = read("www", "logo.svg");
  const html = read("www", "index.html");
  assert.ok(svg.includes('d="' + Logo.BUBBLE + '"'), "bubble path");
  Logo.GLYPHS.forEach((d) => assert.ok(svg.includes(d), "svg has glyph " + d));
  assert.ok(html.includes(Logo.markup("lh-logo lh-logo-sm")), "index.html: small logo (title bar / sidebar)");
  assert.ok(html.includes(Logo.markup("lh-logo lh-logo-lg empty-state-icon")), "index.html: home logo");
});

test("the logo draws a speech bubble with a Latin, a Cyrillic and an Arabic letter", () => {
  assert.equal(Logo.GLYPHS.length, 3, "three scripts");
  assert.match(Logo.BUBBLE, /^M[\d. ]+H[\d. ]+A/, "starts as a rounded rectangle");
  assert.match(Logo.BUBBLE, /L34 116/, "with a tail");
});

test("markup(): classes, accessibility (decorative) and no stray HTML", () => {
  const html = Logo.markup("lh-logo lh-logo-md");
  assert.match(html, /^<svg class="lh-logo lh-logo-md" viewBox="0 0 128 128" aria-hidden="true" focusable="false">/);
  assert.equal((html.match(/<path/g) || []).length, 4);
  assert.match(html, /class="lh-logo-bubble"/);
  assert.match(html, /class="lh-logo-glyphs"/);
  assert.match(Logo.markup(), /^<svg class="lh-logo"/);
});

test("create(): builds the same structure as DOM nodes", () => {
  const made = [];
  const el = (tag) => { const n = { tag, attrs: {}, children: [], setAttribute(k, v) { n.attrs[k] = v; }, appendChild(c) { n.children.push(c); return c; } }; made.push(n); return n; };
  const sandbox = { document: { createElementNS: (ns, tag) => { assert.equal(ns, "http://www.w3.org/2000/svg"); return el(tag); } }, window: {} };
  vm.createContext(sandbox);
  vm.runInContext(read("www", "logo.js"), sandbox);
  const svg = sandbox.window.LinguaHubLogo.create("lh-logo lh-logo-sm");
  assert.equal(svg.tag, "svg");
  assert.equal(svg.attrs.class, "lh-logo lh-logo-sm");
  assert.equal(svg.attrs["aria-hidden"], "true");
  assert.equal(svg.children[0].attrs.class, "lh-logo-bubble");
  assert.equal(svg.children[1].children.length, 3);
});

test("the old 'LH' square is gone everywhere: title bar, sidebar, home, message avatars, dashboard", () => {
  const html = read("www", "index.html");
  assert.doesNotMatch(html, />LH</);
  assert.doesNotMatch(html, /lh-mark/);
  ["app.js", "tutor-dashboard.js", "styles.css"].forEach((f) => assert.doesNotMatch(read("www", f), /lh-mark|"LH"/, f));
  assert.match(read("www", "app.js"), /LinguaHubLogo\.create\("lh-logo lh-logo-sm"\)/);
  assert.match(read("www", "tutor-dashboard.js"), /LinguaHubLogo\.markup\("lh-logo lh-logo-md"\)/);
  const titlebar = html.slice(html.indexOf('class="titlebar-brand"'), html.indexOf('class="titlebar-controls"'));
  assert.match(titlebar, /class="lh-logo lh-logo-sm"/);
  const sidebar = html.slice(html.indexOf('class="sidebar-brand"'), html.indexOf('id="sidebar-collapse-btn"'));
  assert.match(sidebar, /class="lh-logo lh-logo-sm"/);
});

test("theme: the logo takes its colours from tokens (accent bubble, on-accent letters), not hard-coded values", () => {
  const css = read("www", "styles.css");
  assert.match(css, /\.lh-logo-bubble\{\s*fill: var\(--accent\);/);
  assert.match(css, /\.lh-logo-glyphs\{[^}]*stroke: var\(--on-accent\);/);
  assert.match(css, /html\[data-desktop\] \.sidebar-brand \.lh-logo,/);
});

test("scripts: logo.js loads before app.js; favicon links point at real files", () => {
  const html = read("www", "index.html");
  assert.ok(html.indexOf('<script src="logo.js"></script>') > -1);
  assert.ok(html.indexOf('<script src="logo.js"></script>') < html.indexOf('<script src="app.js"></script>'));
  assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="logo\.svg">/);
  assert.match(html, /<link rel="icon" type="image\/png" sizes="32x32" href="icon-32\.png">/);
  assert.match(html, /<link rel="apple-touch-icon" href="apple-touch-icon\.png">/);
  ["logo.svg", "icon-32.png", "icon-192.png", "apple-touch-icon.png"].forEach((f) => assert.ok(fs.existsSync(path.join(root, "www", f)), f));
});

function pngSize(buffer) {
  assert.equal(buffer.slice(1, 4).toString("ascii"), "PNG");
  return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
}

test("icons: every PNG exists at its exact size, with an alpha channel (transparent corners)", () => {
  Icons.PNG_SIZES.forEach((size) => {
    const buffer = fs.readFileSync(path.join(root, "assets", "icons", size + ".png"));
    assert.deepEqual(pngSize(buffer), [size, size], size + "px");
    assert.ok(buffer[25] === 6 || buffer[25] === 4, "RGBA colour type for " + size);
  });
  assert.deepEqual(pngSize(fs.readFileSync(path.join(root, "assets", "icon.png"))), [512, 512]);
  assert.deepEqual(pngSize(fs.readFileSync(path.join(root, "www", "icon-32.png"))), [32, 32]);
  assert.deepEqual(pngSize(fs.readFileSync(path.join(root, "www", "icon-192.png"))), [192, 192]);
  assert.deepEqual(pngSize(fs.readFileSync(path.join(root, "www", "apple-touch-icon.png"))), [180, 180]);
});

test("icon.ico: a valid Windows icon with every size from 16 to 256, each frame a PNG of the declared size", () => {
  const ico = fs.readFileSync(path.join(root, "assets", "icon.ico"));
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1, "type: icon");
  const count = ico.readUInt16LE(4);
  assert.equal(count, Icons.ICO_SIZES.length);
  const sizes = [];
  for (let i = 0; i < count; i += 1) {
    const base = 6 + i * 16;
    const width = ico[base] || 256;
    const bytes = ico.readUInt32LE(base + 8);
    const offset = ico.readUInt32LE(base + 12);
    assert.ok(offset + bytes <= ico.length);
    assert.deepEqual(pngSize(ico.slice(offset, offset + bytes)), [width, width]);
    sizes.push(width);
  }
  assert.deepEqual(sizes, Icons.ICO_SIZES);
  assert.ok(sizes.includes(256), "Windows needs 256 for the large icon");
});

test("icon.icns: valid container whose total length matches and whose entries are PNGs", () => {
  const icns = fs.readFileSync(path.join(root, "assets", "icon.icns"));
  assert.equal(icns.slice(0, 4).toString("ascii"), "icns");
  assert.equal(icns.readUInt32BE(4), icns.length);
  let at = 8;
  const types = [];
  while (at < icns.length) {
    const type = icns.slice(at, at + 4).toString("ascii");
    const length = icns.readUInt32BE(at + 4);
    const [w] = pngSize(icns.slice(at + 8, at + length));
    types.push([type, w]);
    at += length;
  }
  assert.equal(at, icns.length);
  assert.deepEqual(types, Icons.ICNS_TYPES);
});

test("container builders: ico and icns round-trip the bytes they are given", () => {
  const frame = Buffer.from([137, 80, 78, 71, 1, 2, 3]);
  const ico = Icons.buildIco([{ size: 16, data: frame }, { size: 256, data: frame }]);
  assert.equal(ico.readUInt16LE(4), 2);
  assert.equal(ico[6], 16);
  assert.equal(ico[6 + 16], 0, "256 is stored as 0");
  assert.equal(ico.readUInt32LE(6 + 12), 6 + 32);
  const icns = Icons.buildIcns([{ type: "ic07", data: frame }]);
  assert.equal(icns.readUInt32BE(4), 8 + 8 + frame.length);
  assert.equal(icns.slice(8, 12).toString(), "ic07");
});

test("Electron: the window uses the icon; the build config ships icons and uses assets/ as its resources folder", () => {
  const main = read("main.js");
  assert.match(main, /const iconPath = path\.join\(__dirname, "assets", process\.platform === "win32" \? "icon\.ico" : "icon\.png"\);/);
  assert.match(main, /icon: iconPath,/);
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.build.directories.buildResources, "assets");
  assert.equal(pkg.build.win.icon, "assets/icon.ico");
  assert.equal(pkg.build.mac.icon, "assets/icon.icns");
  assert.ok(pkg.build.files.includes("assets/icon.ico") && pkg.build.files.includes("assets/icon.png"), "the window icon is inside the package");
  assert.match(read(".gitignore"), /^build\/$/m, "build/ stays ignored, which is why icons live in assets/");
});
