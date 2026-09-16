"use strict";

// Covers www/chatStore.js's Phase 6 addition: transparent migration of a
// conversation's stored mode from the old free-text display label
// ("General AI") to the new stable id ("general") used by the backend
// registry (lib/aiModes.js), on read, write, and creation.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const ChatStoreModule = require("../www/chatStore.js");

function createFakeStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    key: (i) => Array.from(map.keys())[i] || null,
    get length() { return map.size; }
  };
}

function makeStore(storage) {
  return ChatStoreModule.createChatStore({ storage: storage || createFakeStorage() });
}

test("normalizeModeId maps every legacy display label to its stable id", () => {
  assert.equal(ChatStoreModule.normalizeModeId("General AI"), "general");
  assert.equal(ChatStoreModule.normalizeModeId("Codex AI"), "codex");
  assert.equal(ChatStoreModule.normalizeModeId("Cyber AI"), "cyber");
  assert.equal(ChatStoreModule.normalizeModeId("Deep Thinking"), "deep-thinking");
  assert.equal(ChatStoreModule.normalizeModeId("Image AI"), "image");
  assert.equal(ChatStoreModule.normalizeModeId("Voice AI"), "voice");
  assert.equal(ChatStoreModule.normalizeModeId("Web Search"), "web-search");
});

test("normalizeModeId passes a stable id straight through unchanged", () => {
  assert.equal(ChatStoreModule.normalizeModeId("general"), "general");
  assert.equal(ChatStoreModule.normalizeModeId("codex"), "codex");
});

test("normalizeModeId falls back to the default for missing/empty/non-string input", () => {
  assert.equal(ChatStoreModule.normalizeModeId(undefined), ChatStoreModule.DEFAULT_MODE_ID);
  assert.equal(ChatStoreModule.normalizeModeId(null), ChatStoreModule.DEFAULT_MODE_ID);
  assert.equal(ChatStoreModule.normalizeModeId(""), ChatStoreModule.DEFAULT_MODE_ID);
  assert.equal(ChatStoreModule.normalizeModeId("   "), ChatStoreModule.DEFAULT_MODE_ID);
  assert.equal(ChatStoreModule.normalizeModeId(42), ChatStoreModule.DEFAULT_MODE_ID);
});

test("a brand-new conversation defaults to the stable 'general' id, not the old display label", () => {
  const store = makeStore();
  const conversation = store.createConversation().conversation;
  assert.equal(conversation.metadata.mode, "general");
});

test("createEmptyConversation({ mode }) normalizes a legacy label passed directly", () => {
  const conversation = ChatStoreModule.createEmptyConversation({ mode: "Codex AI" });
  assert.equal(conversation.metadata.mode, "codex");
});

test("a conversation persisted under the old schema (mode: 'General AI') reads back as 'general'", () => {
  const storage = createFakeStorage();
  const store = makeStore(storage);
  const created = store.createConversation().conversation;

  // Simulate a pre-Phase-6 record already sitting in localStorage: patch
  // the raw JSON directly rather than going through today's API, which
  // would never write a legacy label itself.
  const key = ChatStoreModule.storageKeyForNamespace(ChatStoreModule.guestNamespace());
  const raw = JSON.parse(storage.getItem(key));
  raw.conversations[0].metadata = { mode: "Cyber AI" };
  storage.setItem(key, JSON.stringify(raw));

  const reloaded = makeStore(storage).getConversation(created.id);
  assert.equal(reloaded.metadata.mode, "cyber");
});

test("updateConversation normalizes a legacy label written through the public API", () => {
  const store = makeStore();
  const conversation = store.createConversation().conversation;
  const result = store.updateConversation(conversation.id, { metadata: { mode: "Deep Thinking" } });
  assert.equal(result.ok, true);
  assert.equal(result.conversation.metadata.mode, "deep-thinking");
});

test("sanitizeConversation defaults an entirely missing metadata.mode to 'general'", () => {
  const sanitized = ChatStoreModule.sanitizeConversation({ title: "x", messages: [] });
  assert.equal(sanitized.metadata.mode, "general");
});

test("an already-stable but unrecognized future id is passed through as-is (not silently rewritten)", () => {
  // chatStore's job is schema normalization/legacy-label migration only -
  // whether a given stable id is currently enabled/known is the mode
  // selector's concern (www/mode-ui.js), not the storage layer's.
  assert.equal(ChatStoreModule.normalizeModeId("some-future-mode"), "some-future-mode");
});
