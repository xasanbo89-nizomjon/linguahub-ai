"use strict";

// Tests www/markdown.js against the REAL vendored marked + DOMPurify
// libraries (www/vendor/) inside a real jsdom document - not a fake DOM.
// DOMPurify specifically needs genuine HTML-parsing behavior (a fake
// element tree isn't enough to prove sanitization actually works), so
// jsdom is used here deliberately, unlike the lighter vm+fake-DOM pattern
// used for the other www/*.js tests. jsdom is a devDependency only - it
// never ships to the frontend.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const MARKED_SRC = fs.readFileSync(path.join(__dirname, "..", "www", "vendor", "marked.umd.js"), "utf8");
const PURIFY_SRC = fs.readFileSync(path.join(__dirname, "..", "www", "vendor", "purify.min.js"), "utf8");
const MARKDOWN_SRC = fs.readFileSync(path.join(__dirname, "..", "www", "markdown.js"), "utf8");

function createMarkdownWindow() {
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
url: "http://127.0.0.1:3000/",
runScripts: "dangerously"
});
dom.window.eval(MARKED_SRC);
dom.window.eval(PURIFY_SRC);
dom.window.eval(MARKDOWN_SRC);
return dom.window;
}

const win = createMarkdownWindow();
const MD = win.LinguaHubMarkdown;

test("marked and DOMPurify actually loaded into the test window", () => {
assert.equal(typeof win.marked, "object");
assert.equal(typeof win.DOMPurify, "function");
assert.equal(typeof MD, "object");
});

// ---------------------------------------------------------------------
// Task 2 - safe Markdown rendering
// ---------------------------------------------------------------------

test("renders a heading", () => {
assert.match(MD.renderToSafeHtml("# Hello"), /<h1 dir="auto">Hello<\/h1>/);
});

test("renders an unordered list", () => {
const html = MD.renderToSafeHtml("- one\n- two");
assert.match(html, /<ul dir="auto">/);
assert.match(html, /<li dir="auto">one<\/li>/);
});

test("renders an ordered list", () => {
const html = MD.renderToSafeHtml("1. first\n2. second");
assert.match(html, /<ol dir="auto">/);
assert.match(html, /<li dir="auto">first<\/li>/);
});

test("renders a table", () => {
const html = MD.renderToSafeHtml("| a | b |\n|---|---|\n| 1 | 2 |");
assert.match(html, /<table dir="auto">/);
assert.match(html, /<th dir="auto">a<\/th>/);
assert.match(html, /<td dir="auto">1<\/td>/);
});

test("renders a blockquote", () => {
assert.match(MD.renderToSafeHtml("> quoted text"), /<blockquote dir="auto">[\s\S]*quoted text[\s\S]*<\/blockquote>/);
});

test("renders inline code", () => {
assert.match(MD.renderToSafeHtml("Use `npm install`"), /<code>npm install<\/code>/);
});

test("renders a fenced code block with a language label and copy button", () => {
const html = MD.renderToSafeHtml("```python\nprint('hi')\n```");
assert.match(html, /class="code-block"/);
assert.match(html, /data-lang="python"/);
assert.match(html, /code-block-copy-btn/);
assert.match(html, /<pre><code/);
});

test("renders a horizontal rule", () => {
assert.match(MD.renderToSafeHtml("---"), /<hr>/);
});

test("a safe external link gets target=_blank and rel=noopener noreferrer", () => {
const html = MD.renderToSafeHtml("[site](https://example.com)");
assert.match(html, /href="https:\/\/example\.com"/);
assert.match(html, /target="_blank"/);
assert.match(html, /rel="noopener noreferrer"/);
});

test("parser failure falls back to readable escaped text instead of losing the message", () => {
// marked's own `parse` property is frozen/non-configurable on the real
// object, so it can't be monkey-patched to throw. Instead, this test
// substitutes a minimal fake `marked` (a throwing parser, otherwise
// matching the real API shape) in a fresh window, with the REAL DOMPurify
// still doing the final sanitization - proving the try/catch fallback in
// www/markdown.js itself, not reimplementing marked.
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
url: "http://127.0.0.1:3000/",
runScripts: "dangerously"
});
dom.window.eval(PURIFY_SRC);
dom.window.marked = {
Renderer: function FakeRenderer() { this.code = null; },
setOptions: function () {},
parse: function () { throw new Error("boom"); }
};
dom.window.eval(MARKDOWN_SRC);

const html = dom.window.LinguaHubMarkdown.renderToSafeHtml("some <b>text</b> & content");
assert.doesNotMatch(html, /<b>/);
assert.match(html, /some/);
});

// ---------------------------------------------------------------------
// Task 2/16 - security: no raw executable HTML, no JS URLs, no event
// handlers, no dangerous tags
// ---------------------------------------------------------------------

test("a <script> tag is completely removed, not merely escaped-and-shown", () => {
const html = MD.renderToSafeHtml("hello<script>alert(1)</script>world");
assert.doesNotMatch(html, /<script/i);
assert.match(html, /hello/);
assert.match(html, /world/);
});

test("an event-handler attribute is stripped", () => {
const html = MD.renderToSafeHtml('<img src=x onerror="alert(1)">');
assert.doesNotMatch(html, /onerror/i);
});

test("a javascript: URL is neutralized (href removed)", () => {
const html = MD.renderToSafeHtml('<a href="javascript:alert(1)">click</a>');
assert.doesNotMatch(html, /javascript:/i);
});

test("a javascript: URL with mixed case/whitespace tricks is still neutralized", () => {
const html = MD.renderToSafeHtml('<a href="JaVaScRiPt:alert(1)">click</a>');
assert.doesNotMatch(html, /javascript:/i);
});

test("an <iframe> is removed entirely", () => {
const html = MD.renderToSafeHtml('<iframe src="https://evil.example"></iframe>');
assert.doesNotMatch(html, /<iframe/i);
});

test("<object> and <embed> are removed", () => {
assert.doesNotMatch(MD.renderToSafeHtml('<object data="evil.swf"></object>'), /<object/i);
assert.doesNotMatch(MD.renderToSafeHtml('<embed src="evil.swf">'), /<embed/i);
});

test("inline style attributes (a common CSS-based XSS vector) are stripped", () => {
const html = MD.renderToSafeHtml('<div style="background:url(javascript:alert(1))">x</div>');
assert.doesNotMatch(html, /style=/i);
});

test("a <form>/<input> pair is removed", () => {
const html = MD.renderToSafeHtml('<form action="evil"><input></form>');
assert.doesNotMatch(html, /<form/i);
assert.doesNotMatch(html, /<input/i);
});

// ---------------------------------------------------------------------
// Task 4 - code block experience
// ---------------------------------------------------------------------

test("recognized language gets syntax-highlighted keyword/string/number/comment spans", () => {
const html = MD.renderToSafeHtml("```javascript\nconst x = 1; // note\n```");
assert.match(html, /tok-keyword/);
assert.match(html, /tok-number/);
assert.match(html, /tok-comment/);
});

test("an unrecognized language still renders as safe escaped plain text (readable fallback)", () => {
const html = MD.renderToSafeHtml("```weirdlang\n<b>not html</b> & stuff\n```");
assert.doesNotMatch(html, /<b>/);
assert.match(html, /&lt;b&gt;/);
assert.doesNotMatch(html, /tok-keyword/);
});

test("code blocks are marked dir=ltr regardless of surrounding content", () => {
const html = MD.renderToSafeHtml("```js\nconst x = 1;\n```");
assert.match(html, /dir="ltr"/);
});

test("raw code text round-trips exactly (no lost/mangled characters) once extracted from the highlighted HTML", () => {
const dom = new (require("jsdom").JSDOM)("<!doctype html><body></body>", { runScripts: "dangerously" });
const code = "function foo(a, b) {\n  return a < b && a > 0;\n}";
const html = MD.renderToSafeHtml("```javascript\n" + code + "\n```");
dom.window.document.body.innerHTML = html;
const codeEl = dom.window.document.querySelector("code");
assert.equal(codeEl.textContent, code);
});

// ---------------------------------------------------------------------
// Task 15 - RTL and multilingual
// ---------------------------------------------------------------------

test("Arabic content renders correctly through the Markdown pipeline", () => {
const html = MD.renderToSafeHtml("مرحبا بكم في LinguaHub AI");
assert.match(html, /مرحبا بكم في LinguaHub AI/);
});

test("mixed Arabic/English content is preserved intact", () => {
const html = MD.renderToSafeHtml("Hello مرحبا World عالم");
assert.match(html, /Hello مرحبا World عالم/);
});

// ---------------------------------------------------------------------
// User messages are never Markdown-rendered (unchanged, intentional)
// ---------------------------------------------------------------------

test("markdown.js exposes rendering only - it is app.js's responsibility to never call it for user messages (structural note, verified in app.js tests)", () => {
// This is a documentation-anchor test: markdown.js itself is role-agnostic
// (it has no concept of "user" vs "assistant"). The actual guarantee that
// user messages stay plain text lives in www/app.js's addMessage() -
// covered by tests/app-actions.test.js.
assert.equal(typeof MD.renderToSafeHtml, "function");
});

// ---- Phase 2: per-block text direction (Arabic / mixed content) ----------

test("every paragraph gets dir=auto, so Arabic and English paragraphs each lay out by their own first strong character", () => {
  const html = MD.renderToSafeHtml("Hello there.\n\nمرحبا بك في الدرس\n\nAnother English line.");
  const paragraphs = html.match(/<p dir="auto">/g) || [];
  assert.equal(paragraphs.length, 3);
  assert.doesNotMatch(html, /dir="rtl"/, "never force a whole-message or whole-block rtl");
});

test("mixed Arabic/English inside one line stays in a single dir=auto paragraph with the text intact", () => {
  const html = MD.renderToSafeHtml("The word **كتاب** means book, and `print(1)` is code.");
  assert.match(html, /<p dir="auto">The word <strong>كتاب<\/strong> means book, and <code>print\(1\)<\/code> is code\.<\/p>/);
});

test("Arabic list items and table cells get their own direction; code blocks stay ltr", () => {
  const html = MD.renderToSafeHtml("- أولاً\n- ثانياً\n\n| الكلمة | المعنى |\n|---|---|\n| قلم | pen |\n\n```js\nconst a = 1;\n```");
  assert.match(html, /<li dir="auto">أولاً<\/li>/);
  assert.match(html, /<td dir="auto">قلم<\/td>/);
  assert.match(html, /<code[^>]*dir="ltr"/);
});

test("model output cannot inject script, handlers or javascript: links (sanitized)", () => {
  const hostile = [
    "<script>window.__x=1</script>hi",
    "<img src=x onerror=alert(1)>",
    "[click](javascript:alert(1))",
    "<a href=\"javascript:alert(1)\" onclick=\"alert(1)\">x</a>",
    "<iframe src=\"https://evil.example\"></iframe>",
    "<svg onload=alert(1)></svg>"
  ].join("\n\n");
  const html = MD.renderToSafeHtml(hostile);
  assert.doesNotMatch(html, /<script|onerror|onclick|onload|<iframe|<svg|javascript:/i);
});
