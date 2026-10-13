"use strict";

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
    get length() { return map.size; },
    _dump: () => Object.fromEntries(map)
  };
}

function makeStore(storage) {
  return ChatStoreModule.createChatStore({ storage: storage || createFakeStorage() });
}

// ---------------------------------------------------------------------
// Core CRUD
// ---------------------------------------------------------------------

test("creates a conversation and it becomes active", () => {
  const store = makeStore();
  const result = store.createConversation();
  assert.equal(result.ok, true);
  assert.equal(result.conversation.title, "New Chat");
  assert.equal(store.getActiveConversationId(), result.conversation.id);
});

test("restores a conversation from a fresh store instance sharing the same storage", () => {
  const storage = createFakeStorage();
  const store1 = makeStore(storage);
  const created = store1.createConversation().conversation;
  store1.saveMessage(created.id, ChatStoreModule.createMessage("user", "hello there"));

  const store2 = makeStore(storage);
  const restored = store2.getConversation(created.id);
  assert.ok(restored);
  assert.equal(restored.messages.length, 1);
  assert.equal(restored.messages[0].content, "hello there");
});

test("updates a conversation (pin) and preserves other fields", () => {
  const store = makeStore();
  const conv = store.createConversation().conversation;
  const result = store.updateConversation(conv.id, { pinned: true });
  assert.equal(result.ok, true);
  assert.equal(result.conversation.pinned, true);
  assert.equal(result.conversation.title, "New Chat");
});

test("deletes only the selected conversation, preserving the others", () => {
  const store = makeStore();
  const a = store.createConversation().conversation;
  store.saveMessage(a.id, ChatStoreModule.createMessage("user", "conversation a"));
  const b = store.createConversation().conversation; // reused since `a` may still be empty? force non-empty first
  store.saveMessage(b.id, ChatStoreModule.createMessage("user", "conversation b"));

  const before = store.listConversations();
  assert.equal(before.length, 2);

  const delResult = store.deleteConversation(a.id);
  assert.equal(delResult.ok, true);

  const after = store.listConversations();
  assert.equal(after.length, 1);
  assert.equal(after[0].id, b.id);
});

test("clears only the active conversation's messages, leaving other conversations untouched", () => {
  const store = makeStore();
  const a = store.createConversation().conversation;
  store.saveMessage(a.id, ChatStoreModule.createMessage("user", "keep me safe in b"));
  const b = store.createConversation().conversation;
  store.saveMessage(b.id, ChatStoreModule.createMessage("user", "clear me"));

  const result = store.clearConversationMessages(b.id);
  assert.equal(result.ok, true);
  assert.equal(store.getConversation(b.id).messages.length, 0);
  assert.equal(store.getConversation(b.id).title, "New Chat");
  assert.equal(store.getConversation(a.id).messages.length, 1);
});

// ---------------------------------------------------------------------
// Namespacing / isolation
// ---------------------------------------------------------------------

test("guest and user namespaces are isolated from each other", () => {
  const storage = createFakeStorage();
  const store = makeStore(storage);

  store.setUserId(null); // guest
  const guestConv = store.createConversation().conversation;
  store.saveMessage(guestConv.id, ChatStoreModule.createMessage("user", "guest message"));

  store.setUserId("uid-aaa");
  assert.equal(store.listConversations().length, 0, "user namespace must start empty");
  const userConv = store.createConversation().conversation;
  store.saveMessage(userConv.id, ChatStoreModule.createMessage("user", "user aaa message"));

  store.setUserId(null);
  const guestList = store.listConversations();
  assert.equal(guestList.length, 1);
  assert.equal(guestList[0].messages[0].content, "guest message");
});

test("user A cannot see user B's history", () => {
  const storage = createFakeStorage();
  const store = makeStore(storage);

  store.setUserId("user-a");
  const convA = store.createConversation().conversation;
  store.saveMessage(convA.id, ChatStoreModule.createMessage("user", "secret to A"));

  store.setUserId("user-b");
  const bList = store.listConversations();
  assert.equal(bList.length, 0);
  assert.equal(store.getConversation(convA.id), null);
});

// Phase 10, Task 7: importConversationJson() is a method on the
// already-namespace-scoped store instance - there is no code path that
// lets it write to any namespace other than whichever one is currently
// active. This locks that in directly rather than only relying on it
// being true "by construction".
test("imported conversations are added only to the namespace active at import time", () => {
  const storage = createFakeStorage();
  const store = makeStore(storage);

  store.setUserId("user-a");
  const original = store.createConversation().conversation;
  store.saveMessage(original.id, ChatStoreModule.createMessage("user", "user A's own message"));
  const exported = store.exportConversationJson(original.id);
  assert.ok(exported.ok, "sanity check: export should succeed");

  store.setUserId(null); // guest
  const beforeImportGuestCount = store.listConversations().length;
  const importResult = store.importConversationJson(exported.json);
  assert.ok(importResult.ok, "import should succeed");
  assert.equal(store.listConversations().length, beforeImportGuestCount + 1, "the imported conversation lands in the guest namespace (the one active at import time)");

  store.setUserId("user-b");
  assert.equal(store.listConversations().length, 0, "user B must not see a conversation imported while guest was active");

  store.setUserId("user-a");
  assert.equal(store.listConversations().length, 1, "user A's original namespace is unaffected by an import performed while guest was active");
});

test("logout (setUserId(null)) switches visible history back to the guest namespace", () => {
  const storage = createFakeStorage();
  const store = makeStore(storage);
  store.setUserId("uid-1");
  store.createConversation();
  assert.equal(store.getNamespace(), "user:uid-1");

  store.setUserId(null);
  assert.equal(store.getNamespace(), "guest");
  assert.equal(store.listConversations().length, 0);
});

test("uid is sanitized to safe characters when building the namespace key", () => {
  const store = makeStore();
  const ns = store.setUserId("abc-123_XYZ<script>");
  assert.equal(ns, "user:abc-123_XYZscript");
  assert.doesNotMatch(ns, /[<>]/);
});

test("a corrupted namespace does not break other namespaces", () => {
  const storage = createFakeStorage();
  storage.setItem(ChatStoreModule.storageKeyForNamespace("guest"), "{not valid json");
  const store = makeStore(storage);

  store.setUserId("uid-ok");
  const conv = store.createConversation().conversation;
  assert.equal(store.getConversation(conv.id).id, conv.id);

  store.setUserId(null);
  assert.equal(store.listConversations().length, 0, "corrupted guest data recovers to empty, not a crash");
});

// ---------------------------------------------------------------------
// Legacy migration
// ---------------------------------------------------------------------

test("legacy migration preserves data from an old (pre-rename) key", () => {
  const storage = createFakeStorage({
    "xasan-ai-chat-history": JSON.stringify({
      title: "Old chat",
      messages: [
        { role: "user", content: "hi from the old app" },
        { role: "assistant", content: "hello!" }
      ]
    })
  });
  const store = makeStore(storage);
  const result = store.migrateLegacyData();
  assert.equal(result.ok, true);
  assert.equal(result.migrated, 1);

  store.setUserId(null);
  const list = store.listConversations();
  assert.equal(list.length, 1);
  assert.equal(list[0].messages.length, 2);
  assert.equal(list[0].messages[0].content, "hi from the old app");
});

test("legacy migration does not duplicate on repeated calls", () => {
  const storage = createFakeStorage({
    "hasan-ai-history": JSON.stringify([{ role: "user", content: "only once" }])
  });
  const store = makeStore(storage);
  store.migrateLegacyData();
  store.migrateLegacyData();
  store.migrateLegacyData();

  store.setUserId(null);
  assert.equal(store.listConversations().length, 1);
});

test("legacy migration with no matching keys is a safe no-op", () => {
  const store = makeStore();
  const result = store.migrateLegacyData();
  assert.equal(result.ok, true);
  assert.equal(result.migrated, 0);
});

// ---------------------------------------------------------------------
// Corruption / quota / streaming recovery
// ---------------------------------------------------------------------

test("corrupted JSON in the active namespace recovers to an empty, usable state", () => {
  const storage = createFakeStorage();
  storage.setItem(ChatStoreModule.storageKeyForNamespace("guest"), "not json at all {{{");
  const store = makeStore(storage);
  assert.deepEqual(store.listConversations(), []);
  const result = store.createConversation();
  assert.equal(result.ok, true);
});

test("quota-exceeded errors are handled by pruning old unpinned conversations and retrying, never crashing", () => {
  const storage = createFakeStorage();
  const store = makeStore(storage);

  // Build up several real, unpinned conversations first so there is
  // something prunable once quota errors start.
  const ids = [];
  for (let i = 0; i < 5; i += 1) {
    const conv = store.createConversation().conversation;
    store.saveMessage(conv.id, ChatStoreModule.createMessage("user", `message ${i}`));
    ids.push(conv.id);
  }

  // From now on, every write fails once with a quota error before
  // succeeding - simulates the store needing to prune-and-retry.
  const originalSetItem = storage.setItem.bind(storage);
  let failNext = true;
  storage.setItem = (k, v) => {
    if (failNext) {
      failNext = false;
      const err = new Error("quota");
      err.name = "QuotaExceededError";
      throw err;
    }
    failNext = true;
    return originalSetItem(k, v);
  };

  const result = store.createConversation();
  assert.equal(result.ok, true, "creation must succeed by pruning an old conversation, not fail outright");
  store.saveMessage(result.conversation.id, ChatStoreModule.createMessage("user", "new message after pruning"));

  // The oldest unpinned conversation should have been evicted to make room.
  assert.equal(store.getConversation(ids[0]), null, "oldest unpinned conversation should have been pruned");
  assert.ok(store.listConversations().length >= 1);
});

test("quota errors that never succeed are reported honestly, not looped forever", () => {
  const storage = createFakeStorage();
  storage.setItem = () => {
    const err = new Error("quota");
    err.name = "QuotaExceededError";
    throw err;
  };
  const store = makeStore(storage);
  const result = store.createConversation();
  assert.equal(result.ok, false);
  assert.equal(result.reason, "quota-exceeded");
});

test("a message restored with status 'streaming' is converted to 'stopped', never left streaming after a reload", () => {
  const storage = createFakeStorage();
  const key = ChatStoreModule.storageKeyForNamespace("guest");
  storage.setItem(key, JSON.stringify({
    schemaVersion: 1,
    activeConversationId: "conv_1",
    conversations: [{
      id: "conv_1",
      title: "Interrupted",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [
        { id: "m1", role: "user", content: "count to 10", createdAt: new Date().toISOString(), status: "complete" },
        { id: "m2", role: "assistant", content: "1, 2, 3", createdAt: new Date().toISOString(), status: "streaming" }
      ]
    }]
  }));

  const store = makeStore(storage);
  const conv = store.getConversation("conv_1");
  assert.equal(conv.messages[1].status, "stopped");
  assert.equal(conv.messages[1].content, "1, 2, 3", "partial content is preserved");
});

test("storage limits (max conversations) are enforced", () => {
  const store = makeStore();
  const originalMax = ChatStoreModule.LIMITS.maxConversations;
  // Exercise the real limit at a small scale by creating up to it plus a
  // couple more, using the module's actual configured limit.
  for (let i = 0; i < originalMax + 5; i += 1) {
    const conv = store.createConversation().conversation;
    store.saveMessage(conv.id, ChatStoreModule.createMessage("user", `msg ${i}`));
  }
  assert.ok(store.listConversations().length <= originalMax);
});

// ---------------------------------------------------------------------
// New Chat behavior
// ---------------------------------------------------------------------

test("New Chat creates exactly one conversation", () => {
  const store = makeStore();
  store.createConversation();
  assert.equal(store.listConversations().length, 1);
});

test("rapid New Chat clicks do not create duplicate empty conversations", () => {
  const store = makeStore();
  const first = store.createConversation();
  const second = store.createConversation();
  const third = store.createConversation();
  assert.equal(store.listConversations().length, 1);
  assert.equal(first.conversation.id, second.conversation.id);
  assert.equal(second.conversation.id, third.conversation.id);
  assert.equal(second.reused, true);
});

test("New Chat after sending a message creates a genuinely new, separate conversation", () => {
  const store = makeStore();
  const first = store.createConversation().conversation;
  store.saveMessage(first.id, ChatStoreModule.createMessage("user", "not empty anymore"));
  const second = store.createConversation();
  assert.equal(second.reused, false);
  assert.equal(store.listConversations().length, 2);
});

// ---------------------------------------------------------------------
// Auto title / rename
// ---------------------------------------------------------------------

test("auto title is derived from the first user message", () => {
  const store = makeStore();
  const conv = store.createConversation().conversation;
  store.saveMessage(conv.id, ChatStoreModule.createMessage("user", "  How do I center a div in CSS?  "));
  assert.equal(store.getConversation(conv.id).title, "How do I center a div in CSS?");
});

test("manual rename is preserved and is not overwritten by later auto-title logic", () => {
  const store = makeStore();
  const conv = store.createConversation().conversation;
  store.renameConversation(conv.id, "My custom title");
  store.saveMessage(conv.id, ChatStoreModule.createMessage("user", "this should not become the title"));
  assert.equal(store.getConversation(conv.id).title, "My custom title");
});

test("rename rejects an empty/whitespace-only title", () => {
  const store = makeStore();
  const conv = store.createConversation().conversation;
  const result = store.renameConversation(conv.id, "   ");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "empty-title");
});

test("Unicode and Arabic titles are preserved correctly", () => {
  const store = makeStore();
  const conv = store.createConversation().conversation;
  const arabic = "مرحبا كيف حالك اليوم";
  store.renameConversation(conv.id, arabic);
  assert.equal(store.getConversation(conv.id).title, arabic);
});

test("delete selects a fallback conversation when the active one is removed", () => {
  const store = makeStore();
  const a = store.createConversation().conversation;
  store.saveMessage(a.id, ChatStoreModule.createMessage("user", "a"));
  const b = store.createConversation().conversation;
  store.saveMessage(b.id, ChatStoreModule.createMessage("user", "b"));
  store.setActiveConversationId(b.id);

  const result = store.deleteConversation(b.id);
  assert.equal(result.ok, true);
  assert.equal(result.activeConversationId, a.id);
});

test("sort order: pinned conversations first, then most recently updated", async () => {
  const store = makeStore();
  const a = store.createConversation().conversation;
  store.saveMessage(a.id, ChatStoreModule.createMessage("user", "a"));
  await new Promise((r) => setTimeout(r, 5));
  const b = store.createConversation().conversation;
  store.saveMessage(b.id, ChatStoreModule.createMessage("user", "b"));
  store.updateConversation(a.id, { pinned: true });

  const order = store.listConversations().map((c) => c.id);
  assert.deepEqual(order, [a.id, b.id]);
});

// ---------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------

test("search matches title and message content, case-insensitively", () => {
  const store = makeStore();
  const a = store.createConversation().conversation;
  store.renameConversation(a.id, "Weather forecast");
  const b = store.createConversation().conversation;
  store.saveMessage(b.id, ChatStoreModule.createMessage("user", "Tell me about PYTHON generators"));

  assert.equal(store.searchConversations("weather").length, 1);
  assert.equal(store.searchConversations("python").length, 1);
  assert.equal(store.searchConversations("nonexistent-term").length, 0);
});

test("empty search query restores the full list", () => {
  const store = makeStore();
  store.createConversation();
  const conv2 = store.createConversation();
  store.saveMessage(store.createConversation().conversation.id, ChatStoreModule.createMessage("user", "x"));
  assert.equal(store.searchConversations("").length, store.listConversations().length);
});

test("search works with Unicode (Arabic and Russian) content", () => {
  const store = makeStore();
  const a = store.createConversation().conversation;
  store.saveMessage(a.id, ChatStoreModule.createMessage("user", "كيف حالك"));
  const b = store.createConversation().conversation;
  store.saveMessage(b.id, ChatStoreModule.createMessage("user", "Привет, как дела"));

  assert.equal(store.searchConversations("حالك").length, 1);
  assert.equal(store.searchConversations("привет").length, 1);
});

// ---------------------------------------------------------------------
// Export / Import
// ---------------------------------------------------------------------

test("JSON export has a valid schema and contains no secrets", () => {
  const store = makeStore();
  const conv = store.createConversation().conversation;
  store.saveMessage(conv.id, ChatStoreModule.createMessage("user", "hello"));
  store.saveMessage(conv.id, ChatStoreModule.createMessage("assistant", "hi there"));

  const result = store.exportConversationJson(conv.id);
  assert.equal(result.ok, true);
  const parsed = JSON.parse(result.json);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.conversation.messages.length, 2);
  assert.doesNotMatch(result.json, /sk-[A-Za-z0-9]{10,}/, "no OpenAI-shaped key");
  assert.doesNotMatch(result.json, /Bearer |idToken|accessToken|apiKey/i, "no token/key fields");
});

test("import of a valid export succeeds and always assigns a new conversation id", () => {
  const store = makeStore();
  const original = store.createConversation().conversation;
  store.saveMessage(original.id, ChatStoreModule.createMessage("user", "roundtrip me"));
  const exported = store.exportConversationJson(original.id).json;

  const importResult = store.importConversationJson(exported);
  assert.equal(importResult.ok, true);
  assert.notEqual(importResult.conversation.id, original.id);
  assert.equal(importResult.conversation.messages[0].content, "roundtrip me");
});

test("import rejects malformed JSON safely, without throwing", () => {
  const store = makeStore();
  const result = store.importConversationJson("{ this is not json");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid-json");
});

test("import rejects an oversized payload", () => {
  const store = makeStore();
  const huge = JSON.stringify({
    schemaVersion: 1,
    conversation: { title: "big", messages: [{ role: "user", content: "x".repeat(5 * 1024 * 1024) }] }
  });
  const result = store.importConversationJson(huge);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "file-too-large");
});

test("import with a colliding id regenerates a fresh id rather than overwriting", () => {
  const store = makeStore();
  const existing = store.createConversation().conversation;
  store.saveMessage(existing.id, ChatStoreModule.createMessage("user", "original content"));

  const collidingExport = JSON.stringify({
    schemaVersion: 1,
    conversation: { id: existing.id, title: "Malicious overwrite attempt", messages: [{ role: "user", content: "attacker content" }] }
  });
  const importResult = store.importConversationJson(collidingExport);
  assert.equal(importResult.ok, true);
  assert.notEqual(importResult.conversation.id, existing.id);

  // Original conversation must be untouched.
  const untouched = store.getConversation(existing.id);
  assert.equal(untouched.messages[0].content, "original content");
});

test("imported HTML-like content is preserved as inert text, not markup", () => {
  const store = makeStore();
  const payload = JSON.stringify({
    schemaVersion: 1,
    conversation: { title: "xss test", messages: [{ role: "user", content: "<img src=x onerror=alert(1)>" }] }
  });
  const result = store.importConversationJson(payload);
  assert.equal(result.ok, true);
  assert.equal(result.conversation.messages[0].content, "<img src=x onerror=alert(1)>");
  assert.equal(typeof result.conversation.messages[0].content, "string");
});

test("prototype-pollution-shaped fields in imported data are ignored", () => {
  const store = makeStore();
  const malicious = '{"schemaVersion":1,"conversation":{"title":"pp","__proto__":{"polluted":true},"messages":[{"role":"user","content":"hi","__proto__":{"polluted":true}}]}}';
  const result = store.importConversationJson(malicious);
  assert.equal(result.ok, true);
  assert.equal(({}).polluted, undefined, "global Object.prototype must not be polluted");
  assert.equal(result.conversation.polluted, undefined);
});

test("markdown export produces readable text without throwing", () => {
  const store = makeStore();
  const conv = store.createConversation().conversation;
  store.saveMessage(conv.id, ChatStoreModule.createMessage("user", "hi"));
  store.saveMessage(conv.id, ChatStoreModule.createMessage("assistant", "hello back"));
  const result = store.exportConversationMarkdown(conv.id);
  assert.equal(result.ok, true);
  assert.match(result.text, /hello back/);
});

// ---- Phase 3: export / import of many chats ------------------------------------------------------

test("exportAllJson lists every non-empty chat; importAnyJson restores them all with fresh ids, keeping the file order", () => {
  const a = makeStore();
  const one = a.createConversation().conversation;
  a.saveMessage(one.id, ChatStoreModule.createMessage("user", "first chat message"));
  a.renameConversation(one.id, "First");
  const two = a.createConversation().conversation;
  a.saveMessage(two.id, ChatStoreModule.createMessage("user", "second chat message"));
  a.renameConversation(two.id, "Second");
  a.createConversation(); // empty: not exported
  const exported = a.exportAllJson();
  assert.equal(exported.ok, true);
  assert.equal(exported.count, 2);
  const parsed = JSON.parse(exported.json);
  assert.equal(parsed.conversations.length, 2);
  assert.equal(parsed.conversations.every((c) => !("id" in c)), true, "ids are never exported");

  const b = makeStore();
  const result = b.importAnyJson(exported.json);
  assert.equal(result.ok, true);
  assert.equal(result.added, 2);
  assert.deepEqual(b.listConversations().map((c) => c.title), parsed.conversations.map((c) => c.title));
  assert.equal(b.getActiveConversationId(), result.conversation.id);
  assert.notEqual(b.listConversations()[0].id, one.id);
});

test("importAnyJson also accepts the single-chat format and rejects junk safely", () => {
  const a = makeStore();
  const c = a.createConversation().conversation;
  a.saveMessage(c.id, ChatStoreModule.createMessage("user", "single"));
  const single = a.exportConversationJson(c.id).json;
  const b = makeStore();
  assert.equal(b.importAnyJson(single).ok, true);
  assert.equal(b.importAnyJson("not json").reason, "invalid-json");
  assert.equal(b.importAnyJson("").reason, "empty-input");
  assert.equal(b.importAnyJson(JSON.stringify({ conversations: [] })).ok, false);
  assert.equal(b.importAnyJson(JSON.stringify({ conversations: [{ title: "no messages", messages: [] }, 5, null] })).ok, false);
  assert.equal(b.importAnyJson(JSON.stringify({ hello: "world" })).ok, false);
});

test("importAnyJson skips chats beyond the conversation limit and reports how many", () => {
  const store = makeStore();
  const many = [];
  for (let i = 0; i < ChatStoreModule.LIMITS.maxConversations + 7; i += 1) {
    many.push({ title: "Chat " + i, messages: [{ role: "user", content: "m" + i }] });
  }
  const result = store.importAnyJson(JSON.stringify({ conversations: many }));
  assert.equal(result.ok, true);
  assert.equal(result.added, ChatStoreModule.LIMITS.maxConversations);
  assert.equal(result.skipped, 7);
});

test("importAnyJson treats imported text as data: titles/contents are kept verbatim, never executed or trusted as ids", () => {
  const store = makeStore();
  const evil = { conversations: [{ id: "steal-this-id", title: "<img src=x onerror=alert(1)>", messages: [{ role: "user", content: "<script>1</script>", id: "m-evil" }] }] };
  const result = store.importAnyJson(JSON.stringify(evil));
  assert.equal(result.ok, true);
  assert.notEqual(result.conversation.id, "steal-this-id");
  assert.equal(result.conversation.title, "<img src=x onerror=alert(1)>");
});
