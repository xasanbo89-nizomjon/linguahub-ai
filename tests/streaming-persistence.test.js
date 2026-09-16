"use strict";

// Verifies that www/app.js persists the assistant's streamed response into
// www/chatStore.js correctly: throttled while tokens are arriving (never
// once per token), flushed to a final "complete" state when the stream
// ends, and converted to "stopped" with the partial content preserved when
// generation is aborted mid-stream. Runs the real app.js/chatStore.js
// source via Node's built-in vm module - no jsdom/browser dependency.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const APP_SRC = fs.readFileSync(path.join(__dirname, "..", "www", "app.js"), "utf8");
const ChatStoreModule = require("../www/chatStore.js");
const { createFakeElement } = require("./helpers/fakeDom");

function createFakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    key: (i) => Array.from(map.keys())[i] || null,
    get length() { return map.size; }
  };
}

function makeFakeAuth() {
  return {
    isAvailable: () => false,
    getCurrentUser: () => null,
    getIdToken: async () => null,
    completeRedirectSignIn: async () => null,
    onAuthStateChanged: (cb) => { cb(null); return () => {}; },
    signInWithGoogle: async () => null,
    signOutUser: async () => {}
  };
}

// A minimal, real (not reimplemented) stand-in for history-ui.js's public
// surface, backed by the genuine chatStore.js repository.
function createFakeHistoryUI(store) {
  let activeConversationChangedHandler = null;
  let abortFn = null;
  return {
    init() {
      return {
        store,
        onActiveConversationChanged(h) { activeConversationChangedHandler = h; },
        registerAbortActiveGeneration(fn) { abortFn = fn; },
        refreshList() {},
        setHistoryStatus() {},
        setUser() {},
        start() {
          const result = store.createConversation();
          if (activeConversationChangedHandler) activeConversationChangedHandler(result.conversation);
        }
      };
    },
    abort() { if (abortFn) abortFn(); }
  };
}

// Builds a fake streaming Response whose reader yields the given SSE
// "data: {...}\n\n" chunks with a delay between each, so throttling has
// real wall-clock time to matter, plus a fake AbortSignal wiring so the
// test can cancel it mid-stream like a real fetch would.
function makeStreamingFetch(deltas, { chunkDelayMs = 5, holdAfterIndex = null } = {}) {
  const calls = [];
  const impl = (url, init) => {
    calls.push({ url: String(url), init });
    if (!String(url).includes("/api/chat/stream")) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ reply: "fallback" }) });
    }

    let cancelled = false;
    if (init.signal) {
      init.signal.addEventListener("abort", () => { cancelled = true; });
    }

    let index = 0;
    const reader = {
      read: () => new Promise((resolve, reject) => {
        const emitNext = () => {
          if (cancelled) {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
            return;
          }
          if (index >= deltas.length) {
            resolve({ done: true, value: undefined });
            return;
          }
          const chunk = `data: ${JSON.stringify({ delta: deltas[index] })}\n\n`;
          index += 1;
          resolve({ done: false, value: new TextEncoder().encode(chunk) });
        };

        if (holdAfterIndex !== null && index === holdAfterIndex) {
          // Never resolves on its own past this point - only abort() can
          // settle it, simulating a generation stopped mid-stream.
          if (init.signal) {
            init.signal.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          }
          return;
        }
        setTimeout(emitNext, chunkDelayMs);
      })
    };

    return Promise.resolve({
      ok: true,
      status: 200,
      body: { getReader: () => reader }
    });
  };
  return { calls, impl };
}

function makeFakeModeUI() {
  const modes = [
    { id: "general", label: "General AI", description: "", enabled: true, capability: "chat" },
    { id: "codex", label: "Codex AI", description: "", enabled: true, capability: "chat" }
  ];
  return {
    async init() { return { modes, usedFallback: false }; },
    getPromptSuggestions: () => [],
    isSelectableMode: (list, id) => (list || modes).some((m) => m.id === id && m.enabled)
  };
}

async function buildSandbox({ fetchImpl, store }) {
  const ids = [
    "user-input", "chat-box", "send-btn", "status", "status-dot", "mode-select",
    "conversation-title", "empty-state", "empty-state-cards", "scroll-to-bottom-btn", "settings-btn",
    "login-btn", "logout-btn", "user-profile", "user-avatar",
    "user-avatar-fallback", "user-name", "user-email", "auth-status"
  ];
  const elements = {};
  ids.forEach((id) => { elements[id] = createFakeElement(); });
  elements["mode-select"].value = "general";
  elements["mode-select"].options = [{ value: "general" }, { value: "codex" }];

  const bodyEl = createFakeElement("body");
  const document = {
    getElementById: (id) => elements[id],
    createElement: (tag) => createFakeElement(tag),
    body: bodyEl
  };

  const historyUIFactory = createFakeHistoryUI(store);

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    fetch: fetchImpl,
    document,
    AbortController,
    AbortSignal,
    TextDecoder,
    navigator: { clipboard: { writeText: async () => {} } },
    LINGUAHUB_CONFIG: { apiUrl: (p) => `http://127.0.0.1:3000${p}` },
    LinguaHubAuth: makeFakeAuth(),
    LinguaHubChatStore: ChatStoreModule,
    LinguaHubHistoryUI: historyUIFactory,
    LinguaHubModeUI: makeFakeModeUI()
  };
  sandbox.window = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(APP_SRC, sandbox, { filename: "app.js" });
  await sandbox.linguahubReady;

  return { sandbox, elements, historyUIFactory };
}

test("streaming persists a throttled, not per-token, sequence of writes and flushes a final 'complete' message", async () => {
  const store = ChatStoreModule.createChatStore({ storage: createFakeStorage() });
  const deltas = Array.from({ length: 15 }, (_, i) => `tok${i} `);
  const { impl } = makeStreamingFetch(deltas, { chunkDelayMs: 5 });

  // Spy on saveMessage to count how many times the assistant message is
  // actually written to storage during the run.
  const originalSaveMessage = store.saveMessage;
  let assistantWriteCount = 0;
  store.saveMessage = function (conversationId, message) {
    if (message.role === "assistant") assistantWriteCount += 1;
    return originalSaveMessage.call(store, conversationId, message);
  };

  const { sandbox, elements } = await buildSandbox({ fetchImpl: impl, store });
  elements["user-input"].value = "count please";
  await sandbox.sendMessage();

  const conversationId = store.getActiveConversationId();
  const conversation = store.getConversation(conversationId);
  const assistantMsg = conversation.messages.find((m) => m.role === "assistant");

  assert.ok(assistantMsg, "assistant message should be persisted");
  assert.equal(assistantMsg.status, "complete");
  assert.equal(assistantMsg.content, deltas.join(""));

  // 15 deltas arriving 5ms apart span ~75ms - well under one 400ms throttle
  // window - so the assistant message should have been written far fewer
  // times than once per delta (the initial "streaming" placeholder save,
  // plus the final flush/complete save - not 15 separate writes).
  assert.ok(
    assistantWriteCount < deltas.length,
    `expected throttled writes (< ${deltas.length}), got ${assistantWriteCount}`
  );
  assert.ok(assistantWriteCount >= 1);
});

test("aborting mid-stream persists the partial content with status 'stopped', not 'streaming' or lost", async () => {
  const store = ChatStoreModule.createChatStore({ storage: createFakeStorage() });
  const deltas = ["Hello", " world", " this", " keeps", " going", " forever"];
  // A generous delay/wait ratio (2ms per chunk, 150ms wait for 3 chunks =
  // ~144ms of slack) keeps this deterministic under CI/system load instead
  // of flaking on a tight timing margin.
  const { impl } = makeStreamingFetch(deltas, { chunkDelayMs: 2, holdAfterIndex: 3 });

  const { sandbox, elements, historyUIFactory } = await buildSandbox({ fetchImpl: impl, store });
  elements["user-input"].value = "keep counting";

  const sendPromise = sandbox.sendMessage();
  // Let the first 3 deltas arrive, then abort - simulating the user
  // deleting/clearing/switching away from the conversation mid-generation.
  await new Promise((r) => setTimeout(r, 150));
  historyUIFactory.abort();
  await sendPromise;

  const conversationId = store.getActiveConversationId();
  const conversation = store.getConversation(conversationId);
  const assistantMsg = conversation.messages.find((m) => m.role === "assistant");

  assert.ok(assistantMsg);
  assert.equal(assistantMsg.status, "stopped");
  assert.equal(assistantMsg.content, "Hello world this");
  assert.notEqual(assistantMsg.status, "streaming", "must never be left permanently streaming");
});

// Regression test (Phase 7): a real browser storage test found that
// stopping generation before any delta arrived left the assistant message
// with empty content - chatStore.saveMessage() rejects empty-content
// messages by design, so it silently never persisted at all. The DOM
// showed a friendly "(Stopped - no response received)" placeholder for
// that session only; after a reload the whole assistant turn had vanished,
// leaving no record it was ever attempted.
test("stopping generation before any content arrives still persists a real (placeholder) message, not nothing", async () => {
  const store = ChatStoreModule.createChatStore({ storage: createFakeStorage() });
  const deltas = ["never", "arrives"];
  const { impl } = makeStreamingFetch(deltas, { chunkDelayMs: 2, holdAfterIndex: 0 });

  const { sandbox, elements, historyUIFactory } = await buildSandbox({ fetchImpl: impl, store });
  elements["user-input"].value = "stop before anything arrives";

  const sendPromise = sandbox.sendMessage();
  await new Promise((r) => setTimeout(r, 20));
  historyUIFactory.abort();
  await sendPromise;

  const conversationId = store.getActiveConversationId();
  const conversation = store.getConversation(conversationId);
  const assistantMsg = conversation.messages.find((m) => m.role === "assistant");

  assert.ok(assistantMsg, "the assistant turn must still be persisted, even with no real content");
  assert.equal(assistantMsg.status, "stopped");
  assert.match(assistantMsg.content, /stopped/i);
});

// Regression test (Phase 7): a real browser storage test found the header
// title (#conversation-title) stayed stuck on "New Chat" after sending the
// first message in a new conversation - chatStore auto-derives a real
// title on that first save, and the sidebar picked it up via refreshList(),
// but nothing updated the separate header element until the user switched
// conversations or reloaded.
test("the header title updates immediately once the first message auto-derives a real conversation title", async () => {
  const store = ChatStoreModule.createChatStore({ storage: createFakeStorage() });
  const deltas = ["hi"];
  const { impl } = makeStreamingFetch(deltas, { chunkDelayMs: 2 });

  const { sandbox, elements } = await buildSandbox({ fetchImpl: impl, store });
  elements["user-input"].value = "this becomes the title";
  await sandbox.sendMessage();

  const conversationId = store.getActiveConversationId();
  const persistedTitle = store.getConversation(conversationId).title;
  assert.equal(persistedTitle, "this becomes the title");
  assert.equal(elements["conversation-title"].textContent, persistedTitle);
});

test("the user message and the assistant message are both saved to the active conversation, in order, with no duplicates", async () => {
  const store = ChatStoreModule.createChatStore({ storage: createFakeStorage() });
  const deltas = ["OK"];
  const { impl } = makeStreamingFetch(deltas, { chunkDelayMs: 2 });

  const { sandbox, elements } = await buildSandbox({ fetchImpl: impl, store });
  elements["user-input"].value = "say ok";
  await sandbox.sendMessage();

  const conversationId = store.getActiveConversationId();
  const messages = store.getConversation(conversationId).messages;
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].content, "say ok");
  assert.equal(messages[1].role, "assistant");
  assert.equal(messages[1].content, "OK");

  const ids = messages.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, "no duplicate message ids");
});
