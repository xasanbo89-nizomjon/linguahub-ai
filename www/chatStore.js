// LinguaHub AI - chat history repository.
//
// Pure data layer (no DOM access) so it can be unit tested directly in
// Node, same pattern as config.js. Backed by LocalStorage today, but every
// method returns a plain value/result object rather than assuming a
// synchronous backend forever - www/history-ui.js and www/app.js only ever
// call through this module, never touch localStorage directly, so a future
// PostgreSQL-backed repository (see docs/phase-03-chat-history.md, "Future
// PostgreSQL migration contract") can implement the same method names as
// async functions without changing any call site.
//
// Namespacing: one JSON blob per identity -
//   linguahub-ai:chat-history:v1:guest
//   linguahub-ai:chat-history:v1:user:<verified-firebase-uid>
// The uid is supplied by the caller (www/history-ui.js, which only ever
// reads it from LinguaHubAuth's verified session - never from a URL param,
// form field, or anything else the page's own script didn't get from
// Firebase itself).

var LinguaHubChatStore = (function () {
"use strict";

var STORAGE_PREFIX = "linguahub-ai:chat-history";
var STORAGE_VERSION = "v1";
var SCHEMA_VERSION = 1;
var DEFAULT_TITLE = "New Chat";

var MESSAGE_ROLES = ["user", "assistant", "system"];
var MESSAGE_STATUSES = ["complete", "streaming", "stopped", "failed"];
// Thumbs up/down on an assistant reply. Stored locally with the message only
// (never sent anywhere, not part of exports).
var MESSAGE_FEEDBACK = ["up", "down"];

var DEFAULT_MODE_ID = "general";

// Phase 6 replaced free-text mode labels ("General AI") with stable ids
// ("general") across the backend registry (see lib/aiModes.js). Older
// conversations stored on a user's machine still have the old label in
// metadata.mode - migrated transparently on read so they keep working
// instead of the backend rejecting an unrecognized mode string. Duplicated
// here (not required from lib/aiModes.js) because this file is browser-only
// with no bundler/module system to share it through.
var LEGACY_MODE_ALIASES = {
"General AI": "general",
"Codex AI": "codex",
"Cyber AI": "cyber",
"Deep Thinking": "deep-thinking",
"Image AI": "image",
"Voice AI": "voice",
"Web Search": "web-search"
};

function normalizeModeId(rawMode) {
if (typeof rawMode !== "string" || !rawMode.trim()) return DEFAULT_MODE_ID;
var trimmed = rawMode.trim();
if (Object.prototype.hasOwnProperty.call(LEGACY_MODE_ALIASES, trimmed)) {
return LEGACY_MODE_ALIASES[trimmed];
}
return trimmed;
}

var LIMITS = {
maxConversations: 100,
maxMessagesPerConversation: 500,
maxMessageContentChars: 20000,
maxTitleChars: 80,
autoTitleChars: 60,
// Large enough for an "export all chats" file of a full history.
maxImportBytes: 8 * 1024 * 1024,
maxNamespaceBytes: 4.5 * 1024 * 1024,
minConversationsKeptOnPrune: 5
};

// ---------------------------------------------------------------------
// Small safe utilities
// ---------------------------------------------------------------------

function isPlainObject(value) {
return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nowIso() {
return new Date().toISOString();
}

function safeIsoDate(value) {
if (typeof value !== "string") return null;
var t = Date.parse(value);
return isNaN(t) ? null : new Date(t).toISOString();
}

function truncateGraphemeSafe(text, maxLen) {
var chars = Array.from(text);
if (chars.length <= maxLen) return text;
return chars.slice(0, maxLen).join("").trim() + "…";
}

function generateId(prefix) {
var random;
if (typeof crypto !== "undefined" && crypto.randomUUID) {
random = crypto.randomUUID();
} else {
random = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}
return prefix ? prefix + "_" + random : random;
}

function throttle(fn, waitMs) {
var lastCallTime = 0;
var pendingArgs = null;
var timer = null;

function invoke() {
lastCallTime = Date.now();
timer = null;
var args = pendingArgs;
pendingArgs = null;
fn.apply(null, args);
}

var throttled = function () {
var args = arguments;
pendingArgs = args;
var elapsed = Date.now() - lastCallTime;
if (elapsed >= waitMs) {
if (timer) { clearTimeout(timer); timer = null; }
invoke.apply(null, args);
} else if (!timer) {
timer = setTimeout(invoke, waitMs - elapsed);
}
};

throttled.flush = function () {
if (timer) {
clearTimeout(timer);
timer = null;
invoke();
}
};
throttled.cancel = function () {
if (timer) {
clearTimeout(timer);
timer = null;
}
pendingArgs = null;
};

return throttled;
}

// ---------------------------------------------------------------------
// Schema: sanitize/normalize, never trust raw input (own storage, import,
// or legacy migration data all go through the same path)
// ---------------------------------------------------------------------

function sanitizeMessage(raw) {
if (!isPlainObject(raw)) return null;
if (MESSAGE_ROLES.indexOf(raw.role) === -1) return null;

var content = typeof raw.content === "string" ? raw.content : "";
content = truncateGraphemeSafe(content, LIMITS.maxMessageContentChars);
if (!content.trim()) return null;

var status = MESSAGE_STATUSES.indexOf(raw.status) !== -1 ? raw.status : "complete";
// A message can never be restored mid-stream - nothing is actively
// generating right after a page load/import, so treat it as stopped.
if (status === "streaming") status = "stopped";

var id = (typeof raw.id === "string" && raw.id.trim()) ? raw.id.trim() : generateId("msg");

var message = {
id: id,
role: raw.role,
content: content,
createdAt: safeIsoDate(raw.createdAt) || nowIso(),
status: status
};
if (raw.role === "assistant" && MESSAGE_FEEDBACK.indexOf(raw.feedback) !== -1) message.feedback = raw.feedback;
return message;
}

function sanitizeConversation(raw) {
if (!isPlainObject(raw)) return null;

var messagesSource = Array.isArray(raw.messages) ? raw.messages : [];
var messages = [];
for (var i = 0; i < messagesSource.length && messages.length < LIMITS.maxMessagesPerConversation; i += 1) {
var msg = sanitizeMessage(messagesSource[i]);
if (msg) messages.push(msg);
}

var rawTitle = typeof raw.title === "string" ? raw.title.trim() : "";
var title = rawTitle ? truncateGraphemeSafe(rawTitle, LIMITS.maxTitleChars) : DEFAULT_TITLE;

var mode = DEFAULT_MODE_ID;
if (isPlainObject(raw.metadata) && typeof raw.metadata.mode === "string" && raw.metadata.mode.trim()) {
mode = normalizeModeId(raw.metadata.mode);
}

var id = (typeof raw.id === "string" && raw.id.trim()) ? raw.id.trim() : generateId("conv");
var createdAt = safeIsoDate(raw.createdAt) || nowIso();

return {
id: id,
title: title,
createdAt: createdAt,
updatedAt: safeIsoDate(raw.updatedAt) || createdAt,
messages: messages,
pinned: raw.pinned === true,
archived: raw.archived === true,
// false once the user has manually renamed the conversation - guards
// automatic title generation from overwriting a manual choice.
autoTitle: raw.autoTitle !== false,
metadata: { mode: mode }
};
}

function createEmptyConversation(options) {
var opts = options || {};
var id = generateId("conv");
var timestamp = nowIso();
return {
id: id,
title: DEFAULT_TITLE,
createdAt: timestamp,
updatedAt: timestamp,
messages: [],
pinned: false,
archived: false,
autoTitle: true,
metadata: { mode: normalizeModeId(opts.mode) }
};
}

function createMessage(role, content, status) {
return {
id: generateId("msg"),
role: role,
content: typeof content === "string" ? content : "",
createdAt: nowIso(),
status: MESSAGE_STATUSES.indexOf(status) !== -1 ? status : "complete"
};
}

// ---------------------------------------------------------------------
// Auto title
// ---------------------------------------------------------------------

// A short title from the first user message: code blocks, links and Markdown
// punctuation removed, the first sentence/line only, trailing punctuation
// dropped (a question mark is kept), cut at a word boundary (about 48
// characters, with an ellipsis if it was shortened). The user's own casing is
// left alone.
var TITLE_TARGET_CHARS = 48;

function deriveTitleFromMessage(content) {
if (typeof content !== "string" || !content.trim()) return DEFAULT_TITLE;
var cleaned = content
.replace(/```[\s\S]*?```/g, " ")
.replace(/https?:\/\/\S+/g, " ")
.replace(/[`*_#>~]/g, " ");
var firstLine = "";
var lines = cleaned.split(/\r?\n/);
for (var i = 0; i < lines.length; i += 1) {
var candidate = lines[i].replace(/\s+/g, " ").trim();
if (candidate) { firstLine = candidate; break; }
}
if (!firstLine) return DEFAULT_TITLE;

var sentence = firstLine;
var match = firstLine.match(/^(.{12,}?[.!?\u061F])(?:\s|$)/);
if (match) sentence = match[1];
var title = sentence.replace(/[\s.,;:\u060C\u061B-]+$/, "");
if (!title) title = firstLine;

if (title.length > TITLE_TARGET_CHARS) {
var cut = truncateGraphemeSafe(title, TITLE_TARGET_CHARS);
var lastSpace = cut.lastIndexOf(" ");
if (lastSpace >= TITLE_TARGET_CHARS / 2) cut = cut.slice(0, lastSpace);
title = cut.replace(/[\s.,;:!?\u060C\u061B\u061F-]+$/, "") + "\u2026";
}
return truncateGraphemeSafe(title, LIMITS.autoTitleChars);
}

// ---------------------------------------------------------------------
// Namespacing
// ---------------------------------------------------------------------

function guestNamespace() {
return "guest";
}

function userNamespace(uid) {
// Only ever called with a uid the caller obtained from a verified
// Firebase session (see www/history-ui.js) - never from arbitrary UI
// input. Sanitized defensively anyway: only safe identifier characters
// survive, so a corrupted/unexpected uid can't be used to construct an
// unintended storage key.
var safeUid = typeof uid === "string" ? uid.replace(/[^a-zA-Z0-9_-]/g, "") : "";
return safeUid ? "user:" + safeUid : "guest";
}

function storageKeyForNamespace(namespace) {
return STORAGE_PREFIX + ":" + STORAGE_VERSION + ":" + namespace;
}

var LEGACY_MIGRATION_FLAG_KEY = STORAGE_PREFIX + ":legacy-migration-complete";
// Best-effort match for any pre-rename (Xasan AI / Hasan AI) storage keys.
// No such keys were found in this codebase's history (it never persisted
// chat data before this phase), so in practice this matches nothing today -
// it exists so a browser that somehow does have older data isn't silently
// ignored. See docs/phase-03-chat-history.md "Data migration".
var LEGACY_KEY_PATTERN = /xasan|hasan/i;

// ---------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------

function createChatStore(options) {
var opts = options || {};
var storage = opts.storage || (typeof window !== "undefined" ? window.localStorage : null);

if (!storage) {
throw new Error("LinguaHubChatStore requires a storage backend (localStorage-like).");
}

var namespace = guestNamespace();

function readNamespace(ns) {
var raw = null;
try {
raw = storage.getItem(storageKeyForNamespace(ns));
} catch (err) {
return { schemaVersion: SCHEMA_VERSION, activeConversationId: null, conversations: [], corrupted: true };
}

if (!raw) {
return { schemaVersion: SCHEMA_VERSION, activeConversationId: null, conversations: [] };
}

var parsed;
try {
parsed = JSON.parse(raw);
} catch (err) {
// Corrupted JSON must never crash the app or take down other
// namespaces - start fresh for this namespace only.
return { schemaVersion: SCHEMA_VERSION, activeConversationId: null, conversations: [], corrupted: true };
}

if (!isPlainObject(parsed)) {
return { schemaVersion: SCHEMA_VERSION, activeConversationId: null, conversations: [], corrupted: true };
}

var conversationsSource = Array.isArray(parsed.conversations) ? parsed.conversations : [];
var conversations = [];
var seenIds = {};
for (var i = 0; i < conversationsSource.length && conversations.length < LIMITS.maxConversations; i += 1) {
var conv = sanitizeConversation(conversationsSource[i]);
if (conv && !seenIds[conv.id]) {
seenIds[conv.id] = true;
conversations.push(conv);
}
}

var activeConversationId = typeof parsed.activeConversationId === "string" ? parsed.activeConversationId : null;
if (activeConversationId && !seenIds[activeConversationId]) {
activeConversationId = conversations.length ? conversations[0].id : null;
}

return { schemaVersion: SCHEMA_VERSION, activeConversationId: activeConversationId, conversations: conversations };
}

function isQuotaError(err) {
if (!err) return false;
return err.name === "QuotaExceededError" ||
err.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
err.code === 22 ||
err.code === 1014;
}

function pruneForSize(data) {
// Evict oldest, unpinned, non-active conversations first. Never touches
// the active conversation and always keeps at least
// minConversationsKeptOnPrune (or fewer if that's all there is).
// Conversations are stored newest-first (createConversation unshifts), so
// on an updatedAt tie (common when several are touched within the same
// millisecond) a higher original index reliably means "older" - used as
// the tiebreaker instead of leaving it to sort stability, which would
// otherwise tend to keep the *oldest* of a tied group instead of evicting it.
var active = data.activeConversationId;
var evictable = data.conversations
.map(function (c, index) { return { conv: c, index: index }; })
.filter(function (entry) { return entry.conv.id !== active && !entry.conv.pinned; })
.sort(function (x, y) {
var diff = new Date(x.conv.updatedAt) - new Date(y.conv.updatedAt);
if (diff !== 0) return diff;
return y.index - x.index;
})
.map(function (entry) { return entry.conv; });

var target = Math.max(LIMITS.minConversationsKeptOnPrune, 1);
var changed = false;
var toRemove = {};
var i = 0;
while (data.conversations.length - Object.keys(toRemove).length > target && i < evictable.length) {
toRemove[evictable[i].id] = true;
changed = true;
i += 1;
}

if (!changed) return { data: data, changed: false };

var pruned = {
schemaVersion: data.schemaVersion,
activeConversationId: data.activeConversationId,
conversations: data.conversations.filter(function (c) { return !toRemove[c.id]; })
};
return { data: pruned, changed: true };
}

function enforceMaxConversations(data) {
if (data.conversations.length <= LIMITS.maxConversations) return data;
var pruned = pruneForSize(data);
return pruned.data;
}

// Change notifications (used by www/chat-sync.js). "changed" fires after every
// successful write to the CURRENT namespace; "deleted" / "cleared" fire only
// for explicit user deletions, so a conversation that merely disappears
// through size pruning is never mistaken for a deletion (which sync would
// propagate to the user's other devices).
var listeners = [];

function emit(event) {
for (var i = 0; i < listeners.length; i += 1) {
try { listeners[i](event); } catch (err) { /* a listener must never break a write */ }
}
}

function subscribe(listener) {
if (typeof listener !== "function") return function () {};
listeners.push(listener);
return function () {
var index = listeners.indexOf(listener);
if (index !== -1) listeners.splice(index, 1);
};
}

function writeNamespace(ns, data) {
var bounded = enforceMaxConversations(data);
var payload;
try {
payload = JSON.stringify(bounded);
} catch (err) {
return { ok: false, reason: "serialize-error" };
}

// Proactive size cap, in addition to the reactive QuotaExceededError
// handling below - avoids repeatedly hitting the browser's hard quota.
if (payload.length * 2 > LIMITS.maxNamespaceBytes) {
var proactivelyPruned = pruneForSize(bounded);
if (proactivelyPruned.changed) {
bounded = proactivelyPruned.data;
payload = JSON.stringify(bounded);
}
}

var attempts = 0;
while (attempts < 5) {
try {
storage.setItem(storageKeyForNamespace(ns), payload);
if (ns === namespace) emit({ type: "changed" });
return { ok: true, pruned: attempts > 0 };
} catch (err) {
if (!isQuotaError(err)) {
return { ok: false, reason: "storage-error", error: err };
}
var result = pruneForSize(bounded);
if (!result.changed) {
return { ok: false, reason: "quota-exceeded" };
}
bounded = result.data;
payload = JSON.stringify(bounded);
attempts += 1;
}
}
return { ok: false, reason: "quota-exceeded" };
}

function currentData() {
return readNamespace(namespace);
}

function touch(conversation) {
conversation.updatedAt = nowIso();
return conversation;
}

function findIndex(data, id) {
for (var i = 0; i < data.conversations.length; i += 1) {
if (data.conversations[i].id === id) return i;
}
return -1;
}

function sortForDisplay(conversations) {
return conversations.slice().sort(function (a, b) {
if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
return new Date(b.updatedAt) - new Date(a.updatedAt);
});
}

// -- public API ---------------------------------------------------

function setUserId(uid) {
namespace = uid ? userNamespace(uid) : guestNamespace();
return namespace;
}

function getNamespace() {
return namespace;
}

function listConversations() {
return sortForDisplay(currentData().conversations);
}

function getConversation(id) {
var data = currentData();
var index = findIndex(data, id);
return index === -1 ? null : data.conversations[index];
}

function getActiveConversationId() {
return currentData().activeConversationId;
}

function setActiveConversationId(id) {
var data = currentData();
if (id !== null && findIndex(data, id) === -1) return { ok: false, reason: "not-found" };
data.activeConversationId = id;
return writeNamespace(namespace, data);
}

function createConversation(options) {
var data = currentData();

// Reuse the current active conversation if it's already a fresh, empty,
// auto-titled one - prevents rapid New Chat clicks from spawning
// duplicate empty conversations.
if (data.activeConversationId) {
var activeIndex = findIndex(data, data.activeConversationId);
if (activeIndex !== -1) {
var active = data.conversations[activeIndex];
if (active.messages.length === 0 && active.autoTitle) {
return { ok: true, conversation: active, reused: true };
}
}
}

var conversation = createEmptyConversation(options);
data.conversations.unshift(conversation);
data.activeConversationId = conversation.id;
var result = writeNamespace(namespace, data);
if (!result.ok) return { ok: false, reason: result.reason };
return { ok: true, conversation: conversation, reused: false };
}

// options.touch === false keeps updatedAt as it was: pinning or unpinning a
// chat must not move it into a different date group.
function updateConversation(id, patch, options) {
var data = currentData();
var index = findIndex(data, id);
if (index === -1) return { ok: false, reason: "not-found" };

var conversation = data.conversations[index];
if (typeof patch.pinned === "boolean") conversation.pinned = patch.pinned;
if (typeof patch.archived === "boolean") conversation.archived = patch.archived;
if (isPlainObject(patch.metadata) && typeof patch.metadata.mode === "string" && patch.metadata.mode.trim()) {
conversation.metadata = { mode: normalizeModeId(patch.metadata.mode) };
}
if (!(options && options.touch === false)) touch(conversation);

var result = writeNamespace(namespace, data);
if (!result.ok) return { ok: false, reason: result.reason };
return { ok: true, conversation: conversation };
}

// Inserts or replaces ONE conversation from outside (chat sync). Keeps the
// timestamps it arrives with, never changes which chat is active, and keeps
// this device's own thumbs up/down ratings on messages that survive.
function upsertConversation(raw) {
var incoming = sanitizeConversation(raw);
if (!incoming) return { ok: false, reason: "invalid-conversation" };
var data = currentData();
var index = findIndex(data, incoming.id);
var created = index === -1;
if (!created) {
var ratings = {};
data.conversations[index].messages.forEach(function (m) { if (m.feedback) ratings[m.id] = m.feedback; });
incoming.messages.forEach(function (m) { if (m.role === "assistant" && ratings[m.id]) m.feedback = ratings[m.id]; });
data.conversations[index] = incoming;
} else {
if (data.conversations.length >= LIMITS.maxConversations) return { ok: false, reason: "conversation-limit-reached" };
data.conversations.push(incoming);
}
var result = writeNamespace(namespace, data);
if (!result.ok) return { ok: false, reason: result.reason };
return { ok: true, conversation: incoming, created: created };
}

// The conversations saved while signed out (the guest history). Read-only:
// signing in switches to the account's own history and leaves these alone.
function listGuestConversations() {
var guest = readNamespace(guestNamespace());
return guest.conversations.filter(function (c) { return c.messages.length > 0; });
}

// Adds conversations (e.g. the guest ones) to the CURRENT history, skipping
// any whose id is already there and stopping at the conversation limit.
function mergeConversations(list) {
var data = currentData();
var added = 0;
var skipped = 0;
(Array.isArray(list) ? list : []).forEach(function (raw) {
var conversation = sanitizeConversation(raw);
if (!conversation || findIndex(data, conversation.id) !== -1 || data.conversations.length >= LIMITS.maxConversations) {
skipped += 1;
return;
}
data.conversations.push(conversation);
added += 1;
});
if (!added) return { ok: true, added: 0, skipped: skipped };
var result = writeNamespace(namespace, data);
if (!result.ok) return { ok: false, reason: result.reason };
return { ok: true, added: added, skipped: skipped };
}

// Puts a previously deleted conversation back exactly as it was (id,
// timestamps, pin, messages) - the "Undo" after a delete. Refuses if a
// conversation with that id already exists.
function restoreConversation(snapshot) {
var restored = sanitizeConversation(snapshot);
if (!restored) return { ok: false, reason: "invalid-conversation" };
var data = currentData();
if (findIndex(data, restored.id) !== -1) return { ok: false, reason: "already-exists" };
data.conversations.push(restored);
var result = writeNamespace(namespace, data);
if (!result.ok) return { ok: false, reason: result.reason };
return { ok: true, conversation: restored };
}

function renameConversation(id, title) {
var trimmed = typeof title === "string" ? title.trim() : "";
if (!trimmed) return { ok: false, reason: "empty-title" };

var data = currentData();
var index = findIndex(data, id);
if (index === -1) return { ok: false, reason: "not-found" };

var conversation = data.conversations[index];
conversation.title = truncateGraphemeSafe(trimmed, LIMITS.maxTitleChars);
conversation.autoTitle = false;
touch(conversation);

var result = writeNamespace(namespace, data);
if (!result.ok) return { ok: false, reason: result.reason };
return { ok: true, conversation: conversation };
}

function deleteConversation(id) {
var data = currentData();
var index = findIndex(data, id);
if (index === -1) return { ok: false, reason: "not-found" };

data.conversations.splice(index, 1);
if (data.activeConversationId === id) {
data.activeConversationId = data.conversations.length ? sortForDisplay(data.conversations)[0].id : null;
}

var result = writeNamespace(namespace, data);
if (!result.ok) return { ok: false, reason: result.reason };
emit({ type: "deleted", id: id });
return { ok: true, activeConversationId: data.activeConversationId };
}

function clearAllConversations() {
// Wipes every conversation in the CURRENT namespace only (guest or the
// signed-in user's own uid namespace - never another namespace), then
// seeds one fresh empty conversation so the app always has an active
// conversation to land on afterward.
var clearedIds = currentData().conversations.map(function (c) { return c.id; });
var data = { schemaVersion: SCHEMA_VERSION, activeConversationId: null, conversations: [] };
var result = writeNamespace(namespace, data);
if (!result.ok) return { ok: false, reason: result.reason };
emit({ type: "cleared", ids: clearedIds });
return createConversation();
}

function clearConversationMessages(id) {
var data = currentData();
var index = findIndex(data, id);
if (index === -1) return { ok: false, reason: "not-found" };

var conversation = data.conversations[index];
conversation.messages = [];
conversation.title = DEFAULT_TITLE;
conversation.autoTitle = true;
touch(conversation);

var result = writeNamespace(namespace, data);
if (!result.ok) return { ok: false, reason: result.reason };
return { ok: true, conversation: conversation };
}

function saveMessage(conversationId, message) {
var data = currentData();
var index = findIndex(data, conversationId);
if (index === -1) return { ok: false, reason: "not-found" };

var sanitized = sanitizeMessage(Object.assign({}, message, {
// Preserve a genuinely in-progress status through this specific write
// path (unlike sanitizeMessage's default coercion, which assumes a
// fresh page load) - streaming persistence needs "streaming" to stick
// until the caller flushes the final state.
status: MESSAGE_STATUSES.indexOf(message && message.status) !== -1 ? message.status : "complete"
}));
if (!sanitized) return { ok: false, reason: "invalid-message" };
if (message && message.status === "streaming") sanitized.status = "streaming";

var conversation = data.conversations[index];
var msgIndex = -1;
for (var i = 0; i < conversation.messages.length; i += 1) {
if (conversation.messages[i].id === sanitized.id) { msgIndex = i; break; }
}

if (msgIndex === -1) {
if (conversation.messages.length >= LIMITS.maxMessagesPerConversation) {
return { ok: false, reason: "message-limit-reached" };
}
conversation.messages.push(sanitized);
} else {
conversation.messages[msgIndex] = sanitized;
}

if (conversation.autoTitle && sanitized.role === "user") {
// Title comes from the first user message: set while still "New Chat",
// and refreshed if that first message is the one being (re)saved - e.g.
// after editing it - as long as the user never renamed the chat.
var firstUser = null;
for (var j = 0; j < conversation.messages.length; j += 1) {
if (conversation.messages[j].role === "user") { firstUser = conversation.messages[j]; break; }
}
if (conversation.title === DEFAULT_TITLE || (firstUser && firstUser.id === sanitized.id)) {
conversation.title = deriveTitleFromMessage(sanitized.content);
}
}

touch(conversation);
var result = writeNamespace(namespace, data);
if (!result.ok) return { ok: false, reason: result.reason };
return { ok: true, conversation: conversation, message: sanitized };
}

// Sets (or, with null, clears) the thumbs up/down on one assistant message.
// Deliberately does not touch updatedAt: rating a reply must not reorder the
// conversation list.
function setMessageFeedback(conversationId, messageId, value) {
var data = currentData();
var index = findIndex(data, conversationId);
if (index === -1) return { ok: false, reason: "not-found" };
if (value !== null && MESSAGE_FEEDBACK.indexOf(value) === -1) return { ok: false, reason: "invalid-feedback" };

var messages = data.conversations[index].messages;
var message = null;
for (var i = 0; i < messages.length; i += 1) {
if (messages[i].id === messageId) { message = messages[i]; break; }
}
if (!message || message.role !== "assistant") return { ok: false, reason: "not-found" };

if (value === null) delete message.feedback;
else message.feedback = value;

var result = writeNamespace(namespace, data);
if (!result.ok) return { ok: false, reason: result.reason };
return { ok: true };
}

function replaceMessages(conversationId, messages) {
var data = currentData();
var index = findIndex(data, conversationId);
if (index === -1) return { ok: false, reason: "not-found" };

var sanitized = [];
var list = Array.isArray(messages) ? messages : [];
for (var i = 0; i < list.length && sanitized.length < LIMITS.maxMessagesPerConversation; i += 1) {
var msg = sanitizeMessage(list[i]);
if (msg) sanitized.push(msg);
}

var conversation = data.conversations[index];
conversation.messages = sanitized;
touch(conversation);

var result = writeNamespace(namespace, data);
if (!result.ok) return { ok: false, reason: result.reason };
return { ok: true, conversation: conversation };
}

function searchConversations(query) {
var q = typeof query === "string" ? query.trim().toLowerCase() : "";
var all = listConversations();
if (!q) return all;

return all.filter(function (conv) {
if (conv.title.toLowerCase().indexOf(q) !== -1) return true;
for (var i = 0; i < conv.messages.length; i += 1) {
if (conv.messages[i].content.toLowerCase().indexOf(q) !== -1) return true;
}
return false;
});
}

function exportConversationJson(id) {
var conversation = getConversation(id);
if (!conversation) return { ok: false, reason: "not-found" };

var payload = {
schemaVersion: SCHEMA_VERSION,
exportedAt: nowIso(),
app: "LinguaHub AI",
conversation: {
title: conversation.title,
createdAt: conversation.createdAt,
updatedAt: conversation.updatedAt,
metadata: conversation.metadata,
messages: conversation.messages.map(function (m) {
return { role: m.role, content: m.content, createdAt: m.createdAt, status: m.status };
})
}
};
return { ok: true, json: JSON.stringify(payload, null, 2) };
}

// Every chat that has at least one message, in one file (Settings > Data).
function exportAllJson() {
var conversations = listConversations().filter(function (c) { return c.messages.length > 0; });
var payload = {
schemaVersion: SCHEMA_VERSION,
exportedAt: nowIso(),
app: "LinguaHub AI",
conversations: conversations.map(function (conversation) {
return {
title: conversation.title,
createdAt: conversation.createdAt,
updatedAt: conversation.updatedAt,
pinned: conversation.pinned,
metadata: conversation.metadata,
messages: conversation.messages.map(function (m) {
return { role: m.role, content: m.content, createdAt: m.createdAt, status: m.status };
})
};
})
};
return { ok: true, count: conversations.length, json: JSON.stringify(payload, null, 2) };
}

function exportConversationMarkdown(id) {
var conversation = getConversation(id);
if (!conversation) return { ok: false, reason: "not-found" };

var lines = ["# " + conversation.title, ""];
conversation.messages.forEach(function (m) {
var label = m.role === "user" ? "**You**" : m.role === "assistant" ? "**LinguaHub AI**" : "**System**";
lines.push(label + " (" + m.createdAt + "):");
lines.push("");
lines.push(m.content);
lines.push("");
});
return { ok: true, text: lines.join("\n") };
}

function importConversationJson(jsonText) {
if (typeof jsonText !== "string" || !jsonText) {
return { ok: false, reason: "empty-input" };
}
if (jsonText.length * 2 > LIMITS.maxImportBytes) {
return { ok: false, reason: "file-too-large" };
}

var parsed;
try {
parsed = JSON.parse(jsonText);
} catch (err) {
return { ok: false, reason: "invalid-json" };
}

if (!isPlainObject(parsed) || !isPlainObject(parsed.conversation)) {
return { ok: false, reason: "invalid-schema" };
}

// Always mint a fresh id (never trust an imported/foreign id) - this
// also guarantees no collision with, and no silent overwrite of, an
// existing conversation.
var sanitized = sanitizeConversation(Object.assign({}, parsed.conversation, { id: undefined }));
if (!sanitized) return { ok: false, reason: "invalid-schema" };
sanitized.autoTitle = false;

var data = currentData();
if (data.conversations.length >= LIMITS.maxConversations) {
return { ok: false, reason: "conversation-limit-reached" };
}
data.conversations.unshift(sanitized);
data.activeConversationId = sanitized.id;

var result = writeNamespace(namespace, data);
if (!result.ok) return { ok: false, reason: result.reason };
return { ok: true, conversation: sanitized };
}

// Accepts both export formats: one chat ({ conversation }) or many
// ({ conversations: [...] }). Every imported chat gets a fresh id; chats
// beyond the conversation limit are skipped and counted.
function importAnyJson(jsonText) {
if (typeof jsonText !== "string" || !jsonText) return { ok: false, reason: "empty-input" };
if (jsonText.length * 2 > LIMITS.maxImportBytes) return { ok: false, reason: "file-too-large" };
var parsed;
try {
parsed = JSON.parse(jsonText);
} catch (err) {
return { ok: false, reason: "invalid-json" };
}
if (!isPlainObject(parsed) || !Array.isArray(parsed.conversations)) {
return importConversationJson(jsonText);
}

var data = currentData();
var imported = [];
var skipped = 0;
parsed.conversations.forEach(function (raw) {
var conversation = sanitizeConversation(Object.assign({}, raw, { id: undefined }));
if (!conversation || !conversation.messages.length || data.conversations.length + imported.length >= LIMITS.maxConversations) {
skipped += 1;
return;
}
conversation.autoTitle = false;
imported.push(conversation);
});
if (!imported.length) return { ok: false, reason: skipped ? "nothing-imported" : "invalid-schema" };

// keep the file's order: its first chat ends up first in the list
imported.slice().reverse().forEach(function (c) { data.conversations.unshift(c); });
data.activeConversationId = imported[0].id;
var result = writeNamespace(namespace, data);
if (!result.ok) return { ok: false, reason: result.reason };
return { ok: true, conversation: imported[0], added: imported.length, skipped: skipped };
}

// -- legacy migration ----------------------------------------------

function findLegacyKeys() {
var keys = [];
try {
var length = storage.length;
for (var i = 0; i < length; i += 1) {
var key = storage.key(i);
if (key && LEGACY_KEY_PATTERN.test(key) && key.indexOf(STORAGE_PREFIX) !== 0) {
keys.push(key);
}
}
} catch (err) {
return [];
}
return keys;
}

function normalizeLegacyPayload(raw) {
// Accepts either a single {messages:[...]} object or a bare array of
// {role, content} messages - the only shapes a hand-rolled pre-history
// build could plausibly have used.
var messages = null;
if (Array.isArray(raw)) {
messages = raw;
} else if (isPlainObject(raw) && Array.isArray(raw.messages)) {
messages = raw.messages;
}
if (!messages) return null;

var conversation = sanitizeConversation({
title: isPlainObject(raw) && typeof raw.title === "string" ? raw.title : DEFAULT_TITLE,
messages: messages
});
return conversation && conversation.messages.length ? conversation : null;
}

function migrateLegacyData() {
var alreadyMigrated = false;
try {
alreadyMigrated = storage.getItem(LEGACY_MIGRATION_FLAG_KEY) === "true";
} catch (err) {
alreadyMigrated = false;
}
if (alreadyMigrated) return { ok: true, migrated: 0, skipped: true };

var legacyKeys = findLegacyKeys();
if (!legacyKeys.length) {
try { storage.setItem(LEGACY_MIGRATION_FLAG_KEY, "true"); } catch (err) { /* non-fatal */ }
return { ok: true, migrated: 0 };
}

var migratedConversations = [];
legacyKeys.forEach(function (key) {
var raw;
try {
raw = JSON.parse(storage.getItem(key));
} catch (err) {
return; // skip malformed record, never crash migration
}
var conversation = normalizeLegacyPayload(raw);
if (conversation) migratedConversations.push(conversation);
});

if (!migratedConversations.length) {
try { storage.setItem(LEGACY_MIGRATION_FLAG_KEY, "true"); } catch (err) { /* non-fatal */ }
return { ok: true, migrated: 0 };
}

// Migrated data always lands in the guest namespace: legacy keys predate
// any auth system, so there is no verified uid to attribute them to.
var guestData = readNamespace(guestNamespace());
migratedConversations.forEach(function (c) { guestData.conversations.push(c); });
if (!guestData.activeConversationId && guestData.conversations.length) {
guestData.activeConversationId = guestData.conversations[0].id;
}

// Never delete the source keys before the migrated copy is confirmed
// saved.
var writeResult = writeNamespace(guestNamespace(), guestData);
if (!writeResult.ok) {
return { ok: false, reason: writeResult.reason, migrated: 0 };
}

try { storage.setItem(LEGACY_MIGRATION_FLAG_KEY, "true"); } catch (err) { /* non-fatal */ }
return { ok: true, migrated: migratedConversations.length };
}

return {
LIMITS: LIMITS,
DEFAULT_TITLE: DEFAULT_TITLE,
setUserId: setUserId,
getNamespace: getNamespace,
listConversations: listConversations,
getConversation: getConversation,
getActiveConversationId: getActiveConversationId,
setActiveConversationId: setActiveConversationId,
createConversation: createConversation,
updateConversation: updateConversation,
renameConversation: renameConversation,
deleteConversation: deleteConversation,
clearConversationMessages: clearConversationMessages,
clearAllConversations: clearAllConversations,
saveMessage: saveMessage,
replaceMessages: replaceMessages,
restoreConversation: restoreConversation,
upsertConversation: upsertConversation,
listGuestConversations: listGuestConversations,
mergeConversations: mergeConversations,
subscribe: subscribe,
setMessageFeedback: setMessageFeedback,
searchConversations: searchConversations,
exportConversationJson: exportConversationJson,
exportConversationMarkdown: exportConversationMarkdown,
importConversationJson: importConversationJson,
importAnyJson: importAnyJson,
exportAllJson: exportAllJson,
migrateLegacyData: migrateLegacyData
};
}

return {
SCHEMA_VERSION: SCHEMA_VERSION,
DEFAULT_TITLE: DEFAULT_TITLE,
DEFAULT_MODE_ID: DEFAULT_MODE_ID,
LEGACY_MODE_ALIASES: LEGACY_MODE_ALIASES,
LIMITS: LIMITS,
guestNamespace: guestNamespace,
userNamespace: userNamespace,
storageKeyForNamespace: storageKeyForNamespace,
normalizeModeId: normalizeModeId,
sanitizeMessage: sanitizeMessage,
sanitizeConversation: sanitizeConversation,
createEmptyConversation: createEmptyConversation,
createMessage: createMessage,
deriveTitleFromMessage: deriveTitleFromMessage,
truncateGraphemeSafe: truncateGraphemeSafe,
throttle: throttle,
createChatStore: createChatStore
};
})();

if (typeof module !== "undefined" && module.exports) {
module.exports = LinguaHubChatStore;
}

if (typeof window !== "undefined") {
window.LinguaHubChatStore = LinguaHubChatStore;
}
