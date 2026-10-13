"use strict";

// Source-level guards for the Phase 2 chat experience (streaming, rendering,
// actions, composer, scrolling, states). Behavior itself was verified by
// driving the real Electron app against a mock SSE backend.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (f) => fs.readFileSync(path.join(__dirname, "..", "www", f), "utf8");
const APP_JS = read("app.js");
const STYLES_CSS = read("styles.css");

// ---- Step 1: streaming ----------------------------------------------------

test("streaming renders Markdown live (throttled), tracks the SOURCE text, and flushes before the final render", () => {
  assert.match(APP_JS, /throttle\(\(text\) => renderStreamingContent\(aiBubble, text\), 80\)/);
  assert.match(APP_JS, /streamText \+= parsed\.delta;\s*aiBubble\.rawText = streamText;/);
  assert.match(APP_JS, /throttledRender\.flush\(\);\s*throttledSave\.flush\(\);/);
  assert.match(APP_JS, /const rawText = aiBubble\.rawText \|\| aiBubble\.contentEl\.textContent;/);
});

test("regenerate/retry start from an empty source so a stale previous reply is never persisted", () => {
  assert.match(APP_JS, /setBusy\(true\);\s*\/\/[^\n]*\n\s*aiBubble\.rawText = "";/);
});

test("a blinking accent cursor is appended inside the last text block while streaming and is aria-hidden", () => {
  assert.match(APP_JS, /cursor\.className = "stream-cursor"/);
  assert.match(APP_JS, /cursor\.setAttribute\("aria-hidden", "true"\)/);
  assert.match(STYLES_CSS, /\.stream-cursor\{[^}]*background:\s*var\(--accent\)[^}]*animation:\s*lh-cursor-blink/);
  assert.match(STYLES_CSS, /@keyframes lh-cursor-blink/);
});

test("rendered Markdown collapses inter-block newlines (no blank gaps) while plain text keeps pre-wrap", () => {
  assert.match(STYLES_CSS, /\.message-content\{[^}]*white-space:\s*pre-wrap/);
  assert.match(STYLES_CSS, /\.message-content:has\(> p[^{]*> \.code-block\)\{\s*white-space:\s*normal/);
});

test("chat scrolling during streaming is instant, never smooth (smooth breaks the near-bottom check)", () => {
  assert.match(APP_JS, /scrollTo\(\{ top: chatBox\.scrollHeight, behavior: "instant" \}\)/);
});

// ---- Step 2: rendering / RTL ----------------------------------------------

test("RTL detection sets dir=auto (never a forced rtl) on plain-text elements; rendered Markdown is per-block", () => {
  assert.match(APP_JS, /el\.setAttribute\("dir", "auto"\)/);
  assert.doesNotMatch(APP_JS, /setAttribute\("dir", "rtl"\)/);
  assert.match(read("markdown.js"), /BIDI_BLOCK_TAGS/);
});

test("inline code is bidi-isolated and code blocks stay left-to-right inside RTL text", () => {
  assert.match(STYLES_CSS, /\.message-content code\{\s*unicode-bidi:\s*isolate/);
  assert.match(STYLES_CSS, /\.message-content pre\{\s*direction:\s*ltr/);
});
