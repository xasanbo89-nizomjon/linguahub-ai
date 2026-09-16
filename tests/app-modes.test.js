"use strict";

// Covers www/app.js's Phase 6 integration with www/mode-ui.js: both real
// source files run together in the same vm sandbox (the same load order as
// index.html - mode-ui.js before app.js), against a single scripted fetch
// that serves GET /api/ai/modes as well as the chat endpoints. Focuses on
// what's new in this phase - request schema (messages array, not a single
// string), mode selector disabling during generation, and mode persistence
// across conversation switches and regenerate/retry. Message actions
// themselves (copy/edit/regenerate mechanics) stay covered by
// tests/app-actions.test.js.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { createFakeElement } = require("./helpers/fakeDom");
const ChatStoreModule = require("../www/chatStore.js");

const APP_SRC = fs.readFileSync(path.join(__dirname, "..", "www", "app.js"), "utf8");
const MODE_UI_SRC = fs.readFileSync(path.join(__dirname, "..", "www", "mode-ui.js"), "utf8");

const REAL_MODES = [
  { id: "general", label: "General AI", description: "A broad assistant.", enabled: true, capability: "chat" },
  { id: "codex", label: "Codex AI", description: "A coding assistant.", enabled: true, capability: "chat" },
  { id: "image", label: "Image AI", description: "Not available in this deployment.", enabled: false, capability: "unavailable" }
];

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
    abort() { if (abortFn) abortFn(); },
    fireActiveConversationChanged(conversation) {
      if (activeConversationChangedHandler) activeConversationChangedHandler(conversation);
    }
  };
}

// A single fetch serving GET /api/ai/modes plus the chat endpoints (always
// resolving via the fallback path, matching the pattern used by
// tests/app-actions.test.js - streaming itself is covered elsewhere).
function makeCombinedFetch({ modes, repliesByLastMessage }) {
  const calls = [];
  const impl = async (url, init) => {
    const urlStr = String(url);
    calls.push({ url: urlStr, init });

    if (urlStr.includes("/api/ai/modes")) {
      return { ok: true, status: 200, json: async () => ({ modes }) };
    }
    if (urlStr.includes("/api/chat/stream")) {
      throw new Error("simulated: use fallback path for these tests");
    }

    const body = JSON.parse((init && init.body) || "{}");
    const lastMessage = Array.isArray(body.messages) && body.messages.length
      ? body.messages[body.messages.length - 1].content
      : "";
    let reply = "default reply";
    for (const key of Object.keys(repliesByLastMessage || {})) {
      if (lastMessage.includes(key)) { reply = repliesByLastMessage[key]; break; }
    }
    return { ok: true, status: 200, json: async () => ({ reply }) };
  };
  return { calls, impl };
}

const ELEMENT_IDS = [
  "user-input", "chat-box", "send-btn", "status", "status-dot", "mode-select",
  "conversation-title", "empty-state", "empty-state-cards", "scroll-to-bottom-btn", "settings-btn",
  "login-btn", "logout-btn", "user-profile", "user-avatar",
  "user-avatar-fallback", "user-name", "user-email", "auth-status"
];

async function buildSandbox({ fetchImpl, store }) {
  const elements = {};
  ELEMENT_IDS.forEach((id) => { elements[id] = createFakeElement(id === "mode-select" ? "select" : "div"); });

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
    LinguaHubHistoryUI: historyUIFactory
  };
  sandbox.window = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(MODE_UI_SRC, sandbox, { filename: "mode-ui.js" });
  vm.runInContext(APP_SRC, sandbox, { filename: "app.js" });
  await sandbox.linguahubReady;

  return { sandbox, elements, store, historyUIFactory };
}

function makeStore() {
  return ChatStoreModule.createChatStore({ storage: createFakeStorage() });
}

test("mode-select is populated from the real GET /api/ai/modes response, with the disabled mode unselectable", async () => {
  const store = makeStore();
  const { impl } = makeCombinedFetch({ modes: REAL_MODES, repliesByLastMessage: {} });
  const { elements } = await buildSandbox({ fetchImpl: impl, store });

  const options = elements["mode-select"].children;
  assert.equal(options.length, 3);
  const imageOption = options.find((o) => o.value === "image");
  assert.equal(imageOption.disabled, true);
  assert.equal(elements["mode-select"].value, "general");
});

test("sending a message posts a messages array containing the full conversation, not a single string", async () => {
  const store = makeStore();
  const { impl, calls } = makeCombinedFetch({ modes: REAL_MODES, repliesByLastMessage: { Hello: "hi there" } });
  const { sandbox, elements } = await buildSandbox({ fetchImpl: impl, store });

  elements["user-input"].value = "Hello";
  await sandbox.sendMessage();

  const chatCall = calls.find((c) => c.url.includes("/api/chat") && !c.url.includes("/stream") && !c.url.includes("/modes"));
  assert.ok(chatCall);
  const body = JSON.parse(chatCall.init.body);
  assert.equal(body.message, undefined, "the legacy single-string field must not be sent");
  assert.ok(Array.isArray(body.messages));
  assert.equal(body.messages[body.messages.length - 1].content, "Hello");
  assert.equal(body.messages[body.messages.length - 1].role, "user");
  assert.equal(body.mode, "general");
});

test("a second message includes the first turn's full history in the outgoing messages array", async () => {
  const store = makeStore();
  const { impl, calls } = makeCombinedFetch({
    modes: REAL_MODES,
    repliesByLastMessage: { first: "reply one", second: "reply two" }
  });
  const { sandbox, elements } = await buildSandbox({ fetchImpl: impl, store });

  elements["user-input"].value = "first message";
  await sandbox.sendMessage();
  elements["user-input"].value = "second message";
  await sandbox.sendMessage();

  const secondChatCall = calls.filter((c) => c.url.includes("/api/chat") && !c.url.includes("/stream") && !c.url.includes("/modes")).pop();
  const body = JSON.parse(secondChatCall.init.body);
  // user1, assistant1, user2 - the accumulated conversation, in order.
  assert.equal(body.messages.length, 3);
  assert.equal(body.messages[0].content, "first message");
  assert.equal(body.messages[1].content, "reply one");
  assert.equal(body.messages[2].content, "second message");
});

test("switching the mode before sending is reflected in the request body's mode field", async () => {
  const store = makeStore();
  const { impl, calls } = makeCombinedFetch({ modes: REAL_MODES, repliesByLastMessage: {} });
  const { sandbox, elements } = await buildSandbox({ fetchImpl: impl, store });

  elements["mode-select"].value = "codex";
  elements["user-input"].value = "explain this";
  await sandbox.sendMessage();

  const chatCall = calls.find((c) => c.url.includes("/api/chat") && !c.url.includes("/stream") && !c.url.includes("/modes"));
  const body = JSON.parse(chatCall.init.body);
  assert.equal(body.mode, "codex");
});

test("the mode selector is disabled while a generation is in-flight and re-enabled once it settles", async () => {
  const store = makeStore();
  const calls = [];
  const hangingFetch = (url, init) => {
    const urlStr = String(url);
    calls.push({ url: urlStr, init });
    if (urlStr.includes("/api/ai/modes")) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ modes: REAL_MODES }) });
    }
    if (urlStr.includes("/api/chat/stream")) {
      // Never resolves on its own - only the abort below settles it,
      // simulating a generation stopped mid-flight (same technique as
      // tests/frontend-auth.test.js's logout-abort test).
      return new Promise((resolve, reject) => {
        if (init.signal) {
          init.signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ reply: "settled" }) });
  };

  const { sandbox, elements } = await buildSandbox({ fetchImpl: hangingFetch, store });
  elements["user-input"].value = "count to a million";

  assert.equal(elements["mode-select"].disabled, false);
  const sendPromise = sandbox.sendMessage();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(elements["mode-select"].disabled, true, "mode must be locked during an active generation");

  sandbox.abortActiveGeneration();
  await sendPromise;
  assert.equal(elements["mode-select"].disabled, false, "mode must be unlocked again once generation ends");
});

test("regenerate reuses the conversation's stored mode, not whatever the selector currently shows", async () => {
  const store = makeStore();
  const { impl, calls } = makeCombinedFetch({ modes: REAL_MODES, repliesByLastMessage: { Hello: "first reply" } });
  const { sandbox, elements } = await buildSandbox({ fetchImpl: impl, store });

  elements["mode-select"].value = "codex";
  elements["user-input"].value = "Hello";
  await sandbox.sendMessage();

  // Simulate switching the selector to a different mode afterward, as if
  // the user is about to start a new message in a different mode - this
  // must NOT affect a regenerate of the earlier reply.
  elements["mode-select"].value = "general";

  const conversationId = store.getActiveConversationId();
  const aiWrapper = elements["chat-box"].children.find((c) => c.dataset && c.dataset.role === "assistant");
  const regenBtn = aiWrapper.querySelectorAll(".message-action-btn").find((b) => b.dataset.action === "regenerate");
  regenBtn.click();
  await new Promise((r) => setTimeout(r, 20));

  const regenCall = calls.filter((c) => c.url.includes("/api/chat") && !c.url.includes("/stream") && !c.url.includes("/modes")).pop();
  const body = JSON.parse(regenCall.init.body);
  assert.equal(body.mode, "codex", "regenerate must use the conversation's saved mode, not the selector's current value");

  const conversation = store.getConversation(conversationId);
  assert.equal(conversation.metadata.mode, "codex");
});

test("restoring a conversation reselects its saved (still-enabled) mode", async () => {
  const store = makeStore();
  const { impl } = makeCombinedFetch({ modes: REAL_MODES, repliesByLastMessage: {} });
  const { sandbox, elements, historyUIFactory } = await buildSandbox({ fetchImpl: impl, store });

  const otherConversation = store.createConversation().conversation;
  store.updateConversation(otherConversation.id, { metadata: { mode: "codex" } });
  store.saveMessage(otherConversation.id, ChatStoreModule.createMessage("user", "hi", "complete"));

  historyUIFactory.fireActiveConversationChanged(store.getConversation(otherConversation.id));

  assert.equal(elements["mode-select"].value, "codex");
});

test("restoring a conversation whose saved mode is disabled leaves the selector on its current (selectable) value", async () => {
  const store = makeStore();
  const { impl } = makeCombinedFetch({ modes: REAL_MODES, repliesByLastMessage: {} });
  const { elements, store: builtStore, historyUIFactory } = await buildSandbox({ fetchImpl: impl, store });

  const conversation = builtStore.createConversation().conversation;
  // Force-write a disabled mode directly (bypassing normalizeModeId's
  // migration path, which only rewrites legacy labels, not disabled ids).
  builtStore.updateConversation(conversation.id, { metadata: { mode: "image" } });

  elements["mode-select"].value = "general";
  historyUIFactory.fireActiveConversationChanged(builtStore.getConversation(conversation.id));

  assert.equal(elements["mode-select"].value, "general", "must not switch to a disabled/unavailable mode");
});
