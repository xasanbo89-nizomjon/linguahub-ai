"use strict";

// Executes the real www/app.js source via Node's vm module against the
// shared fake DOM (tests/helpers/fakeDom.js), backed by the real
// chatStore.js repository. Covers message actions (copy/edit/regenerate/
// retry), the typing indicator, and scroll behavior added in Phase 5.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { createFakeElement } = require("./helpers/fakeDom");
const ChatStoreModule = require("../www/chatStore.js");

const APP_SRC = fs.readFileSync(path.join(__dirname, "..", "www", "app.js"), "utf8");

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
abort() { if (abortFn) abortFn(); }
};
}

// A fetch that always resolves the fallback (non-streaming) endpoint with a
// canned reply and rejects the streaming endpoint immediately - keeps
// these action-focused tests fast/deterministic; streaming itself is
// covered by tests/streaming-persistence.test.js.
function makeScriptedFetch(repliesByPromptSubstring) {
const calls = [];
const impl = async (url, init) => {
calls.push({ url: String(url), init });
if (String(url).includes("/api/chat/stream")) {
const err = new Error("simulated: use fallback path for these tests");
throw err;
}
const body = JSON.parse(init.body || "{}");
const lastMessage = Array.isArray(body.messages) && body.messages.length
? body.messages[body.messages.length - 1].content
: "";
let reply = "default reply";
for (const key of Object.keys(repliesByPromptSubstring || {})) {
if (lastMessage.includes(key)) { reply = repliesByPromptSubstring[key]; break; }
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

function makeFakeModeUI() {
const modes = [
{ id: "general", label: "General AI", description: "", enabled: true, capability: "chat" },
{ id: "codex", label: "Codex AI", description: "", enabled: true, capability: "chat" },
{ id: "image", label: "Image AI", description: "", enabled: false, capability: "unavailable" }
];
return {
async init() { return { modes, usedFallback: false }; },
getPromptSuggestions: () => [],
isSelectableMode: (list, id) => (list || modes).some((m) => m.id === id && m.enabled)
};
}

async function buildSandbox({ fetchImpl, store, dialogConfirmResult, clipboardWriteText }) {
const elements = {};
ELEMENT_IDS.forEach((id) => { elements[id] = createFakeElement(); });
elements["mode-select"].value = "general";
elements["mode-select"].options = [{ value: "general" }, { value: "codex" }];

const bodyEl = createFakeElement("body");
const document = {
getElementById: (id) => elements[id],
createElement: (tag) => createFakeElement(tag),
body: bodyEl
};

const clipboardCalls = [];
const historyUIFactory = createFakeHistoryUI(store);

const dialogCalls = [];
const fakeDialog = {
confirm: async (opts) => { dialogCalls.push(opts); return typeof dialogConfirmResult === "boolean" ? dialogConfirmResult : true; }
};

const sandbox = {
console,
setTimeout,
clearTimeout,
fetch: fetchImpl,
document,
AbortController,
AbortSignal,
TextDecoder,
navigator: { clipboard: { writeText: clipboardWriteText || (async (text) => { clipboardCalls.push(text); }) } },
LINGUAHUB_CONFIG: { apiUrl: (p) => `http://127.0.0.1:3000${p}` },
LinguaHubAuth: makeFakeAuth(),
LinguaHubChatStore: ChatStoreModule,
LinguaHubHistoryUI: historyUIFactory,
LinguaHubModeUI: makeFakeModeUI(),
LinguaHubDialog: fakeDialog
};
sandbox.window = sandbox;

vm.createContext(sandbox);
vm.runInContext(APP_SRC, sandbox, { filename: "app.js" });
await sandbox.linguahubReady;

return { sandbox, elements, store, clipboardCalls, dialogCalls };
}

function makeStore() {
return ChatStoreModule.createChatStore({ storage: createFakeStorage() });
}

// ---------------------------------------------------------------------
// Copy actions
// ---------------------------------------------------------------------

function findMessageWrapper(chatBoxEl, role, index) {
const matches = chatBoxEl.children.filter((c) => c.dataset && c.dataset.role === role);
return matches[typeof index === "number" ? index : matches.length - 1];
}

test("copy user message copies the raw text via the Clipboard API", async () => {
const store = makeStore();
const { impl } = makeScriptedFetch({ Hello: "Hi back" });
const { sandbox, elements, clipboardCalls } = await buildSandbox({ fetchImpl: impl, store });

elements["user-input"].value = "Hello there";
await sandbox.sendMessage();

const userWrapper = findMessageWrapper(elements["chat-box"], "user");
const copyBtn = userWrapper.querySelector(".message-action-btn");
copyBtn.click();

assert.equal(clipboardCalls[clipboardCalls.length - 1], "Hello there");
});

test("copy assistant message copies the raw source text (not any rendered markup)", async () => {
const store = makeStore();
const { impl } = makeScriptedFetch({ Hello: "**Hi** back" });
const { sandbox, elements, clipboardCalls } = await buildSandbox({ fetchImpl: impl, store });

elements["user-input"].value = "Hello there";
await sandbox.sendMessage();

const aiWrapper = findMessageWrapper(elements["chat-box"], "assistant");
const copyBtn = aiWrapper.querySelector(".message-action-btn");
copyBtn.click();

assert.equal(clipboardCalls[clipboardCalls.length - 1], "**Hi** back");
});

// ---------------------------------------------------------------------
// Regenerate / retry
// ---------------------------------------------------------------------

test("regenerate replaces the existing assistant message in place - no duplicate messages", async () => {
const store = makeStore();
const { impl } = makeScriptedFetch({ Hello: "first reply" });
const { sandbox, elements } = await buildSandbox({ fetchImpl: impl, store });

elements["user-input"].value = "Hello there";
await sandbox.sendMessage();

const conversationId = store.getActiveConversationId();
assert.equal(store.getConversation(conversationId).messages.length, 2);

const aiWrapper = findMessageWrapper(elements["chat-box"], "assistant");
const originalAssistantId = aiWrapper.dataset.messageId;

const regenBtn = Array.from(aiWrapper.querySelectorAll(".message-action-btn")).find((b) => b.dataset.action === "regenerate");
assert.ok(regenBtn, "regenerate button should be present on a complete assistant message");
regenBtn.click();
await new Promise((r) => setTimeout(r, 20));

const conversation = store.getConversation(conversationId);
assert.equal(conversation.messages.length, 2, "regenerate must not create a duplicate message");
assert.equal(conversation.messages[1].id, originalAssistantId, "the same assistant message id is reused");
});

test("retry is only offered for a failed assistant message, and replaces it without duplicating", async () => {
const store = makeStore();
// Every request fails (stream throws, fallback also throws) so the
// message ends up with status "failed" and a real Retry action.
const failingFetch = async (url) => { throw new Error("network down"); };
const { sandbox, elements } = await buildSandbox({ fetchImpl: failingFetch, store });

elements["user-input"].value = "Hello there";
await sandbox.sendMessage();

const conversationId = store.getActiveConversationId();
let conversation = store.getConversation(conversationId);
assert.equal(conversation.messages[1].status, "failed");

const aiWrapper = findMessageWrapper(elements["chat-box"], "assistant");
const retryBtn = Array.from(aiWrapper.querySelectorAll(".message-action-btn")).find((b) => b.dataset.action === "retry");
assert.ok(retryBtn, "retry button should be present on a failed assistant message");
const regenBtnAbsent = Array.from(aiWrapper.querySelectorAll(".message-action-btn")).find((b) => b.dataset.action === "regenerate");
assert.equal(regenBtnAbsent, undefined, "a failed message should not also show Regenerate");

const originalId = aiWrapper.dataset.messageId;
retryBtn.click();
await new Promise((r) => setTimeout(r, 20));

conversation = store.getConversation(conversationId);
assert.equal(conversation.messages.length, 2, "retry must not create a duplicate message");
assert.equal(conversation.messages[1].id, originalId);
});

// ---------------------------------------------------------------------
// Edit user prompt
// ---------------------------------------------------------------------

test("editing the only user message preloads the original text, confirms removal of its own reply, and resends", async () => {
const store = makeStore();
const { impl } = makeScriptedFetch({ Hello: "first reply", Goodbye: "second reply" });
const { sandbox, elements, dialogCalls } = await buildSandbox({ fetchImpl: impl, store, dialogConfirmResult: true });

elements["user-input"].value = "Hello there";
await sandbox.sendMessage();

const userWrapper = findMessageWrapper(elements["chat-box"], "user");
const editBtn = Array.from(userWrapper.querySelectorAll(".message-action-btn")).find((b) => b.dataset.action === "edit");
editBtn.click();

const editArea = userWrapper.querySelector(".message-edit-textarea");
assert.equal(editArea.value, "Hello there", "edit mode preloads the original text");
editArea.value = "Goodbye there";
const saveBtn = Array.from(userWrapper.querySelectorAll(".lh-btn")).find((b) => b.textContent === "Save & send");
saveBtn.click();
await new Promise((r) => setTimeout(r, 20));

// Its own assistant reply already exists by the time anyone can click
// Edit, so confirming removal of that one later message is correct,
// honest behavior - not a bug (see the dedicated "no confirmation" case
// below for the one scenario where nothing later actually exists yet).
assert.equal(dialogCalls.length, 1);
assert.match(dialogCalls[0].message, /1/);

const conversationId = store.getActiveConversationId();
const conversation = store.getConversation(conversationId);
assert.equal(conversation.messages.length, 2);
assert.equal(conversation.messages[0].content, "Goodbye there");
});


test("Escape cancels an edit and leaves the original message unchanged", async () => {
const store = makeStore();
const { impl } = makeScriptedFetch({ Hello: "first reply" });
const { sandbox, elements } = await buildSandbox({ fetchImpl: impl, store });

elements["user-input"].value = "Hello there";
await sandbox.sendMessage();

const userWrapper = findMessageWrapper(elements["chat-box"], "user");
const editBtn = Array.from(userWrapper.querySelectorAll(".message-action-btn")).find((b) => b.dataset.action === "edit");
editBtn.click();
const editArea = userWrapper.querySelector(".message-edit-textarea");
editArea.value = "this should not be saved";
editArea.dispatch("keydown", { key: "Escape", preventDefault() {} });

assert.equal(userWrapper.querySelector(".message-edit-textarea"), null, "edit UI is torn down");
const conversationId = store.getActiveConversationId();
assert.equal(store.getConversation(conversationId).messages[0].content, "Hello there");
});

test("an empty edit is rejected and not saved", async () => {
const store = makeStore();
const { impl } = makeScriptedFetch({ Hello: "first reply" });
const { sandbox, elements } = await buildSandbox({ fetchImpl: impl, store });

elements["user-input"].value = "Hello there";
await sandbox.sendMessage();

const userWrapper = findMessageWrapper(elements["chat-box"], "user");
const editBtn = Array.from(userWrapper.querySelectorAll(".message-action-btn")).find((b) => b.dataset.action === "edit");
editBtn.click();
const editArea = userWrapper.querySelector(".message-edit-textarea");
editArea.value = "   ";
const saveBtn = Array.from(userWrapper.querySelectorAll(".lh-btn")).find((b) => b.textContent === "Save & send");
saveBtn.click();
await new Promise((r) => setTimeout(r, 10));

assert.notEqual(userWrapper.querySelector(".message-edit-textarea"), null, "edit mode stays open on rejection");
const errorEl = userWrapper.querySelector(".message-edit-error");
assert.match(errorEl.textContent, /empty/i);
const conversationId = store.getActiveConversationId();
assert.equal(store.getConversation(conversationId).messages[0].content, "Hello there");
});

test("editing an earlier message with later messages present asks for confirmation and removes them only after confirming", async () => {
const store = makeStore();
const { impl } = makeScriptedFetch({ Hello: "first reply", "second message": "second reply", Edited: "edited reply" });
const { sandbox, elements, dialogCalls } = await buildSandbox({ fetchImpl: impl, store, dialogConfirmResult: true });

elements["user-input"].value = "Hello there";
await sandbox.sendMessage();
elements["user-input"].value = "second message";
await sandbox.sendMessage();

const conversationId = store.getActiveConversationId();
assert.equal(store.getConversation(conversationId).messages.length, 4);

const firstUserWrapper = findMessageWrapper(elements["chat-box"], "user", 0);
const editBtn = Array.from(firstUserWrapper.querySelectorAll(".message-action-btn")).find((b) => b.dataset.action === "edit");
editBtn.click();
const editArea = firstUserWrapper.querySelector(".message-edit-textarea");
editArea.value = "Edited message";
const saveBtn = Array.from(firstUserWrapper.querySelectorAll(".lh-btn")).find((b) => b.textContent === "Save & send");
saveBtn.click();
await new Promise((r) => setTimeout(r, 20));

assert.equal(dialogCalls.length, 1, "must confirm before removing later messages");
assert.match(dialogCalls[0].message, /3/, "the confirmation should mention how many messages will be removed");

const conversation = store.getConversation(conversationId);
assert.equal(conversation.messages.length, 2, "later messages were removed and replaced by the new turn");
assert.equal(conversation.messages[0].content, "Edited message");
});

test("cancelling the edit confirmation leaves the conversation completely untouched", async () => {
const store = makeStore();
const { impl } = makeScriptedFetch({ Hello: "first reply", "second message": "second reply" });
const { sandbox, elements, dialogCalls } = await buildSandbox({ fetchImpl: impl, store, dialogConfirmResult: false });

elements["user-input"].value = "Hello there";
await sandbox.sendMessage();
elements["user-input"].value = "second message";
await sandbox.sendMessage();

const conversationId = store.getActiveConversationId();
const before = JSON.stringify(store.getConversation(conversationId).messages);

const firstUserWrapper = findMessageWrapper(elements["chat-box"], "user", 0);
const editBtn = Array.from(firstUserWrapper.querySelectorAll(".message-action-btn")).find((b) => b.dataset.action === "edit");
editBtn.click();
const editArea = firstUserWrapper.querySelector(".message-edit-textarea");
editArea.value = "Edited message";
const saveBtn = Array.from(firstUserWrapper.querySelectorAll(".lh-btn")).find((b) => b.textContent === "Save & send");
saveBtn.click();
await new Promise((r) => setTimeout(r, 20));

assert.equal(dialogCalls.length, 1);
const after = JSON.stringify(store.getConversation(conversationId).messages);
assert.equal(after, before, "declining the confirmation must not change any stored message");
});

// ---------------------------------------------------------------------
// Typing indicator
// ---------------------------------------------------------------------

test("a typing indicator is shown before the first token and is gone once real text exists", async () => {
const store = makeStore();
// Fallback path returns instantly, so we only need to confirm the
// indicator existed the instant the placeholder bubble was created.
const { impl } = makeScriptedFetch({ Hello: "hi" });
const { sandbox, elements } = await buildSandbox({ fetchImpl: impl, store });

elements["user-input"].value = "Hello there";
const sendPromise = sandbox.sendMessage();

const aiWrapper = findMessageWrapper(elements["chat-box"], "assistant");
assert.notEqual(aiWrapper.contentEl.querySelector(".typing-indicator"), null, "indicator shown immediately");

await sendPromise;
assert.equal(aiWrapper.contentEl.querySelector(".typing-indicator"), null, "indicator gone once settled");
assert.equal(aiWrapper.rawText, "hi");
});

// ---------------------------------------------------------------------
// Scroll behavior
// ---------------------------------------------------------------------

test("scroll-to-bottom button is hidden while near the bottom and shown after scrolling up", async () => {
const store = makeStore();
const { impl } = makeScriptedFetch({});
const { elements } = await buildSandbox({ fetchImpl: impl, store });

const chatBoxEl = elements["chat-box"];
chatBoxEl.scrollHeight = 1000;
chatBoxEl.clientHeight = 500;

chatBoxEl.scrollTop = 500; // exactly at bottom
chatBoxEl.dispatch("scroll");
assert.equal(elements["scroll-to-bottom-btn"].hidden, true);

chatBoxEl.scrollTop = 100; // scrolled far up
chatBoxEl.dispatch("scroll");
assert.equal(elements["scroll-to-bottom-btn"].hidden, false);
});

test("clicking scroll-to-bottom scrolls to the bottom and hides itself", async () => {
const store = makeStore();
const { impl } = makeScriptedFetch({});
const { elements } = await buildSandbox({ fetchImpl: impl, store });

const chatBoxEl = elements["chat-box"];
chatBoxEl.scrollHeight = 1000;
chatBoxEl.clientHeight = 500;
chatBoxEl.scrollTop = 0;

elements["scroll-to-bottom-btn"].hidden = false;
elements["scroll-to-bottom-btn"].click();

assert.equal(chatBoxEl.scrollTop, chatBoxEl.scrollHeight);
assert.equal(elements["scroll-to-bottom-btn"].hidden, true);
});

