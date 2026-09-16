"use strict";

// API base URL resolution lives in config.js (window.LINGUAHUB_CONFIG),
// shared by every frontend shell (Live Server, Electron, Capacitor, or
// same-origin production) so there is a single source of truth.
const apiUrl = (path) => window.LINGUAHUB_CONFIG.apiUrl(path);

const input = document.getElementById("user-input");
const chatBox = document.getElementById("chat-box");
const sendBtn = document.getElementById("send-btn");
const statusEl = document.getElementById("status");
const statusDotEl = document.getElementById("status-dot");
const modeSelect = document.getElementById("mode-select");
const conversationTitleEl = document.getElementById("conversation-title");
const emptyStateEl = document.getElementById("empty-state");
const emptyStateCardsEl = document.getElementById("empty-state-cards");
const scrollToBottomBtn = document.getElementById("scroll-to-bottom-btn");
const settingsBtn = document.getElementById("settings-btn");
const quickThemeBtn = document.getElementById("quick-theme-btn");
const composerHintEl = document.getElementById("composer-hint");

const loginBtn = document.getElementById("login-btn");
const logoutBtn = document.getElementById("logout-btn");
const userProfile = document.getElementById("user-profile");
const userAvatar = document.getElementById("user-avatar");
const userAvatarFallback = document.getElementById("user-avatar-fallback");
const userNameEl = document.getElementById("user-name");
const userEmailEl = document.getElementById("user-email");
const authStatusEl = document.getElementById("auth-status");

// Composer disclaimer text (Integration Prep phase, Task 14) - the single
// centralized source of truth lives in www/strings.js, never hardcoded
// here or in index.html, so a future localization pass has exactly one
// place to change per string.
if (composerHintEl && window.LinguaHubStrings) {
composerHintEl.textContent = window.LinguaHubStrings.composerDisclaimer;
}

// Tracks the in-flight streaming request, if any, so logout, delete,
// clear, and conversation switching can all cancel it the same way instead
// of letting it finish in the background.
let activeChatAbortController = null;

function abortActiveGeneration() {
if (activeChatAbortController) {
activeChatAbortController.abort();
activeChatAbortController = null;
setBusy(false);
}
}

// Arabic/Hebrew-range detection for per-message RTL - never applied to the
// whole app, only to the individual message (or the composer) that
// actually contains RTL text (Task 14).
const RTL_PATTERN = new RegExp("[" + "\u0591-\u07FF\uFB1D-\uFDFF\uFE70-\uFEFF" + "]");

function applyRtlIfNeeded(el, text) {
if (RTL_PATTERN.test(text)) {
el.setAttribute("dir", "rtl");
} else {
el.removeAttribute("dir");
}
}

function isNearBottom() {
return chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight < 80;
}

const MAX_EDIT_LENGTH = 8000; // mirrors the backend's default MAX_MESSAGE_LENGTH

function scrollChatToBottom() {
chatBox.scrollTop = chatBox.scrollHeight;
}

async function copyText(text) {
try {
await navigator.clipboard.writeText(text);
if (window.LinguaHubToast) window.LinguaHubToast.show({ type: "success", message: "Copied to clipboard.", duration: 1500 });
return true;
} catch (err) {
if (window.LinguaHubToast) window.LinguaHubToast.show({ type: "error", message: "Could not copy to the clipboard." });
return false;
}
}

// The single authoritative Markdown render: called once generation settles
// (complete/stopped) or when restoring a finished message from history -
// never during active streaming, which stays plain text (Task 3's "safe
// incremental strategy"). Falls back to safe plain text if the Markdown/
// sanitizer scripts failed to load - never raw HTML either way.
function renderAssistantContentFinal(contentEl, sourceText) {
if (!sourceText) {
contentEl.textContent = "";
return;
}
if (window.LinguaHubMarkdown) {
contentEl.innerHTML = window.LinguaHubMarkdown.renderToSafeHtml(sourceText);
} else {
contentEl.textContent = sourceText;
}
applyRtlIfNeeded(contentEl, sourceText);
}

function showTypingIndicator(contentEl) {
contentEl.textContent = "";
const indicator = document.createElement("span");
indicator.className = "typing-indicator";
indicator.setAttribute("role", "status");
indicator.setAttribute("aria-label", "LinguaHub AI is generating a response");
for (let i = 0; i < 3; i += 1) {
const dot = document.createElement("span");
dot.className = "dot";
indicator.appendChild(dot);
}
contentEl.appendChild(indicator);
}

function statusLabelText(status) {
if (status === "stopped") return "Stopped";
if (status === "failed") return "Failed";
return "";
}

function setMessageStatusLabel(wrapper, status) {
let label = wrapper.querySelector(".message-status-label");
const text = statusLabelText(status);
if (!text) {
if (label) label.remove();
return;
}
if (!label) {
label = document.createElement("div");
label.className = "message-status-label";
label.setAttribute("role", "status");
const actionsEl = wrapper.querySelector(".message-actions");
wrapper.insertBefore(label, actionsEl || null);
}
label.textContent = text;
}

function buildMessageActions(role, status) {
const actions = document.createElement("div");
actions.className = "message-actions";

const copyBtn = document.createElement("button");
copyBtn.type = "button";
copyBtn.className = "message-action-btn";
copyBtn.dataset.action = "copy";
copyBtn.setAttribute("aria-label", role === "user" ? "Copy your message" : "Copy response");
copyBtn.textContent = "⧉";
actions.appendChild(copyBtn);

if (role === "user") {
const editBtn = document.createElement("button");
editBtn.type = "button";
editBtn.className = "message-action-btn";
editBtn.dataset.action = "edit";
editBtn.setAttribute("aria-label", "Edit message");
editBtn.textContent = "✏️";
actions.appendChild(editBtn);
} else if (status === "failed") {
const retryBtn = document.createElement("button");
retryBtn.type = "button";
retryBtn.className = "message-action-btn";
retryBtn.dataset.action = "retry";
retryBtn.setAttribute("aria-label", "Retry this response");
retryBtn.textContent = "↻ Retry";
actions.appendChild(retryBtn);
} else if (status === "complete" || status === "stopped") {
const regenBtn = document.createElement("button");
regenBtn.type = "button";
regenBtn.className = "message-action-btn";
regenBtn.dataset.action = "regenerate";
regenBtn.setAttribute("aria-label", "Regenerate response");
regenBtn.textContent = "↻ Regenerate";
actions.appendChild(regenBtn);
}
return actions;
}

function refreshMessageActions(wrapper, status) {
wrapper.dataset.status = status;
wrapper.classList.toggle("error", status === "failed");
setMessageStatusLabel(wrapper, status);
const old = wrapper.querySelector(".message-actions");
if (old) old.remove();
wrapper.appendChild(buildMessageActions(wrapper.dataset.role, status));
}

function addMessage(role, text, options) {
const opts = options || {};
const status = opts.status || "complete";
const cssType = role === "user" ? "user" : "ai";
const shouldStick = isNearBottom();

const wrapper = document.createElement("div");
wrapper.className = `message ${cssType}`;
if (status === "failed") wrapper.classList.add("error");
wrapper.dataset.role = role;
wrapper.dataset.status = status;
if (opts.messageId) wrapper.dataset.messageId = opts.messageId;

// LH identity mark (Phase 14) - assistant messages only, never on the
// user's own messages. Purely decorative brand presence; the message's
// real role is already conveyed structurally (data-role) and visually
// (alignment/color), so this is aria-hidden like every other LH mark.
if (cssType === "ai") {
const avatar = document.createElement("div");
avatar.className = "message-avatar";
avatar.setAttribute("aria-hidden", "true");
const mark = document.createElement("span");
mark.className = "lh-mark lh-mark-sm";
mark.textContent = "LH";
avatar.appendChild(mark);
wrapper.appendChild(avatar);
}

const contentEl = document.createElement("div");
contentEl.className = "message-content";
wrapper.appendChild(contentEl);
wrapper.contentEl = contentEl;
wrapper.rawText = text || "";

if (status === "streaming") {
if (text) {
contentEl.textContent = text;
applyRtlIfNeeded(contentEl, text);
} else {
showTypingIndicator(contentEl);
}
} else if (role === "assistant" && status !== "failed" && text) {
renderAssistantContentFinal(contentEl, text);
} else if (role === "assistant" && status === "stopped" && !text) {
contentEl.textContent = "(Stopped - no response received)";
} else {
contentEl.textContent = text || "";
applyRtlIfNeeded(contentEl, text || "");
}

setMessageStatusLabel(wrapper, status);
wrapper.appendChild(buildMessageActions(role, status));

chatBox.appendChild(wrapper);
if (shouldStick) scrollChatToBottom();
return wrapper;
}

function setBusy(busy) {
input.disabled = busy;
modeSelect.disabled = busy;
// "Online" (Phase 14) is the idle default, not an empty string - the app
// really is ready to chat whenever it isn't actively streaming, so this
// is an honest status, not a fabricated connectivity claim.
statusEl.textContent = busy ? "LinguaHub AI is thinking..." : "Online";
if (statusDotEl) statusDotEl.classList.toggle("active", busy);
sendBtn.classList.toggle("is-stop", busy);
sendBtn.textContent = busy ? "Stop" : "Send";
sendBtn.setAttribute("aria-label", busy ? "Stop generating" : "Send message");
}

sendBtn.addEventListener("click", () => {
if (sendBtn.classList.contains("is-stop")) {
abortActiveGeneration();
} else {
sendMessage();
}
});

// Auto-resize while typing, not just after sending (Task 7).
function autoResizeComposer() {
input.style.height = "auto";
input.style.height = Math.min(input.scrollHeight, 200) + "px";
}
input.addEventListener("input", () => {
autoResizeComposer();
applyRtlIfNeeded(input, input.value);
});

chatBox.addEventListener("scroll", () => {
if (scrollToBottomBtn) scrollToBottomBtn.hidden = isNearBottom();
});
if (scrollToBottomBtn) {
scrollToBottomBtn.addEventListener("click", () => {
chatBox.scrollTop = chatBox.scrollHeight;
scrollToBottomBtn.hidden = true;
});
}

// Real prompt-starters only (Task 5) - no fake modes. Clicking populates
// and focuses the composer; the user decides whether/what to send. The
// suggestion set itself is mode-specific (see www/mode-ui.js) and re-rendered
// whenever the selected mode changes.
function renderEmptyStateCards() {
if (!emptyStateCardsEl) return;
emptyStateCardsEl.textContent = "";
const suggestions = window.LinguaHubModeUI
? window.LinguaHubModeUI.getPromptSuggestions(modeSelect.value)
: [];
suggestions.forEach((item) => {
const card = document.createElement("button");
card.type = "button";
card.className = "empty-state-card";
if (item.icon) {
const icon = document.createElement("span");
icon.className = "empty-state-card-icon";
icon.setAttribute("aria-hidden", "true");
icon.textContent = item.icon;
card.appendChild(icon);
}
const text = document.createElement("span");
text.className = "empty-state-card-text";
const label = document.createElement("span");
label.className = "empty-state-card-label";
label.textContent = item.label;
const hint = document.createElement("span");
hint.className = "empty-state-card-hint";
hint.textContent = item.hint;
text.appendChild(label);
text.appendChild(hint);
card.appendChild(text);
card.addEventListener("click", () => {
input.value = item.prompt;
autoResizeComposer();
input.focus();
input.setSelectionRange(input.value.length, input.value.length);
});
emptyStateCardsEl.appendChild(card);
});
}
renderEmptyStateCards();
modeSelect.addEventListener("change", renderEmptyStateCards);

// ---------------------------------------------------------------------
// Chat history (conversations sidebar) - see www/chatStore.js and
// www/history-ui.js. history-ui.js owns conversation selection/list state
// and calls back here whenever the active conversation changes so this
// file can rebuild #chat-box from storage; this file owns sending/
// streaming and writes messages straight to historyUI.store as they happen.
// ---------------------------------------------------------------------

const historyUI = window.LinguaHubHistoryUI.init();

// Populated once mode-ui.js resolves GET /api/ai/modes (see
// bootstrapModesAndHistory below) - the backend's public mode registry is
// the only source of truth for which mode ids exist and are currently
// enabled/selectable (Task 4).
let availableModes = [];

function renderConversationMessages(conversation) {
chatBox.textContent = "";

if (conversationTitleEl) {
conversationTitleEl.textContent = conversation ? conversation.title : "LinguaHub AI";
}

const hasMessages = Boolean(conversation && conversation.messages.length);
if (emptyStateEl) emptyStateEl.hidden = hasMessages || !conversation;
if (scrollToBottomBtn) scrollToBottomBtn.hidden = true;

if (!conversation) return;

// A stored mode that's unknown or currently disabled (e.g. an imported
// conversation, or a mode later turned off) falls back to whatever the
// selector is already showing rather than forcing an invalid/unavailable
// selection (Task 5).
if (conversation.metadata &&
window.LinguaHubModeUI &&
window.LinguaHubModeUI.isSelectableMode(availableModes, conversation.metadata.mode)) {
modeSelect.value = conversation.metadata.mode;
}
renderEmptyStateCards();

// Restored messages are never mid-stream (chatStore already normalizes a
// stale "streaming" status to "stopped" on read - see www/chatStore.js) -
// each one gets its final rendering (Markdown for assistant, plain text
// for user) immediately, with status-appropriate actions.
conversation.messages.forEach((message) => {
addMessage(message.role, message.content, { status: message.status, messageId: message.id });
});
scrollChatToBottom();
}

historyUI.onActiveConversationChanged(renderConversationMessages);
historyUI.registerAbortActiveGeneration(abortActiveGeneration);

// Modes are fetched from the backend before the first conversation restore
// so that restore's modeSelect.value assignment above has real options to
// match against - if history started first, an in-flight fetch could still
// be replacing <option>s out from under an already-applied selection.
async function bootstrapModesAndHistory() {
const result = await window.LinguaHubModeUI.init(modeSelect);
availableModes = result.modes;
historyUI.start();
}
// var (not const) so this attaches to the global object the same way in a
// real <script> tag and in the vm-sandboxed test harness (tests/app-actions.test.js,
// tests/streaming-persistence.test.js, tests/frontend-auth.test.js) - lets
// tests await app readiness deterministically instead of guessing a delay.
var linguahubReady = bootstrapModesAndHistory();

if (settingsBtn) {
settingsBtn.addEventListener("click", () => {
if (window.LinguaHubSettingsUI) window.LinguaHubSettingsUI.open(historyUI);
});
}

// Quick theme toggle (Phase 14) - a real light/dark switch, not a
// placeholder icon. Reuses the exact same window.LinguaHubTheme API the
// full Settings panel already uses, so both stay in sync automatically
// (theme.js is the single source of truth either way). Deliberately
// binary (light/dark only) for a one-click toggle; "System" mode remains
// available in Settings for anyone who wants it.
if (quickThemeBtn) {
quickThemeBtn.addEventListener("click", () => {
if (!window.LinguaHubTheme) return;
const resolved = LinguaHubTheme.getResolvedTheme();
LinguaHubTheme.setMode(resolved === "dark" ? "light" : "dark");
});
}

input.addEventListener("keydown", (e) => {
if (e.key === "Enter" && !e.shiftKey) {
const enterToSend = window.LinguaHubSettingsUI ? window.LinguaHubSettingsUI.isEnterToSendEnabled() : true;
if (enterToSend) {
e.preventDefault();
sendMessage();
}
}
});

// Single token-provider function: attaches Authorization only when a real
// user is signed in and a token is actually available. Never attaches an
// undefined/null value, and never logs the token itself.
async function buildAuthHeaders() {
if (!window.LinguaHubAuth || !LinguaHubAuth.isAvailable() || !LinguaHubAuth.getCurrentUser()) {
return {};
}
const token = await LinguaHubAuth.getIdToken();
return token ? { Authorization: `Bearer ${token}` } : {};
}

async function streamChat(requestMessages, mode, aiBubble, conversationId, assistantMessageId) {
activeChatAbortController = new AbortController();
const authHeaders = await buildAuthHeaders();

// Persists the accumulated text at most every 400ms while tokens are
// still streaming in - never once per token - with a final flush() call
// once the stream ends so the last chunk is never silently dropped.
const throttledSave = window.LinguaHubChatStore.throttle((text) => {
historyUI.store.saveMessage(conversationId, {
id: assistantMessageId, role: "assistant", content: text, status: "streaming"
});
}, 400);

const response = await fetch(apiUrl("/api/chat/stream"), {
method: "POST",
headers: Object.assign({ "Content-Type": "application/json" }, authHeaders),
body: JSON.stringify({ messages: requestMessages, mode }),
signal: activeChatAbortController.signal
});

if (!response.ok || !response.body) {
throw new Error(`Server responded ${response.status}`);
}

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let receivedAny = false;

try {
while (true) {
const { done, value } = await reader.read();
if (done) break;

buffer += decoder.decode(value, { stream: true });
const events = buffer.split("\n\n");
buffer = events.pop();

for (const event of events) {
const line = event.trim();
if (!line.startsWith("data:")) continue;

const payload = line.slice(5).trim();
if (payload === "[DONE]") continue;

const parsed = JSON.parse(payload);
if (parsed.error) {
throw new Error(parsed.error);
}
if (parsed.delta) {
const shouldStick = isNearBottom();
if (!receivedAny) {
// First real token: clear the typing indicator (Task 7 - shown
// only until meaningful streamed text begins).
aiBubble.contentEl.textContent = "";
}
receivedAny = true;
aiBubble.contentEl.textContent += parsed.delta;
applyRtlIfNeeded(aiBubble.contentEl, aiBubble.contentEl.textContent);
if (shouldStick) scrollChatToBottom();
throttledSave(aiBubble.contentEl.textContent);
}
}
}
} finally {
throttledSave.flush();
}

return receivedAny;
}

async function fallbackChat(requestMessages, mode, aiBubble) {
const authHeaders = await buildAuthHeaders();
const response = await fetch(apiUrl("/api/chat"), {
method: "POST",
headers: Object.assign({ "Content-Type": "application/json" }, authHeaders),
body: JSON.stringify({ messages: requestMessages, mode })
});
const data = await response.json();
if (!response.ok) {
// The backend's error responses are valid JSON with a human-readable
// `reply` (see server.js's catch blocks) - surface that same message,
// but as a thrown error so the caller's failure handling (status:
// "failed", Retry button) actually triggers instead of this looking
// like a successful reply.
throw new Error(data.reply || `Server responded ${response.status}`);
}
const replyText = data.reply || "❌ Empty response from server.";
aiBubble.contentEl.textContent = replyText;
applyRtlIfNeeded(aiBubble.contentEl, replyText);
}

// The one place that assembles what actually gets sent to the backend for
// a generation: the active conversation's user/assistant history, in
// order, stopping right after uptoMessageId (Task 5/Task 9 - "used by both
// fresh-send and regenerate/retry"). Failed messages are excluded so a
// previous error never re-enters context. Regenerate/retry pass the
// *user* message id that preceded the assistant reply being redone, which
// naturally excludes that old (being-replaced) assistant answer and
// anything after it. Falls back to a single-message array if there's no
// active conversation to read from (e.g. storage unavailable).
function buildMessagesForRequest(conversationId, uptoMessageId, fallbackText) {
if (conversationId) {
const conversation = historyUI.store.getConversation(conversationId);
if (conversation) {
const messages = [];
for (const m of conversation.messages) {
if (m.role !== "user" && m.role !== "assistant") continue;
if (m.status === "failed") continue;
if (!m.content) continue;
messages.push({ role: m.role, content: m.content });
if (m.id === uptoMessageId) break;
}
if (messages.length) return messages;
}
}
return [{ role: "user", content: fallbackText }];
}

// Shared by a brand-new send, regenerate, and retry - the one place that
// owns "run a generation into this bubble and persist the outcome", so
// none of the three call sites can drift out of sync or double-implement
// the streaming/fallback/abort/status logic.
async function generateAssistantReply(conversationId, requestMessages, mode, assistantMessageId, aiBubble) {
setBusy(true);

let finalStatus = "complete";
try {
const streamed = await streamChat(requestMessages, mode, aiBubble, conversationId, assistantMessageId);
if (!streamed) {
await fallbackChat(requestMessages, mode, aiBubble);
}
} catch (err) {
if (err.name === "AbortError") {
// Cancelled intentionally (e.g. Stop, logout, delete, clear, switching
// conversation) - keep whatever partial response already rendered;
// this is never reported as an error toast.
finalStatus = "stopped";
} else {
try {
await fallbackChat(requestMessages, mode, aiBubble);
} catch (fallbackErr) {
aiBubble.classList.add("error");
aiBubble.contentEl.textContent = "❌ Error connecting to AI: " + fallbackErr.message;
finalStatus = "failed";
}
}
} finally {
// Captured before any Markdown re-render below, so it is always the
// plain source text regardless of which path was taken.
const rawText = aiBubble.contentEl.textContent;
const isHardError = aiBubble.classList.contains("error");
aiBubble.rawText = rawText;

if (!isHardError && rawText) {
renderAssistantContentFinal(aiBubble.contentEl, rawText);
} else {
applyRtlIfNeeded(aiBubble.contentEl, rawText);
if (finalStatus === "stopped" && !rawText) {
aiBubble.contentEl.textContent = "(Stopped - no response received)";
}
}

if (conversationId) {
// Not rawText: chatStore rejects empty-content messages outright (by
// design), so a generation stopped before any text arrived would never
// actually persist - the DOM would show the friendly placeholder above
// for this session only, then the whole assistant message would vanish
// on the next reload/restore, leaving no record it was even attempted
// (found via real browser storage testing, Phase 7). Falling back to
// contentEl's current text (the placeholder, once set) keeps what's
// shown and what's saved consistent.
const textToPersist = rawText || aiBubble.contentEl.textContent;
historyUI.store.saveMessage(conversationId, {
id: assistantMessageId, role: "assistant", content: textToPersist, status: finalStatus
});
historyUI.refreshList();
}
refreshMessageActions(aiBubble, finalStatus);
activeChatAbortController = null;
setBusy(false);
}
}

async function sendMessage() {
const message = input.value.trim();
if (!message) return;

const mode = modeSelect.value;
if (typeof CustomEvent === "function") {
document.dispatchEvent(new CustomEvent("linguahub:tutor-message", { detail: { mode } }));
}
const conversationId = historyUI.store.getActiveConversationId();

if (emptyStateEl) emptyStateEl.hidden = true;

// Created up front (not just at save time) so its id can be attached to
// the DOM wrapper below - otherwise the Edit action has no message id to
// look up in the store.
const userMessage = window.LinguaHubChatStore.createMessage("user", message, "complete");
addMessage("user", message, { status: "complete", messageId: userMessage.id });
input.value = "";
input.style.height = "auto";
input.removeAttribute("dir");

if (conversationId) {
const saveResult = historyUI.store.saveMessage(conversationId, userMessage);
if (!saveResult.ok) {
historyUI.setHistoryStatus("This conversation could not be saved (" + saveResult.reason + "). It will still work for this session.");
} else if (conversationTitleEl) {
// saveMessage() auto-derives a real title from this first user message
// (chatStore.js) - the sidebar picks it up via refreshList() below, but
// the header title is only otherwise set on conversation switch/restore
// (renderConversationMessages), so without this it stayed stuck on
// "New Chat" for the rest of the session (found via real browser
// storage testing, Phase 7).
conversationTitleEl.textContent = saveResult.conversation.title;
}
historyUI.store.updateConversation(conversationId, { metadata: { mode } });
historyUI.refreshList();
}

const assistantMessage = window.LinguaHubChatStore.createMessage("assistant", "", "streaming");
const aiBubble = addMessage("assistant", "", { status: "streaming", messageId: assistantMessage.id });
if (conversationId) historyUI.store.saveMessage(conversationId, assistantMessage);

const requestMessages = buildMessagesForRequest(conversationId, userMessage.id, message);
await generateAssistantReply(conversationId, requestMessages, mode, assistantMessage.id, aiBubble);
}

// ---------------------------------------------------------------------
// Message actions: copy, edit (user), regenerate/retry (assistant).
// One delegated listener on #chat-box handles every message's buttons and
// every code block's copy button - buttons are recreated on every render
// (streaming completion, restore, edit, regenerate) without ever
// accumulating duplicate listeners (Task 17).
// ---------------------------------------------------------------------

function findUserPromptForAssistant(conversationId, assistantMessageId) {
const conversation = historyUI.store.getConversation(conversationId);
if (!conversation) return null;
const idx = conversation.messages.findIndex((m) => m.id === assistantMessageId);
if (idx <= 0) return null;
const prev = conversation.messages[idx - 1];
return prev && prev.role === "user" ? prev : null;
}

async function handleRegenerateOrRetry(wrapper) {
const conversationId = historyUI.store.getActiveConversationId();
const assistantMessageId = wrapper.dataset.messageId;
if (!conversationId || !assistantMessageId) return;

const userMsg = findUserPromptForAssistant(conversationId, assistantMessageId);
if (!userMsg) {
if (window.LinguaHubToast) {
window.LinguaHubToast.show({ type: "error", message: "Could not find the original prompt to regenerate from." });
}
return;
}

abortActiveGeneration();

const conversation = historyUI.store.getConversation(conversationId);
const mode = (conversation && conversation.metadata && conversation.metadata.mode) || modeSelect.value;

wrapper.classList.remove("error");
wrapper.contentEl.removeAttribute("dir");
showTypingIndicator(wrapper.contentEl);
refreshMessageActions(wrapper, "streaming");

const requestMessages = buildMessagesForRequest(conversationId, userMsg.id, userMsg.content);
await generateAssistantReply(conversationId, requestMessages, mode, assistantMessageId, wrapper);
}

async function handleCopyMessage(wrapper) {
const text = typeof wrapper.rawText === "string" && wrapper.rawText ? wrapper.rawText : wrapper.contentEl.textContent;
await copyText(text);
}

async function handleCodeCopy(button) {
const codeBlock = button.closest(".code-block");
const codeEl = codeBlock ? codeBlock.querySelector("code") : null;
const text = codeEl ? codeEl.textContent : "";
const ok = await copyText(text);
if (ok) {
const original = button.textContent;
button.textContent = "Copied";
setTimeout(() => { button.textContent = original; }, 1200);
}
}

let activeEditCleanup = null;

function cancelActiveEdit() {
if (activeEditCleanup) {
activeEditCleanup();
activeEditCleanup = null;
}
}

function handleEditUserMessage(wrapper) {
cancelActiveEdit();

const conversationId = historyUI.store.getActiveConversationId();
const messageId = wrapper.dataset.messageId;
if (!conversationId || !messageId) return;
const conversation = historyUI.store.getConversation(conversationId);
if (!conversation) return;
const idx = conversation.messages.findIndex((m) => m.id === messageId);
if (idx === -1) return;

const originalText = conversation.messages[idx].content;
const contentEl = wrapper.contentEl;
const actionsEl = wrapper.querySelector(".message-actions");

contentEl.hidden = true;
if (actionsEl) actionsEl.hidden = true;

const editArea = document.createElement("textarea");
editArea.className = "message-edit-textarea";
editArea.value = originalText;
editArea.maxLength = MAX_EDIT_LENGTH;
editArea.setAttribute("aria-label", "Edit your message");
applyRtlIfNeeded(editArea, originalText);

const errorEl = document.createElement("div");
errorEl.className = "message-edit-error";
errorEl.setAttribute("role", "alert");

const editActions = document.createElement("div");
editActions.className = "message-edit-actions";
const cancelBtn = document.createElement("button");
cancelBtn.type = "button";
cancelBtn.className = "lh-btn lh-btn-secondary";
cancelBtn.textContent = "Cancel";
const saveBtn = document.createElement("button");
saveBtn.type = "button";
saveBtn.className = "lh-btn lh-btn-primary";
saveBtn.textContent = "Save & send";
editActions.appendChild(cancelBtn);
editActions.appendChild(saveBtn);

wrapper.insertBefore(editArea, contentEl);
wrapper.insertBefore(errorEl, contentEl);
wrapper.insertBefore(editActions, contentEl);

function cleanup() {
editArea.remove();
errorEl.remove();
editActions.remove();
contentEl.hidden = false;
if (actionsEl) actionsEl.hidden = false;
}
activeEditCleanup = cleanup;

function cancel() {
activeEditCleanup = null;
cleanup();
}

async function confirmEdit() {
const value = editArea.value.trim();
if (!value) {
errorEl.textContent = "Message cannot be empty.";
editArea.focus();
return;
}
if (value.length > MAX_EDIT_LENGTH) {
errorEl.textContent = `Message is too long (limit ${MAX_EDIT_LENGTH} characters).`;
return;
}

const laterCount = conversation.messages.length - idx - 1;
if (laterCount > 0) {
const confirmed = window.LinguaHubDialog
? await window.LinguaHubDialog.confirm({
title: "Edit message",
message: `Editing this message will remove ${laterCount} later message(s) in this conversation. Continue?`,
confirmLabel: "Edit and remove",
destructive: true
})
: window.confirm(`Editing this message will remove ${laterCount} later message(s). Continue?`);
if (!confirmed) return;
}

activeEditCleanup = null;
cleanup();

abortActiveGeneration();
const truncated = conversation.messages.slice(0, idx);
historyUI.store.replaceMessages(conversationId, truncated);
renderConversationMessages(historyUI.store.getConversation(conversationId));

input.value = value;
await sendMessage();
}

editArea.addEventListener("keydown", (event) => {
if (event.key === "Escape") {
event.preventDefault();
cancel();
} else if (event.key === "Enter" && !event.shiftKey) {
const enterToSend = window.LinguaHubSettingsUI ? window.LinguaHubSettingsUI.isEnterToSendEnabled() : true;
if (enterToSend) {
event.preventDefault();
confirmEdit();
}
}
});
cancelBtn.addEventListener("click", cancel);
saveBtn.addEventListener("click", confirmEdit);

editArea.focus();
editArea.setSelectionRange(editArea.value.length, editArea.value.length);
}

chatBox.addEventListener("click", (event) => {
const codeCopyBtn = event.target.closest(".code-block-copy-btn");
if (codeCopyBtn) {
handleCodeCopy(codeCopyBtn);
return;
}

const actionBtn = event.target.closest(".message-action-btn");
if (!actionBtn) return;
const wrapper = actionBtn.closest(".message");
if (!wrapper) return;

const action = actionBtn.dataset.action;
if (action === "copy") handleCopyMessage(wrapper);
else if (action === "edit") handleEditUserMessage(wrapper);
else if (action === "regenerate" || action === "retry") handleRegenerateOrRetry(wrapper);
});

// ---------------------------------------------------------------------
// Authentication UI
// ---------------------------------------------------------------------

function setAuthStatus(text) {
authStatusEl.textContent = text || "";
}

function renderSignedOut() {
loginBtn.hidden = false;
loginBtn.disabled = false;
loginBtn.removeAttribute("aria-busy");
userProfile.hidden = true;
}

function showAvatarFallback(name) {
userAvatar.hidden = true;
userAvatar.removeAttribute("src");
userAvatarFallback.hidden = false;
userAvatarFallback.textContent = (name || "?").trim().charAt(0).toUpperCase() || "?";
}

function renderSignedIn(user) {
loginBtn.hidden = true;
userProfile.hidden = false;

const name = user.displayName || user.email || "Signed in";
const email = user.email || "";

// textContent only - never innerHTML - so a malicious displayName/email
// can never inject markup.
userNameEl.textContent = name;
userEmailEl.textContent = email;
userEmailEl.hidden = !email;

if (user.photoURL) {
userAvatar.src = user.photoURL;
userAvatar.alt = `${name} profile picture`;
userAvatar.hidden = false;
userAvatarFallback.hidden = true;
} else {
showAvatarFallback(name);
}
}

// Broken/blocked profile-photo URLs fall back to an initial-letter avatar
// instead of a broken-image icon.
userAvatar.addEventListener("error", () => {
showAvatarFallback(userNameEl.textContent);
});

async function verifyBackendSession() {
try {
const authHeaders = await buildAuthHeaders();
if (!authHeaders.Authorization) return;
const response = await fetch(apiUrl("/api/auth/me"), { headers: authHeaders });
if (!response.ok) {
setAuthStatus("Signed in, but the backend could not verify your session yet.");
}
} catch (err) {
// Non-fatal: Firebase (client-side) remains the source of truth for the
// signed-in UI regardless of whether this backend check succeeds.
}
}

let loginInProgress = false;

async function handleLogin() {
if (loginInProgress) return;
if (!window.LinguaHubAuth || !LinguaHubAuth.isAvailable()) {
setAuthStatus("Sign-in is unavailable: Firebase is not configured for this app.");
return;
}

loginInProgress = true;
loginBtn.disabled = true;
loginBtn.setAttribute("aria-busy", "true");
setAuthStatus("Opening Google sign-in...");

try {
const user = await LinguaHubAuth.signInWithGoogle();
if (user) {
setAuthStatus("Signed in.");
} else {
// signInWithGoogle() fell back to a full-page redirect; the browser
// is about to navigate away, so there is nothing else to render here.
setAuthStatus("Redirecting to Google sign-in...");
}
} catch (error) {
setAuthStatus(error.message || "Sign-in failed. Please try again.");
} finally {
loginInProgress = false;
loginBtn.disabled = false;
loginBtn.removeAttribute("aria-busy");
}
}

let logoutInProgress = false;

async function handleLogout() {
if (logoutInProgress) return;
logoutInProgress = true;
logoutBtn.disabled = true;
logoutBtn.setAttribute("aria-busy", "true");
setAuthStatus("Signing out...");

abortActiveGeneration();

try {
await LinguaHubAuth.signOutUser();
setAuthStatus("Signed out.");
} catch (error) {
setAuthStatus(error.message || "Logout failed. Please try again.");
} finally {
logoutInProgress = false;
logoutBtn.disabled = false;
logoutBtn.removeAttribute("aria-busy");
}
}

loginBtn.addEventListener("click", handleLogin);
logoutBtn.addEventListener("click", handleLogout);

if (window.LinguaHubAuth && LinguaHubAuth.isAvailable()) {
loginBtn.disabled = true;
loginBtn.setAttribute("aria-busy", "true");
setAuthStatus("Restoring session...");
LinguaHubAuth.completeRedirectSignIn();
LinguaHubAuth.onAuthStateChanged((user) => {
if (user) {
renderSignedIn(user);
setAuthStatus("");
verifyBackendSession();
} else {
renderSignedOut();
setAuthStatus("");
}
// Single subscription drives both the profile UI above and switching the
// chat-history namespace (guest <-> user:<uid>) - see www/history-ui.js.
historyUI.setUser(user);
});
} else {
loginBtn.disabled = true;
setAuthStatus(
window.LinguaHubAuth
? "Sign-in is unavailable: Firebase is not configured for this app."
: "Sign-in is unavailable: the Firebase SDK failed to load."
);
}
