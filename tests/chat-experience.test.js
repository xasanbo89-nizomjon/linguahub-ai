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

// ---- Step 3: message actions / feedback --------------------------------------

const ChatStoreModule = require("../www/chatStore.js");

function makeStore() {
  const map = new Map();
  const storage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    key: (i) => Array.from(map.keys())[i] || null,
    get length() { return map.size; }
  };
  return ChatStoreModule.createChatStore({ storage });
}

function seededConversation(store) {
  const conv = store.createConversation().conversation || store.createConversation();
  const id = conv.id;
  store.saveMessage(id, ChatStoreModule.createMessage("user", "hi", "complete"));
  const reply = ChatStoreModule.createMessage("assistant", "hello", "complete");
  store.saveMessage(id, reply);
  return { id, replyId: reply.id };
}

test("feedback: only 'up'/'down' on assistant messages is kept; it persists and can be cleared", () => {
  const store = makeStore();
  const { id, replyId } = seededConversation(store);
  assert.equal(store.setMessageFeedback(id, replyId, "up").ok, true);
  let msgs = store.getConversation(id).messages;
  assert.equal(msgs[1].feedback, "up");
  assert.equal(store.setMessageFeedback(id, replyId, "down").ok, true);
  assert.equal(store.getConversation(id).messages[1].feedback, "down");
  assert.equal(store.setMessageFeedback(id, replyId, null).ok, true);
  assert.equal("feedback" in store.getConversation(id).messages[1], false);
  assert.equal(store.setMessageFeedback(id, replyId, "love").ok, false);
  assert.equal(store.setMessageFeedback(id, msgs[0].id, "up").ok, false, "user messages cannot be rated");
  assert.equal(store.setMessageFeedback("nope", replyId, "up").ok, false);
});

test("feedback: rating a reply does not reorder the conversation (updatedAt unchanged)", () => {
  const store = makeStore();
  const { id, replyId } = seededConversation(store);
  const before = store.getConversation(id).updatedAt;
  store.setMessageFeedback(id, replyId, "up");
  assert.equal(store.getConversation(id).updatedAt, before);
});

test("feedback: sanitizeMessage drops unknown values and never accepts feedback on user messages", () => {
  const S = ChatStoreModule.sanitizeMessage;
  assert.equal(S({ role: "assistant", content: "x", feedback: "up" }).feedback, "up");
  assert.equal("feedback" in S({ role: "assistant", content: "x", feedback: "<script>" }), false);
  assert.equal("feedback" in S({ role: "user", content: "x", feedback: "up" }), false);
});

test("feedback: it is not part of an exported conversation (local only)", () => {
  const store = makeStore();
  const { id, replyId } = seededConversation(store);
  store.setMessageFeedback(id, replyId, "up");
  assert.doesNotMatch(store.exportConversationJson(id).json, /feedback/);
});

test("actions: AI messages get copy, listen, regenerate and thumbs; user messages copy and edit; icons are SVG with a text fallback", () => {
  assert.match(APP_JS, /buildActionButton\("feedback-up", "Good response"/);
  assert.match(APP_JS, /buildActionButton\("feedback-down", "Bad response"/);
  assert.match(APP_JS, /buildActionButton\("regenerate", "Regenerate response"/);
  assert.match(APP_JS, /buildActionButton\("speak", "Listen"/);
  assert.match(APP_JS, /buildActionButton\("edit", "Edit message"/);
  assert.match(APP_JS, /typeof document\.createElementNS !== "function"\) return null/);
});

test("actions: hidden until hover/focus, always shown on the last message and where there is no hover; hidden while streaming", () => {
  assert.match(STYLES_CSS, /\.chat-box > \.message:last-child \.message-actions\{\s*opacity:\s*1/);
  assert.match(STYLES_CSS, /@media \(hover: none\)\{\s*\.message-actions\{\s*opacity:\s*1/);
  assert.match(STYLES_CSS, /\.message\[data-status="streaming"\] \.message-actions\{\s*display:\s*none/);
});

test("actions: a new generation clears the old rating; restore re-applies the stored rating", () => {
  assert.match(APP_JS, /aiBubble\.dataset\.feedback = "";/);
  assert.match(APP_JS, /feedback: message\.feedback/);
});
