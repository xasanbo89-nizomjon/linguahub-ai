"use strict";

// Phase 5, step 2: micro-animations - CSS only, token durations, reduced-motion safe.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const css = fs.readFileSync(path.join(__dirname, "..", "www", "styles.css"), "utf8");
const theme = fs.readFileSync(path.join(__dirname, "..", "www", "theme.css"), "utf8");
const section = css.slice(css.indexOf("Micro-animations (Phase 5)"));

function rules(source) {
  const out = [];
  const re = /([^{}@][^{}]*)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(source))) out.push({ selector: m[1].trim().replace(/\s+/g, " "), body: m[2] });
  return out;
}

test("the 150ms duration is a theme token (message / popover / panel motion), next to the existing ones", () => {
  assert.match(theme, /--duration-fast: 120ms;\s*--duration-medium: 150ms;\s*--duration-base: 200ms;/);
});

test("every animation in the Phase 5 block uses a token duration and the standard easing", () => {
  const animations = section.match(/animation: [^;]+;/g).filter((a) => !/none/.test(a));
  assert.ok(animations.length >= 7);
  animations.forEach((a) => {
    assert.match(a, /var\(--duration-(fast|medium|base)\) var\(--ease-standard\)/, a);
  });
  assert.doesNotMatch(section, /\d+ms/, "no literal millisecond values: durations come from tokens");
});

test("messages fade and slide in on their first appearance: yours from the right, the assistant's from the left", () => {
  assert.match(section, /\.message\.user\{\s*animation: lh-slide-in-right var\(--duration-medium\)/);
  assert.match(section, /\.message\.ai\{\s*animation: lh-slide-in-left var\(--duration-medium\)/);
  assert.match(section, /@keyframes lh-slide-in-left\{\s*from\{ opacity: 0; transform: translateX\(-8px\); \}/);
  assert.match(section, /@keyframes lh-slide-in-right\{\s*from\{ opacity: 0; transform: translateX\(8px\); \}/);
});

test("streamed text is never animated per token (only the message container animates)", () => {
  const animated = rules(section).filter((r) => /animation:/.test(r.body) && !/none/.test(r.body)).map((r) => r.selector).join(" | ");
  assert.doesNotMatch(animated, /message-content|stream-cursor|\.dot/);
});

test("press feedback exists for round and icon buttons, cards and the flashcard answers", () => {
  assert.match(section, /\.ws-icon-btn:active:not\(:disabled\),[\s\S]*?\{\s*transform: scale\(0\.92\);/);
  assert.match(section, /\.flashcard-grade:active\{\s*transform: scale\(0\.96\);/);
  assert.match(section, /\.mode-card:active:not\(:disabled\)\{\s*transform: translateY\(0\) scale\(0\.99\);/);
  assert.match(css, /button:active:not\(:disabled\)\{\s*transform: scale\(0\.97\);/, "the base button press from Phase 1 is still there");
});

test("hover states: cards lift, rows get a border, everything transitions only cheap properties", () => {
  assert.match(section, /\.mode-card:hover:not\(:disabled\)\{\s*transform: translateY\(-2px\);\s*box-shadow: var\(--shadow-2\);/);
  assert.match(section, /\.vocab-item:hover,\s*\.vocab-suggestion:hover\{\s*border-color: var\(--border-strong\);/);
  const transitions = section.match(/transition: [^;]+;/g);
  transitions.forEach((t) => assert.doesNotMatch(t, /\b(width|height|top|left|margin|padding|all)\b/, "layout properties are never transitioned: " + t));
});

test("menus, popovers, the palette and tooltips grow in when they open", () => {
  assert.match(section, /\.chat-menu-list:not\(\[hidden\]\),\s*\.word-pop:not\(\[hidden\]\),\s*\.lh-palette\{\s*animation: lh-pop-in var\(--duration-medium\)/);
  assert.match(section, /\.gr-edit\.is-open \.gr-tip\{\s*animation: lh-pop-in var\(--duration-fast\)/);
  assert.match(css, /\.lh-dialog\{[^}]*animation: lh-dialog-in var\(--duration-base\)/, "dialogs already animate (Phase 1)");
});

test("switching mode fades the incoming screen up: workspaces, the home and the chat", () => {
  assert.match(section, /\.workspace-panel,\s*\.home-root:not\(:empty\),\s*\.container:not\(\[data-workspace\]\) > \.chat-scroll-wrapper\{\s*animation: lh-panel-in var\(--duration-medium\)/);
});

test("flashcards slide in when the next card appears and tip forward when turned over", () => {
  assert.match(section, /\.flashcard\{\s*animation: lh-card-in var\(--duration-base\)/);
  assert.match(section, /\.flashcard\.is-flipped\{\s*animation: lh-card-flip var\(--duration-base\)/);
  assert.match(section, /@keyframes lh-card-flip\{[^}]*rotateX\(-70deg\)[^}]*\}[^}]*rotateX\(0\)/);
});

test("prefers-reduced-motion: every new animation is switched off and hover/press movement is removed", () => {
  const block = section.slice(section.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
  ["\\.message\\.user", "\\.message\\.ai", "\\.chat-menu-list", "\\.word-pop", "\\.lh-palette", "\\.gr-tip", "\\.workspace-panel", "\\.home-root", "\\.chat-scroll-wrapper", "\\.flashcard", "\\.flashcard\\.is-flipped"]
    .forEach((s) => assert.match(block, new RegExp(s)));
  assert.match(block, /animation: none !important;/);
  assert.match(block, /\.mode-card:hover:not\(:disabled\)[\s\S]*transform: none !important;/);
  assert.match(block, /button:hover:not\(:disabled\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\{\s*\*, \*::before, \*::after\{\s*animation-duration: 0\.001ms !important;[\s\S]*transition-duration: 0\.001ms !important;/, "the global switch from Phase 1 is still in place");
});

test("no JavaScript animation libraries or requestAnimationFrame loops were added for this", () => {
  ["app.js", "ws-vocab.js", "workspace.js", "word-lookup.js", "home-ui.js"].forEach((f) => {
    const src = fs.readFileSync(path.join(__dirname, "..", "www", f), "utf8");
    assert.doesNotMatch(src, /requestAnimationFrame|\.animate\(/, f);
  });
});
