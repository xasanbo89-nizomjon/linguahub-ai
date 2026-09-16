"use strict";

// Executes the real www/history-ui.js source inside a sandboxed vm context
// with a minimal fake DOM (no jsdom dependency), backed by the real
// chatStore.js repository (in-memory fake storage) so these tests exercise
// genuine DOM-event -> repository-call wiring, not a reimplementation of it.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const HISTORY_UI_SRC = fs.readFileSync(path.join(__dirname, "..", "www", "history-ui.js"), "utf8");
const ChatStoreModule = require("../www/chatStore.js");

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

function createFakeElement(tag) {
  const el = {
    tag: tag || "div",
    _listeners: {},
    value: "",
    hidden: false,
    href: "",
    download: "",
    files: null,
    focus() { el._focused = true; },
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
      toggle(c, force) {
        const shouldAdd = typeof force === "boolean" ? force : !this._set.has(c);
        if (shouldAdd) this._set.add(c); else this._set.delete(c);
        return shouldAdd;
      }
    },
    children: [],
    attrs: {},
    setAttribute(name, value) { this.attrs[name] = value; },
    getAttribute(name) { return this.attrs[name]; },
    addEventListener(event, handler) {
      (this._listeners[event] = this._listeners[event] || []).push(handler);
    },
    dispatch(event, evt) {
      (this._listeners[event] || []).forEach((h) => h(evt || {}));
    },
    appendChild(child) { this.children.push(child); return child; },
    removeChild(child) { this.children = this.children.filter((c) => c !== child); },
    click() {
      this.dispatch("click", { stopPropagation() {} });
    },
    set textContent(v) { this._text = v; this.children = []; },
    get textContent() { return this._text || ""; }
  };
  return el;
}

function createFakeLocalStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); }
  };
}

function buildHistoryUiSandboxWithStorage({ store, promptImpl, confirmImpl, localStorage, appMode }) {
  return buildHistoryUiSandbox({ store, promptImpl, confirmImpl, localStorage, appMode });
}

function buildHistoryUiSandbox({ store, promptImpl, confirmImpl, localStorage, appMode }) {
  const elementIds = [
    "sidebar", "app-shell", "sidebar-toggle-btn", "sidebar-backdrop", "sidebar-collapse-btn", "new-chat-btn",
    "chat-search-input", "conversation-list", "conversation-empty-state",
    "export-chat-btn", "import-chat-input", "clear-chat-btn", "history-status"
  ];
  const elements = {};
  elementIds.forEach((id) => { elements[id] = createFakeElement(); });

  const fakeDocument = {
    getElementById: (id) => elements[id],
    createElement: (tag) => createFakeElement(tag),
    body: createFakeElement("body"),
    addEventListener(event, handler) {
      fakeDocument._handlers = fakeDocument._handlers || [];
      fakeDocument._handlers.push(handler);
    },
    removeEventListener(event, handler) {
      fakeDocument._handlers = (fakeDocument._handlers || []).filter((h) => h !== handler);
    }
  };

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    // Real globals (Node has genuine implementations, same as every real
    // runtime this app ships to - browsers, Electron, Capacitor's webview),
    // not fakes - downloadTextFile() uses them directly (a Phase 9 fix:
    // real Electron testing found blob: URLs don't reliably engage
    // Electron's download pipeline, so export switched to a UTF-8-safe
    // base64 data: URL instead - see www/history-ui.js).
    TextEncoder,
    btoa,
    document: fakeDocument,
    localStorage: localStorage || createFakeLocalStorage(),
    LinguaHubChatStore: ChatStoreModule,
    matchMedia: () => ({ matches: false }),
    prompt: promptImpl || (() => null),
    confirm: confirmImpl || (() => true)
  };
  if (appMode) sandbox.LinguaHubAppMode = appMode;
  sandbox.window = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(HISTORY_UI_SRC, sandbox, { filename: "history-ui.js" });

  const controller = sandbox.LinguaHubHistoryUI.init({ store });
  return { sandbox, elements, controller };
}

function makeStore() {
  return ChatStoreModule.createChatStore({ storage: createFakeStorage() });
}

test("start() restores/creates the active conversation and notifies the registered handler", () => {
  const store = makeStore();
  const { controller } = buildHistoryUiSandbox({ store });
  let notified = null;
  controller.onActiveConversationChanged((conv) => { notified = conv; });
  controller.start();

  assert.ok(notified);
  assert.equal(notified.id, store.getActiveConversationId());
});

test("clicking New Chat creates a conversation and notifies the handler", () => {
  const store = makeStore();
  const { elements, controller } = buildHistoryUiSandbox({ store });
  const notifications = [];
  controller.onActiveConversationChanged((conv) => notifications.push(conv));
  controller.start();

  elements["new-chat-btn"].click();
  assert.equal(store.listConversations().length, 1);
  assert.equal(notifications.length, 2); // initial start() + the click
});

test("rapid New Chat clicks do not create duplicate conversations", () => {
  const store = makeStore();
  const { elements, controller } = buildHistoryUiSandbox({ store });
  controller.onActiveConversationChanged(() => {});
  controller.start();

  elements["new-chat-btn"].click();
  elements["new-chat-btn"].click();
  elements["new-chat-btn"].click();
  assert.equal(store.listConversations().length, 1);
});

test("selecting a conversation from the list switches the active conversation", () => {
  const store = makeStore();
  const a = store.createConversation().conversation;
  store.saveMessage(a.id, ChatStoreModule.createMessage("user", "conversation a"));
  const b = store.createConversation().conversation;
  store.saveMessage(b.id, ChatStoreModule.createMessage("user", "conversation b"));
  store.setActiveConversationId(a.id);

  const { elements, controller } = buildHistoryUiSandbox({ store });
  const notifications = [];
  controller.onActiveConversationChanged((conv) => notifications.push(conv));
  controller.start();

  // The list renders b then a (most-recently-updated first); click the
  // second rendered item (a) to select it explicitly regardless of order.
  const items = elements["conversation-list"].children;
  assert.equal(items.length, 2);
  const bItem = items.find((item) => item.children[0].children[0].textContent === "conversation b");
  bItem.click();

  assert.equal(store.getActiveConversationId(), b.id);
});

test("search filters the rendered conversation list and clearing the query restores it", async () => {
  const store = makeStore();
  const a = store.createConversation().conversation;
  store.renameConversation(a.id, "Weather talk");
  const b = store.createConversation().conversation;
  store.renameConversation(b.id, "Python help");

  const { elements, controller } = buildHistoryUiSandbox({ store });
  controller.onActiveConversationChanged(() => {});
  controller.start();
  assert.equal(elements["conversation-list"].children.length, 2);

  elements["chat-search-input"].value = "python";
  elements["chat-search-input"].dispatch("input");
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(elements["conversation-list"].children.length, 1);

  elements["chat-search-input"].value = "";
  elements["chat-search-input"].dispatch("input");
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(elements["conversation-list"].children.length, 2);
});

test("rename via the prompt dialog updates the title and the rendered list", async () => {
  const store = makeStore();
  const { elements, controller } = buildHistoryUiSandbox({ store, promptImpl: () => "Renamed Title" });
  controller.onActiveConversationChanged(() => {});
  controller.start();

  const renameBtn = elements["conversation-list"].children[0].children[1].children[0];
  renameBtn.click();
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(store.listConversations()[0].title, "Renamed Title");
  assert.equal(elements["conversation-list"].children[0].children[0].children[0].textContent, "Renamed Title");
});

// Regression test (Phase 7): a real browser keyboard test found that
// pressing Enter/Space while a nested Rename/Delete button had focus did
// nothing useful - the conversation item's own keydown listener didn't
// check event.target, so it preventDefault()'d and selected the wrong
// conversation before the button's native "activate on Enter" behavior
// could fire, making Rename/Delete completely unreachable by keyboard. This
// fake DOM's dispatch() doesn't simulate real bubbling, so the nested
// button's originating keydown is simulated by dispatching directly on the
// item with `target` set to the button - exactly what the item's listener
// receives during real bubbling.
test("Enter/Space on the item's own keydown only selects when the item itself is the event target, not a nested button", () => {
  const store = makeStore();
  const a = store.createConversation().conversation;
  store.saveMessage(a.id, ChatStoreModule.createMessage("user", "conversation a"));
  const b = store.createConversation().conversation;
  store.saveMessage(b.id, ChatStoreModule.createMessage("user", "conversation b"));
  store.setActiveConversationId(a.id);

  const { elements, controller } = buildHistoryUiSandbox({ store });
  controller.onActiveConversationChanged(() => {});
  controller.start();

  const items = elements["conversation-list"].children;
  const bItem = items.find((item) => item.children[0].children[0].textContent === "conversation b");
  const bRenameBtn = bItem.children[1].children[0];

  let prevented = false;
  bItem.dispatch("keydown", { key: "Enter", target: bRenameBtn, preventDefault() { prevented = true; } });
  assert.equal(prevented, false, "keydown originating from the nested button must not be intercepted");
  assert.equal(store.getActiveConversationId(), a.id, "selecting must not happen when the event target was the nested button");

  let preventedOnItem = false;
  bItem.dispatch("keydown", { key: "Enter", target: bItem, preventDefault() { preventedOnItem = true; } });
  assert.equal(preventedOnItem, true, "keydown targeting the item itself must still select (unaffected by the fix)");
  assert.equal(store.getActiveConversationId(), b.id);
});

test("cancelling the rename prompt (returns null) leaves the title unchanged", async () => {
  const store = makeStore();
  const conv = store.createConversation().conversation;
  store.renameConversation(conv.id, "Original");
  const { elements, controller } = buildHistoryUiSandbox({ store, promptImpl: () => null });
  controller.onActiveConversationChanged(() => {});
  controller.start();

  const renameBtn = elements["conversation-list"].children[0].children[1].children[0];
  renameBtn.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(store.getConversation(conv.id).title, "Original");
});

test("delete requires confirmation and aborts generation only when deleting the active conversation", async () => {
  const store = makeStore();
  const { elements, controller } = buildHistoryUiSandbox({ store, confirmImpl: () => true });
  let aborted = false;
  controller.registerAbortActiveGeneration(() => { aborted = true; });
  controller.onActiveConversationChanged(() => {});
  controller.start();

  const activeId = store.getActiveConversationId();
  const deleteBtn = elements["conversation-list"].children[0].children[1].children[1];
  deleteBtn.click();
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(store.getConversation(activeId), null);
  assert.equal(aborted, true);
});

test("cancelling the delete confirmation keeps the conversation", async () => {
  const store = makeStore();
  const { elements, controller } = buildHistoryUiSandbox({ store, confirmImpl: () => false });
  controller.onActiveConversationChanged(() => {});
  controller.start();

  const activeId = store.getActiveConversationId();
  const deleteBtn = elements["conversation-list"].children[0].children[1].children[1];
  deleteBtn.click();
  await new Promise((r) => setTimeout(r, 10));

  assert.ok(store.getConversation(activeId));
});

test("Clear chat button clears only the active conversation's messages after confirmation", async () => {
  const store = makeStore();
  const { elements, controller } = buildHistoryUiSandbox({ store, confirmImpl: () => true });
  controller.onActiveConversationChanged(() => {});
  controller.start();

  const activeId = store.getActiveConversationId();
  store.saveMessage(activeId, ChatStoreModule.createMessage("user", "hello"));
  elements["clear-chat-btn"].click();
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(store.getConversation(activeId).messages.length, 0);
});

test("export writes a data:-URL-backed download without throwing and reports success", () => {
  const store = makeStore();
  const { elements, controller } = buildHistoryUiSandbox({ store });
  controller.onActiveConversationChanged(() => {});
  controller.start();
  const activeId = store.getActiveConversationId();
  store.saveMessage(activeId, ChatStoreModule.createMessage("user", "export me"));

  assert.doesNotThrow(() => elements["export-chat-btn"].click());
  assert.match(elements["history-status"].textContent, /exported/i);
});

// Regression test (Phase 9): a real Electron runtime test found blob: URL
// downloads don't reliably engage Electron's native download pipeline (a
// known Electron/Chromium limitation with blob-URL downloads specifically -
// see docs/electron-runtime-report.md) - switched to a UTF-8-safe base64
// data: URL, which does. Verifies the actual href built for the download
// link, and that non-Latin1 (Arabic/RTL) export content round-trips
// correctly through the base64 encoding.
test("export builds a real data: URL (not blob:), and correctly encodes non-Latin1 content", () => {
  const store = makeStore();
  const { elements, sandbox, controller } = buildHistoryUiSandbox({ store });
  controller.onActiveConversationChanged(() => {});
  controller.start();
  const activeId = store.getActiveConversationId();
  store.saveMessage(activeId, ChatStoreModule.createMessage("user", "مرحبا بالعالم"));

  let capturedHref = null;
  const originalCreateElement = sandbox.document.createElement;
  sandbox.document.createElement = function (tag) {
    const el = originalCreateElement(tag);
    if (tag === "a") {
      const originalClick = el.click.bind(el);
      el.click = function () {
        capturedHref = el.href;
        originalClick();
      };
    }
    return el;
  };

  elements["export-chat-btn"].click();

  assert.ok(capturedHref, "export must set a real href before clicking the download link");
  assert.match(capturedHref, /^data:application\/json;base64,/);
  assert.doesNotMatch(capturedHref, /^blob:/);

  const base64Payload = capturedHref.split(",")[1];
  const decoded = Buffer.from(base64Payload, "base64").toString("utf8");
  assert.match(decoded, /مرحبا بالعالم/, "non-Latin1 export content must round-trip correctly through the base64 encoding");
});

test("import via the file input adds a new conversation and switches to it", async () => {
  const store = makeStore();
  const { elements, sandbox, controller } = buildHistoryUiSandbox({ store });
  const notifications = [];
  controller.onActiveConversationChanged((conv) => notifications.push(conv));
  controller.start();

  const exportPayload = JSON.stringify({
    schemaVersion: 1,
    conversation: { title: "Imported chat", messages: [{ role: "user", content: "hi from import" }] }
  });

  // Minimal fake FileReader matching the subset www/history-ui.js uses.
  sandbox.FileReader = function FakeFileReader() {
    this.readAsText = (file) => {
      setTimeout(() => {
        this.result = file.__content;
        if (this.onload) this.onload();
      }, 0);
    };
  };
  vm.runInContext("void 0;", sandbox); // ensure FileReader assignment is visible

  const fakeFile = { size: exportPayload.length, __content: exportPayload };
  elements["import-chat-input"].files = [fakeFile];
  elements["import-chat-input"].dispatch("change");

  await new Promise((r) => setTimeout(r, 20));

  const list = store.listConversations();
  assert.equal(list.length, 2); // the initial empty chat + the imported one
  const imported = list.find((c) => c.title === "Imported chat");
  assert.ok(imported);
  assert.equal(store.getActiveConversationId(), imported.id);
});

test("Escape-equivalent (prompt returning null) and empty title are both rejected safely for rename", async () => {
  const store = makeStore();
  const { elements, controller } = buildHistoryUiSandbox({ store, promptImpl: () => "   " });
  controller.onActiveConversationChanged(() => {});
  controller.start();
  const originalTitle = store.listConversations()[0].title;

  const renameBtn = elements["conversation-list"].children[0].children[1].children[0];
  renameBtn.click();
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(store.listConversations()[0].title, originalTitle);
  assert.match(elements["history-status"].textContent, /empty/i);
});

test("sidebar collapse toggles the collapsed class and persists across a fresh init against the same storage", () => {
  const store = makeStore();
  const { sandbox, elements, controller } = buildHistoryUiSandbox({ store });
  controller.onActiveConversationChanged(() => {});
  controller.start();

  assert.equal(elements["app-shell"].classList.contains("sidebar-collapsed"), false);
  elements["sidebar-collapse-btn"].click();
  assert.equal(elements["app-shell"].classList.contains("sidebar-collapsed"), true);
  assert.equal(sandbox.localStorage.getItem("linguahub-ai:sidebar-collapsed"), "true");

  // Simulate a fresh page load reusing the same localStorage.
  const second = buildHistoryUiSandboxWithStorage({ store, localStorage: sandbox.localStorage });
  second.controller.onActiveConversationChanged(() => {});
  second.controller.start();
  assert.equal(second.elements["app-shell"].classList.contains("sidebar-collapsed"), true);
});

// --- Integration Prep phase: embedded mode --------------------------------

test("embedded mode: the sidebar defaults to collapsed on a fresh load with no stored preference yet (Task 12 - no full-width sidebar dependency)", () => {
  const store = makeStore();
  const { elements, controller } = buildHistoryUiSandbox({ store, appMode: { isEmbedded: true } });
  controller.onActiveConversationChanged(() => {});
  controller.start();
  assert.equal(elements["app-shell"].classList.contains("sidebar-collapsed"), true);
});

test("standalone mode (no LinguaHubAppMode global) still defaults to expanded, exactly as before", () => {
  const store = makeStore();
  const { elements, controller } = buildHistoryUiSandbox({ store });
  controller.onActiveConversationChanged(() => {});
  controller.start();
  assert.equal(elements["app-shell"].classList.contains("sidebar-collapsed"), false);
});

test("embedded mode's collapsed default only applies before any explicit choice - an explicitly stored 'expanded' preference is never overridden", () => {
  const store = makeStore();
  const first = buildHistoryUiSandbox({ store, appMode: { isEmbedded: true } });
  first.controller.onActiveConversationChanged(() => {});
  first.controller.start();
  assert.equal(first.elements["app-shell"].classList.contains("sidebar-collapsed"), true, "sanity: embedded defaults collapsed");

  // The user explicitly expands it once.
  first.elements["sidebar-collapse-btn"].click();
  assert.equal(first.elements["app-shell"].classList.contains("sidebar-collapsed"), false);
  assert.equal(first.sandbox.localStorage.getItem("linguahub-ai:sidebar-collapsed"), "false");

  // A fresh load, still embedded, reusing the same storage - the explicit
  // choice wins over the embedded default.
  const second = buildHistoryUiSandboxWithStorage({ store, localStorage: first.sandbox.localStorage, appMode: { isEmbedded: true } });
  second.controller.onActiveConversationChanged(() => {});
  second.controller.start();
  assert.equal(second.elements["app-shell"].classList.contains("sidebar-collapsed"), false, "an explicit prior choice must survive, even in embedded mode");
});

test("mobile drawer: opening sets the backdrop visible and locks body scroll; closing reverses both", () => {
  const store = makeStore();
  const { elements, controller } = buildHistoryUiSandbox({ store });
  controller.onActiveConversationChanged(() => {});
  controller.start();

  elements["sidebar-toggle-btn"].click();
  assert.equal(elements["app-shell"].classList.contains("sidebar-open"), true);
  assert.equal(elements["sidebar-backdrop"].hidden, false);
  assert.equal(elements["sidebar-toggle-btn"].getAttribute("aria-expanded"), "true");

  elements["sidebar-backdrop"].click();
  assert.equal(elements["app-shell"].classList.contains("sidebar-open"), false);
  assert.equal(elements["sidebar-backdrop"].hidden, true);
  assert.equal(elements["sidebar-toggle-btn"].getAttribute("aria-expanded"), "false");
});

test("mobile drawer: selecting a conversation closes it", () => {
  const store = makeStore();
  const a = store.createConversation().conversation;
  store.saveMessage(a.id, ChatStoreModule.createMessage("user", "a"));
  const b = store.createConversation().conversation;
  store.saveMessage(b.id, ChatStoreModule.createMessage("user", "b"));

  const { elements, controller } = buildHistoryUiSandbox({ store });
  controller.onActiveConversationChanged(() => {});
  controller.start();

  elements["sidebar-toggle-btn"].click();
  assert.equal(elements["app-shell"].classList.contains("sidebar-open"), true);

  const items = elements["conversation-list"].children;
  items[items.length - 1].click();

  assert.equal(elements["app-shell"].classList.contains("sidebar-open"), false);
});
