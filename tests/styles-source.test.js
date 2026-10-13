"use strict";

// Source-level checks against the shipped CSS/HTML - these verify the
// stylesheet/markup actually contains the required rules; they are NOT a
// substitute for real browser/visual verification (see
// docs/phase-04-premium-ui.md, "Responsive verification" for what was and
// was not run in an actual browser).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const STYLES_CSS = fs.readFileSync(path.join(__dirname, "..", "www", "styles.css"), "utf8");
const THEME_CSS = fs.readFileSync(path.join(__dirname, "..", "www", "theme.css"), "utf8");
const INDEX_HTML = fs.readFileSync(path.join(__dirname, "..", "www", "index.html"), "utf8");

test("required responsive breakpoints are present", () => {
  const required = ["1440px", "1280px", "1024px", "768px", "430px", "390px", "360px"];
  required.forEach((bp) => {
    assert.match(STYLES_CSS, new RegExp("@media[^{]*" + bp), `missing an @media rule for ${bp}`);
  });
});

test("prefers-reduced-motion is respected", () => {
  assert.match(STYLES_CSS, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(STYLES_CSS, /animation-duration: 0\.001ms/);
});

test("per-message RTL rules exist and are scoped to message content, not the whole page", () => {
  assert.match(STYLES_CSS, /\.message-content\[dir="rtl"\]/);
  // Must not force the whole <html>/<body> RTL from a single message.
  assert.doesNotMatch(STYLES_CSS, /html\[dir="rtl"\]|body\[dir="rtl"\]/);
});

test("code blocks scroll internally instead of overflowing the page", () => {
  assert.match(STYLES_CSS, /\.message-content pre\s*\{[^}]*overflow-x:\s*auto/);
});

test("visible focus styling is defined and not simply removed", () => {
  assert.match(STYLES_CSS, /:focus-visible\s*\{/);
  assert.doesNotMatch(STYLES_CSS, /:focus\s*\{\s*outline:\s*none/);
});

test("touch target sizing token is applied to interactive controls", () => {
  assert.match(THEME_CSS, /--touch-target-min:\s*44px/);
  assert.match(STYLES_CSS, /min-height:\s*var\(--touch-target-min\)/);
});

test("no unbounded z-index or magic numbers - z-index values come from tokens", () => {
  const zIndexDeclarations = STYLES_CSS.match(/z-index:\s*[^;]+;/g) || [];
  assert.ok(zIndexDeclarations.length > 0, "expected at least one z-index rule");
  zIndexDeclarations.forEach((decl) => {
    assert.match(decl, /var\(--z-|^\s*z-index:\s*5;/, `z-index should reference a token: ${decl}`);
  });
});

test("light and dark theme palettes are both fully defined", () => {
  assert.match(THEME_CSS, /:root\[data-theme="light"\]\{/);
  assert.match(THEME_CSS, /:root\[data-theme="dark"\]\{/);
  ["--bg", "--surface", "--surface-2", "--text", "--text-muted", "--accent", "--accent-hover", "--accent-soft", "--border", "--danger"].forEach((token) => {
    const lightBlock = THEME_CSS.split(':root[data-theme="light"]')[1].split("}")[0];
    const darkBlock = THEME_CSS.split(':root[data-theme="dark"]')[1].split("}")[0];
    assert.match(lightBlock, new RegExp(token.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")), `light theme missing ${token}`);
    assert.match(darkBlock, new RegExp(token.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")), `dark theme missing ${token}`);
  });
});

test("no inline style attributes remain in index.html (required for the tightened CSP)", () => {
  assert.doesNotMatch(INDEX_HTML, /\sstyle\s*=\s*"/);
});

test("no inline <script> blocks remain in index.html - only external same-origin or gstatic script src", () => {
  const withoutComments = INDEX_HTML.replace(/<!--[\s\S]*?-->/g, "");
  const scriptOpenTags = withoutComments.match(/<script[^>]*>/g) || [];
  assert.ok(scriptOpenTags.length > 0, "expected to find real <script> tags outside of comments");
  scriptOpenTags.forEach((tag) => {
    assert.match(tag, /\bsrc=/, `expected every <script> tag to have a src attribute: ${tag}`);
  });
});

test("theme.js loads before any stylesheet, as a blocking (non-deferred/async/module) script", () => {
  const themeScriptIndex = INDEX_HTML.indexOf('<script src="theme.js">');
  const firstStylesheetIndex = INDEX_HTML.indexOf('<link rel="stylesheet"');
  assert.ok(themeScriptIndex !== -1, "theme.js script tag not found");
  assert.ok(themeScriptIndex < firstStylesheetIndex, "theme.js must load before stylesheets to avoid a theme flash");
  const tag = INDEX_HTML.slice(themeScriptIndex, INDEX_HTML.indexOf(">", themeScriptIndex) + 1);
  assert.doesNotMatch(tag, /defer|async|type="module"/);
});

test("mobile drawer backdrop element exists in markup", () => {
  assert.match(INDEX_HTML, /id="sidebar-backdrop"/);
});

test("empty state, settings button, and scroll-to-bottom control exist in markup", () => {
  ["id=\"empty-state\"", "id=\"settings-btn\"", "id=\"scroll-to-bottom-btn\""].forEach((needle) => {
    assert.ok(INDEX_HTML.includes(needle), `missing ${needle} in index.html`);
  });
});

test("composer textarea has an accessible label", () => {
  assert.match(INDEX_HTML, /<label for="user-input" class="sr-only">/);
});

test("search input has an accessible label", () => {
  assert.match(INDEX_HTML, /<label for="chat-search-input" class="sr-only">/);
});

// Regression test (Phase 7): a real headless-Chromium browser test found
// that elements toggled via the `hidden` DOM property (e.g. #empty-state)
// stayed visually rendered even with hidden=true, because author rules like
// `.empty-state{ display: flex }` beat the browser's built-in
// `[hidden]{ display: none }` UA-stylesheet rule (author origin always wins
// over user-agent origin, regardless of matching specificity). Confirmed
// live: the empty-state welcome card rendered on top of an active,
// non-empty conversation at 1440x900. See e2e/empty-state.js for the full
// browser-level regression check (this test only guards the CSS rule
// existing at all, which a plain source check can do cheaply on every run).
test("a global [hidden] rule restores real hidden behavior over conflicting author display rules", () => {
  assert.match(STYLES_CSS, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
});

// Regression test (Phase 8): axe-core's "region" rule found the composer
// (outside any landmark) once role="main" was scoped too narrowly to just
// the chat-scroll-wrapper. Fixed by moving role="main" up to .container
// (which covers header + chat + composer together) and removing the
// now-redundant/conflicting role="banner" on .header (a banner nested
// inside main is flagged invalid by axe's own landmark rules).
test("exactly one role=\"main\" landmark exists and covers the composer, not just the chat area", () => {
  const mainMatches = INDEX_HTML.match(/role="main"/g) || [];
  assert.equal(mainMatches.length, 1, "expected exactly one role=\"main\" landmark");
  assert.match(INDEX_HTML, /<div class="container" role="main"/);
});

test("role=\"banner\" is not used (would nest inside the single role=\"main\" landmark, which axe-core flags as invalid)", () => {
  assert.doesNotMatch(INDEX_HTML, /role="banner"/);
});

test("styles.css hardcodes no colors outside comments - every color comes from a theme.css token", () => {
  const withoutComments = STYLES_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  const hardcoded = withoutComments.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g) || [];
  assert.deepEqual(hardcoded, [], "move these into theme.css tokens");
});

test("styles.css hardcodes no font sizes or px radii - they come from the type scale and radius tokens", () => {
  const withoutComments = STYLES_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.deepEqual(withoutComments.match(/font-size:\s*[0-9.]+(rem|px)/g) || [], []);
  assert.deepEqual(withoutComments.match(/border-radius:\s*[0-9]+px/g) || [], []);
});

test("palette matches the Phase 1 spec (light + dark accent and background)", () => {
  const lightBlock = THEME_CSS.split(':root[data-theme="light"]')[1].split("}")[0];
  const darkBlock = THEME_CSS.split(':root[data-theme="dark"]')[1].split("}")[0];
  assert.match(lightBlock, /--accent:\s*#C2562F/i);
  assert.match(lightBlock, /--bg:\s*#FAF8F5/i);
  assert.match(darkBlock, /--accent:\s*#E07A52/i);
  assert.match(darkBlock, /--bg:\s*#171412/i);
});

test("type scale defines xs through 3xl; heading family is Fraunces and body family is Inter", () => {
  ["xs", "sm", "md", "lg", "xl", "2xl", "3xl"].forEach((step) => {
    assert.match(THEME_CSS, new RegExp("--font-size-" + step + ":"));
  });
  assert.match(THEME_CSS, /--font-family-heading:\s*"Fraunces"/);
  assert.match(THEME_CSS, /--font-family:\s*"Inter"/);
});

test("fonts are bundled locally: fonts.css is linked before theme.css, every file exists, and no CDN is used", () => {
  const FONTS_CSS = fs.readFileSync(path.join(__dirname, "..", "www", "fonts.css"), "utf8");
  const fontsIndex = INDEX_HTML.indexOf('href="fonts.css"');
  assert.ok(fontsIndex !== -1 && fontsIndex < INDEX_HTML.indexOf('href="theme.css"'));
  assert.doesNotMatch(FONTS_CSS, /https?:\/\//, "fonts must never load from a CDN (the app must work offline)");
  assert.doesNotMatch(INDEX_HTML, /fonts\.googleapis|fonts\.gstatic/);
  const urls = FONTS_CSS.match(/url\("([^"]+)"\)/g) || [];
  assert.ok(urls.length > 0);
  urls.forEach((u) => {
    const rel = u.slice(5, -2);
    assert.ok(fs.existsSync(path.join(__dirname, "..", "www", rel)), "missing font file: " + rel);
  });
});

test("Noto Sans Arabic is bundled and sits right after Inter / Fraunces in the font stacks", () => {
  const FONTS_CSS = fs.readFileSync(path.join(__dirname, "..", "www", "fonts.css"), "utf8");
  assert.match(FONTS_CSS, /font-family:\s*"Noto Sans Arabic"/);
  assert.match(THEME_CSS, /--font-family:\s*"Inter",\s*"Noto Sans Arabic"/);
  assert.match(THEME_CSS, /--font-family-heading:\s*"Fraunces",\s*"Noto Sans Arabic"/);
});

test("layout: chat content and composer are capped at 760px; the hero is not pushed right by the empty chat box", () => {
  assert.match(THEME_CSS, /--content-max-width:\s*760px/);
  assert.match(THEME_CSS, /--composer-max-width:\s*760px/);
  assert.match(STYLES_CSS, /\.chat-scroll-wrapper:has\(> \.empty-state:not\(\[hidden\]\)\) > \.chat-box\s*\{\s*display:\s*none/);
  assert.match(STYLES_CSS, /\.empty-state\s*\{[^}]*scrollbar-gutter:\s*stable both-edges/);
});

test("restyle: sidebar on --surface-2, active chat on --accent-soft, New chat and Send on --accent", () => {
  assert.match(STYLES_CSS, /\.sidebar\{[^}]*background:\s*var\(--surface-2\)/);
  assert.match(STYLES_CSS, /\.conversation-item\.active\{\s*background:\s*var\(--accent-soft\)/);
  assert.match(STYLES_CSS, /\.new-chat-btn\{[^}]*background:\s*var\(--accent\)/);
  assert.match(STYLES_CSS, /\.controls:focus-within\{[^}]*border-color:\s*var\(--accent\)/);
});

test("restyle: the heading font is used only for the hero title and Settings section headings", () => {
  const uses = STYLES_CSS.match(/font-family:\s*var\(--font-family-heading\)/g) || [];
  assert.equal(uses.length, 2);
  assert.match(STYLES_CSS, /\.empty-state-title\{\s*font-family:\s*var\(--font-family-heading\)/);
  assert.match(STYLES_CSS, /\.settings-section-title\{\s*font-family:\s*var\(--font-family-heading\)/);
});

test("restyle: Settings' Clear all is an outlined danger button, not a solid red block", () => {
  const rule = STYLES_CSS.split(".lh-settings-dialog .lh-btn-danger{")[1].split("}")[0];
  assert.match(rule, /background:\s*transparent/);
  assert.match(rule, /border:\s*1px solid var\(--danger\)/);
  assert.match(rule, /color:\s*var\(--danger-text\)/);
});

test("contrast tokens exist in every palette (muted text on surface-2, danger text on dark surfaces)", () => {
  const light = THEME_CSS.split(':root[data-theme="light"]')[1].split("}")[0];
  const dark = THEME_CSS.split(':root[data-theme="dark"]')[1].split("}")[0];
  [light, dark].forEach((block) => {
    assert.match(block, /--text-muted-strong:/);
    assert.match(block, /--danger-text:/);
    assert.match(block, /--accent-text:/);
  });
});

test("tall dialogs (Settings) scroll inside the window and stay below the title bar", () => {
  assert.match(STYLES_CSS, /\.lh-dialog-backdrop\{[^}]*inset:\s*var\(--titlebar-height\) 0 0 0/);
  assert.match(STYLES_CSS, /\.lh-dialog\{[^}]*max-height:\s*100%;[^}]*overflow-y:\s*auto/);
});

test("collapsed sidebar: the icon-only New chat and sign-in buttons keep an accessible name", () => {
  assert.match(INDEX_HTML, /id="new-chat-btn"[^>]*aria-label="New chat"/);
  assert.match(INDEX_HTML, /id="login-btn"[^>]*aria-label="Guest User, sign in for sync"/);
});
