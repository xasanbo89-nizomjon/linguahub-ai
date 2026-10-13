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
  assert.match(APP_JS, /setBusy\(true\);[\s\S]{0,260}?aiBubble\.rawText = "";/);
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

// ---- Step 4: composer ----------------------------------------------------------

test("composer: auto-grows to 8 lines (CSS max-height) and the JS no longer caps at 200px", () => {
  assert.match(STYLES_CSS, /max-height:\s*calc\(8 \* 1em \* var\(--line-height-normal\) \+ 2 \* var\(--space-3\)\)/);
  assert.match(APP_JS, /input\.style\.height = input\.scrollHeight \+ "px"/);
  assert.doesNotMatch(APP_JS, /Math\.min\(input\.scrollHeight, 200\)/);
});

test("composer: stays enabled while generating (keeps focus); Send is disabled when empty or offline and is Stop while busy", () => {
  assert.doesNotMatch(APP_JS, /input\.disabled = busy/);
  assert.match(APP_JS, /sendBtn\.disabled = isBusy \? false : \(!input\.value\.trim\(\) \|\| isOffline\(\)\)/);
  assert.match(APP_JS, /input\.removeAttribute\("dir"\);\s*updateComposerState\(\);\s*input\.focus\(\);/);
});

test("composer: Enter sends (per the setting), never mid-IME-composition and never while a reply is generating", () => {
  assert.match(APP_JS, /if \(e\.isComposing \|\| e\.keyCode === 229\) return;/);
  assert.match(APP_JS, /if \(!isBusy\) sendMessage\(\);/);
  assert.match(APP_JS, /const message = input\.value\.trim\(\);\s*if \(!message \|\| isBusy\) return;/);
  assert.match(APP_JS, /isEnterToSendEnabled\(\)/);
});

test("composer: Esc stops generation unless a dialog, the chat menu or another handler already owns it", () => {
  assert.match(APP_JS, /e\.key !== "Escape" \|\| e\.defaultPrevented \|\| !isBusy/);
  assert.match(APP_JS, /\.lh-dialog-backdrop/);
  assert.match(APP_JS, /abortActiveGeneration\(\);\s*\}\);/);
});

test("composer: programmatic prompt fills (tutor dashboard, suggestion chips) refresh the Send state", () => {
  assert.match(read("tutor-dashboard.js"), /input\.value = prompt; input\.dispatchEvent\(new Event\("input"/);
  assert.match(APP_JS, /input\.value = item\.prompt;\s*autoResizeComposer\(\);\s*updateComposerState\(\);/);
});

// ---- Step 5: scrolling -----------------------------------------------------------

test("scrolling: following a stream stops on any deliberate upward scroll (wheel, touch, scrollbar) and resumes at the very bottom", () => {
  assert.match(APP_JS, /return !userScrolledUp && isNearBottom\(\);/);
  assert.match(APP_JS, /chatBox\.addEventListener\("wheel", \(e\) => \{\s*if \(e\.deltaY < 0\) userScrolledUp = true;/);
  assert.match(APP_JS, /chatBox\.addEventListener\("touchmove"/);
  assert.match(APP_JS, /chatBox\.addEventListener\("pointerdown"/);
  assert.match(APP_JS, /scrollHeight - chatBox\.scrollTop - chatBox\.clientHeight < 4\) userScrolledUp = false/);
});

test("scrolling: both addMessage and live streaming use shouldFollowStream (never the plain near-bottom check)", () => {
  assert.equal((APP_JS.match(/const shouldStick = shouldFollowStream\(\);/g) || []).length, 2);
});

test("scrolling: the jump button updates when content grows (no scroll event) and is instant while streaming", () => {
  assert.match(APP_JS, /Content grew without any scroll event[\s\S]*?updateScrollButton\(\);/);
  assert.match(APP_JS, /behavior: isBusy \? "instant" : "smooth"/);
});

test("scrolling: sending a message always brings it into view and resumes following", () => {
  assert.match(APP_JS, /userScrolledUp = false;\s*addMessage\("user", message[\s\S]*?scrollChatToBottom\(\);/);
});

test("scrolling: the jump control is a labelled round arrow button, hidden by default", () => {
  const html = read("index.html");
  assert.match(html, /id="scroll-to-bottom-btn"[^>]*aria-label="Jump to latest message"[^>]*hidden/);
  assert.match(STYLES_CSS, /\.scroll-to-bottom-btn\{[^}]*width:\s*40px;[^}]*height:\s*40px;[^}]*border-radius:\s*var\(--radius-full\)/);
});

// ---- Step 6: states ----------------------------------------------------------------

const vm = require("node:vm");

function loadErrorHelpers(offline) {
  const start = APP_JS.indexOf("const GENERIC_CHAT_ERROR");
  const end = APP_JS.indexOf("function renderErrorBlock");
  assert.ok(start > -1 && end > start, "error helpers not found in app.js");
  const ctx = vm.createContext({ isOffline: () => Boolean(offline) });
  vm.runInContext(APP_JS.slice(start, end) + "\nthis.api = { describeChatError, isClientFault, storedErrorText, GENERIC_CHAT_ERROR };", ctx);
  return ctx.api;
}

test("errors: every failure maps to one friendly sentence - never a raw status or stack text", () => {
  const e = loadErrorHelpers(false);
  const cases = [
    [{ status: 429 }, /too quickly/],
    [{ status: 401 }, /Sign in again/],
    [{ status: 403 }, /Sign in again/],
    [{ status: 400 }, /too long/],
    [{ status: 413 }, /too long/],
    [{ status: 500 }, /AI service ran into a problem/],
    [{ status: 503 }, /AI service ran into a problem/],
    [{ serverMessage: "❌ The request took too long and was stopped." }, /took too long and was stopped/],
    [{ serverMessage: "❌ Model is overloaded right now." }, /^Model is overloaded right now\.$/],
    [{ serverMessage: "x".repeat(300) }, /AI service ran into a problem/],
    [new TypeError("Failed to fetch"), /Couldn't reach the AI service/],
    [null, /Couldn't reach the AI service/]
  ];
  cases.forEach(([err, pattern]) => {
    const text = e.describeChatError(err);
    assert.match(text, pattern);
    assert.doesNotMatch(text, /Server responded|TypeError|Failed to fetch|undefined|\bat \w+\(/);
  });
});

test("errors: offline always reads as an offline message, whatever the underlying error was", () => {
  const e = loadErrorHelpers(true);
  assert.match(e.describeChatError({ status: 500 }), /You're offline/);
  assert.match(e.describeChatError(new TypeError("Failed to fetch")), /You're offline/);
});

test("errors: the non-streaming fallback is skipped for request-level faults (incl. 429) but not for outages", () => {
  const e = loadErrorHelpers(false);
  [400, 401, 403, 404, 413, 422, 429].forEach((status) => assert.equal(e.isClientFault({ status }), true));
  [500, 502, 503, undefined].forEach((status) => assert.equal(e.isClientFault({ status }), false));
});

test("errors: legacy stored failures show the generic message instead of the old raw string", () => {
  const e = loadErrorHelpers(false);
  assert.equal(e.storedErrorText("❌ Error connecting to AI: Server responded 500"), e.GENERIC_CHAT_ERROR);
  assert.equal(e.storedErrorText(""), e.GENERIC_CHAT_ERROR);
  assert.equal(e.storedErrorText("You're offline. Check your connection, then try again."), "You're offline. Check your connection, then try again.");
});

test("errors: failures render inside the reply bubble with an inline Retry; a reply that already started is never silently re-generated", () => {
  assert.match(APP_JS, /renderErrorBlock\(aiBubble\.contentEl, friendly, true\)/);
  assert.match(APP_JS, /retry\.classList\.add\("chat-error-retry", "has-label"\)/);
  assert.match(APP_JS, /if \(!aiBubble\.rawText && !isClientFault\(err\)\)/);
  assert.doesNotMatch(APP_JS, /Error connecting to AI: " \+/);
  assert.match(APP_JS, /renderErrorBlock\(contentEl, storedErrorText\(text\), false\)/);
});

test("offline: the composer swaps its hint for a warning, restores it when back online, and Send/Enter/Retry are blocked", () => {
  assert.match(APP_JS, /composerHintEl\.textContent = "You're offline\. Reconnect to send messages\.";/);
  assert.match(APP_JS, /composerHintEl\.textContent = composerHintDefaultText;/);
  assert.match(STYLES_CSS, /\.composer-hint\.is-offline\{[^}]*color:\s*var\(--warning\)/);
  assert.match(APP_JS, /if \(isOffline\(\)\) \{\s*\/\/ Keep the draft/);
  assert.match(APP_JS, /You're offline\. Reconnect to try again\./);
});

test("typing indicator: three animated dots are shown until the first token arrives", () => {
  assert.match(APP_JS, /indicator\.className = "typing-indicator"/);
  assert.match(STYLES_CSS, /\.typing-indicator \.dot\{[^}]*animation:\s*lh-typing-bounce/);
});

// ---- Step 6: automatic conversation titles ------------------------------------------

test("titles: a short title is derived from the first message (first sentence, no code/links, word-boundary cut)", () => {
  const T = ChatStoreModule.deriveTitleFromMessage;
  assert.equal(T("How do I center a div in CSS?"), "How do I center a div in CSS?");
  assert.equal(T("```js\nconst a = 1\n``` what does this do"), "what does this do");
  assert.equal(T("https://example.com/very/long please summarize it for me"), "please summarize it for me");
  assert.equal(T("Translate the following text to English:\n\nمرحبا كيف حالك"), "Translate the following text to English");
  const long = T("Hello! Can you help me practice English conversation about travel and food please?");
  assert.ok(long.length <= 49, long);
  assert.match(long, /…$/);
  assert.doesNotMatch(long, /\s…$/);
  assert.equal(T("   "), ChatStoreModule.DEFAULT_TITLE);
  assert.equal(T(""), ChatStoreModule.DEFAULT_TITLE);
});

test("titles: Arabic is cut at a word boundary too", () => {
  const original = "اشرح لي الفرق بين الماضي البسيط والماضي المستمر في اللغة الإنجليزية مع أمثلة كثيرة";
  const t = ChatStoreModule.deriveTitleFromMessage(original);
  assert.match(t, /…$/);
  assert.ok(t.length <= 49);
  const kept = t.slice(0, -1);
  assert.ok(original.startsWith(kept), "the title is a prefix of the message");
  assert.equal(original.charAt(kept.length), " ", "the cut falls on a word boundary, not mid-word");
});

test("titles: editing the FIRST message re-derives an automatic title; a manual rename is never overwritten", () => {
  const store = makeStore();
  const conv = store.createConversation().conversation;
  store.saveMessage(conv.id, ChatStoreModule.createMessage("user", "first draft of the question"));
  assert.equal(store.getConversation(conv.id).title, "first draft of the question");
  store.replaceMessages(conv.id, []);
  store.saveMessage(conv.id, ChatStoreModule.createMessage("user", "edited question about verbs"));
  assert.equal(store.getConversation(conv.id).title, "edited question about verbs");

  const second = store.createConversation().conversation;
  store.saveMessage(second.id, ChatStoreModule.createMessage("user", "original"));
  store.renameConversation(second.id, "Mine");
  store.replaceMessages(second.id, []);
  store.saveMessage(second.id, ChatStoreModule.createMessage("user", "rewritten"));
  assert.equal(store.getConversation(second.id).title, "Mine");
});

test("titles: later user messages never change the title", () => {
  const store = makeStore();
  const conv = store.createConversation().conversation;
  store.saveMessage(conv.id, ChatStoreModule.createMessage("user", "the first one"));
  store.saveMessage(conv.id, ChatStoreModule.createMessage("assistant", "a reply"));
  store.saveMessage(conv.id, ChatStoreModule.createMessage("user", "a second question entirely"));
  assert.equal(store.getConversation(conv.id).title, "the first one");
});
