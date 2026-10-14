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
const statusBarEl = statusEl.parentElement;
let isBusy = false;
let composerHintDefaultText = null;
const modeSelect = document.getElementById("mode-select");
const conversationTitleEl = document.getElementById("conversation-title");
const emptyStateEl = document.getElementById("empty-state");
const emptyStateCardsEl = document.getElementById("empty-state-cards");
const scrollToBottomBtn = document.getElementById("scroll-to-bottom-btn");
const settingsBtn = document.getElementById("settings-btn");
const quickThemeBtn = document.getElementById("quick-theme-btn");
const composerHintEl = document.getElementById("composer-hint");

// Pictures: the "+" button, paste and drag-and-drop - www/image-attach.js.
// Pictures are shrunk in the browser, shown as thumbnails above the composer
// and sent with the message; they are never stored (history keeps "[image]").
const attachBtn = document.getElementById("attach-btn");
const attachmentStrip = document.getElementById("attachment-strip");
const attachmentInput = document.getElementById("attachment-input");
const attachments = window.LinguaHubImages && attachBtn && attachmentStrip && attachmentInput
? window.LinguaHubImages.createAttachments({
strip: attachmentStrip,
fileInput: attachmentInput,
attachButton: attachBtn,
textarea: input,
dropZone: document.querySelector(".composer"),
deps: window.LinguaHubImages.browserDeps(window),
notify: (message) => { if (window.LinguaHubToast) window.LinguaHubToast.show({ type: "warning", message }); },
onChange: () => updateComposerState(),
isSupported: () => window.LinguaHubImages.supportsImages(modeSelect.value),
// a mode screen (Translate...) handles its own pictures
isActive: () => !(window.LinguaHubWorkspace && window.LinguaHubWorkspace.getActive())
})
: null;


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

// Arabic/Hebrew-range detection - never applied to the whole app, only to
// the individual message (or the composer) that actually contains RTL text.
// The element gets dir="auto" (the browser picks the direction from the
// first strong character) instead of a forced "rtl", so an English message
// that merely quotes one Arabic word is not flipped. Rendered Markdown goes
// further: every block (paragraph, list, heading, table cell...) gets its
// own dir="auto" (see markdown.js), so mixed Arabic/English messages lay
// out correctly paragraph by paragraph.
const RTL_PATTERN = new RegExp("[" + "\u0591-\u07FF\uFB1D-\uFDFF\uFE70-\uFEFF" + "]");

function applyRtlIfNeeded(el, text) {
if (RTL_PATTERN.test(text)) {
el.setAttribute("dir", "auto");
} else {
el.removeAttribute("dir");
}
}

function isNearBottom() {
return chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight < 80;
}

// Following a streaming reply is opt-out: any deliberate upward scroll (wheel,
// touch drag, scrollbar drag) stops the view from following - even a small
// one that still leaves the user within the "near bottom" distance, which
// would otherwise be yanked straight back down on the next chunk. Following
// resumes once the user is back at the very bottom (or clicks the jump
// button, or sends a message).
let userScrolledUp = false;

function shouldFollowStream() {
return !userScrolledUp && isNearBottom();
}

function updateScrollButton() {
if (scrollToBottomBtn) scrollToBottomBtn.hidden = isNearBottom();
}

const MAX_EDIT_LENGTH = 8000; // mirrors the backend's default MAX_MESSAGE_LENGTH

// Instant, never smooth: .chat-box has scroll-behavior: smooth for the user's
// own scrolling, but while streaming a smooth animation is still in flight
// when the next chunk arrives, so isNearBottom() would read "scrolled up"
// mid-animation and the view would stop following the reply.
function scrollChatToBottom() {
if (typeof chatBox.scrollTo === "function") chatBox.scrollTo({ top: chatBox.scrollHeight, behavior: "instant" });
else chatBox.scrollTop = chatBox.scrollHeight;
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
contentEl.removeAttribute("dir"); // direction is per block, set by markdown.js
} else {
contentEl.textContent = sourceText;
applyRtlIfNeeded(contentEl, sourceText);
}
}

// Live rendering while tokens stream in: the same sanitized Markdown the
// final render uses (so there is no reflow/jump when the reply settles),
// re-parsed at most every ~80ms, plus a blinking cursor at the very end of
// the text. Without the Markdown/sanitizer scripts it degrades to plain
// text exactly as before.
function appendStreamCursor(contentEl) {
if (typeof contentEl.querySelector !== "function") return;
let target = contentEl;
while (target.lastElementChild && /^(P|LI|UL|OL|BLOCKQUOTE|H[1-6])$/.test(target.lastElementChild.tagName)) {
target = target.lastElementChild;
}
const cursor = document.createElement("span");
cursor.className = "stream-cursor";
cursor.setAttribute("aria-hidden", "true");
target.appendChild(cursor);
}

function renderStreamingContent(bubble, text) {
const shouldStick = shouldFollowStream();
if (window.LinguaHubMarkdown) {
bubble.contentEl.innerHTML = window.LinguaHubMarkdown.renderToSafeHtml(text);
bubble.contentEl.removeAttribute("dir");
appendStreamCursor(bubble.contentEl);
} else {
bubble.contentEl.textContent = text;
applyRtlIfNeeded(bubble.contentEl, text);
}
if (shouldStick) scrollChatToBottom();
// Content grew without any scroll event: the jump button still has to show
// when the user is following something that is now off-screen.
updateScrollButton();
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

// ---------------------------------------------------------------------
// Friendly chat errors. Raw errors ("Server responded 429", stack-ish
// messages) never reach the user; every failure maps to one plain sentence,
// shown inside the reply bubble with a Retry button.
// ---------------------------------------------------------------------

const GENERIC_CHAT_ERROR = "Something went wrong with this response. Please try again.";

function describeChatError(err) {
const status = err && err.status;
if (isOffline()) return "You're offline. Check your connection, then try again.";
if (status === 429) return "You're sending messages too quickly. Wait a moment, then try again.";
if (status === 401 || status === 403) return "Your session isn't authorized for this request. Sign in again, then try again.";
if (status === 415) return "That picture type isn't supported. Use a PNG, JPG or WebP image.";
if (status === 413) return "That message is too long, or the picture is too large. Shorten it or use a smaller picture, then try again.";
if (status === 400 || status === 422) return "That message couldn't be processed - it may be too long. Shorten it and try again.";
if (status >= 500) return "The AI service ran into a problem. Please try again in a moment.";
const server = err && err.serverMessage ? String(err.serverMessage) : "";
if (/too long|timed? ?out/i.test(server)) return "The reply took too long and was stopped. Please try again.";
if (server) {
const clean = server.replace(/^[^\p{L}\p{N}]+/u, "").trim();
return clean && clean.length <= 140 ? clean : "The AI service ran into a problem. Please try again in a moment.";
}
return "Couldn't reach the AI service. Check your connection and try again.";
}

// The same request would fail the same way, so the non-streaming fallback is
// skipped (for a 429 it would also just spend more of the rate limit).
function isClientFault(err) {
const status = err && err.status;
return status === 400 || status === 401 || status === 403 || status === 404 || status === 413 || status === 422 || status === 429;
}

// Failed replies saved before this phase hold a raw "Error connecting to AI"
// string; show those as the generic message instead.
function storedErrorText(text) {
if (!text || /^\W*Error connecting to AI/i.test(text)) return GENERIC_CHAT_ERROR;
return text.replace(/^\u274C\s*/, "");
}

function renderErrorBlock(contentEl, text, live) {
contentEl.textContent = "";
contentEl.removeAttribute("dir");
const box = document.createElement("div");
box.className = "chat-error";
if (live) box.setAttribute("role", "alert");
const icon = buildIcon("warn", "chat-error-icon");
if (icon) box.appendChild(icon);
const message = document.createElement("span");
message.className = "chat-error-text";
message.textContent = text;
applyRtlIfNeeded(message, text);
box.appendChild(message);
const retry = buildActionButton("retry", "Retry this response", "regenerate", "↻ Retry");
retry.classList.add("chat-error-retry", "has-label");
if (retry.querySelector("svg")) {
const label = document.createElement("span");
label.textContent = "Retry";
retry.appendChild(label);
}
box.appendChild(retry);
contentEl.appendChild(box);
}

// Inline SVG icons for the message action buttons (static markup built with
// createElementNS - nothing from model output ever reaches this). Without
// SVG support (the unit-test fake DOM) buttons fall back to a text label.
const SVG_NS = "http://www.w3.org/2000/svg";
const ACTION_ICONS = {
copy: [["rect", { x: 9, y: 9, width: 11, height: 11, rx: 2 }], ["path", { d: "M5 15V6a2 2 0 0 1 2-2h9" }]],
edit: [["path", { d: "M4 20h4L19 9l-4-4L4 16v4z" }], ["path", { d: "M13.5 6.5l4 4" }]],
regenerate: [["path", { d: "M20 11a8 8 0 1 0-2.3 5.7" }], ["path", { d: "M20 5v6h-6" }]],
speak: [["path", { d: "M4 10v4h4l5 4V6L8 10H4z" }], ["path", { d: "M16 9a4 4 0 0 1 0 6" }], ["path", { d: "M18.5 6.5a8 8 0 0 1 0 11" }]],
stop: [["rect", { x: 7, y: 7, width: 10, height: 10, rx: 1.5 }]],
warn: [["path", { d: "M12 3l10 18H2L12 3z" }], ["path", { d: "M12 10v5" }], ["path", { d: "M12 18v.5" }]],
up: [["path", { d: "M7 11v9H4v-9h3z" }], ["path", { d: "M7 11l4-7a2 2 0 0 1 2 2v4h5.5a2 2 0 0 1 2 2.3l-1 6A2 2 0 0 1 17.5 20H7" }]],
down: [["path", { d: "M7 13V4H4v9h3z" }], ["path", { d: "M7 13l4 7a2 2 0 0 0 2-2v-4h5.5a2 2 0 0 0 2-2.3l-1-6A2 2 0 0 0 17.5 4H7" }]]
};

function buildIcon(name, className) {
if (typeof document.createElementNS !== "function") return null;
const svg = document.createElementNS(SVG_NS, "svg");
svg.setAttribute("viewBox", "0 0 24 24");
svg.setAttribute("aria-hidden", "true");
if (className) svg.setAttribute("class", className);
ACTION_ICONS[name].forEach(([tag, attrs]) => {
const el = document.createElementNS(SVG_NS, tag);
Object.keys(attrs).forEach((key) => el.setAttribute(key, String(attrs[key])));
svg.appendChild(el);
});
return svg;
}

function buildActionButton(action, label, icon, fallbackText) {
const btn = document.createElement("button");
btn.type = "button";
btn.className = "message-action-btn";
btn.dataset.action = action;
btn.setAttribute("aria-label", label);
btn.setAttribute("title", label);
const svg = buildIcon(icon);
if (svg) {
btn.appendChild(svg);
} else {
btn.textContent = fallbackText;
}
return btn;
}

function buildMessageActions(role, status, feedback) {
const actions = document.createElement("div");
actions.className = "message-actions";

actions.appendChild(buildActionButton("copy", role === "user" ? "Copy your message" : "Copy response", "copy", "⧉"));

if (role === "user") {
actions.appendChild(buildActionButton("edit", "Edit message", "edit", "✏️"));
} else if (status === "failed") {
// Retry is rendered inside the error block itself (renderErrorBlock).
} else if (status === "complete" || status === "stopped") {
// Listen (Phase 14 voice.js) - hidden via CSS when voice features are
// turned off, omitted entirely without speech synthesis.
if (typeof window !== "undefined" && window.speechSynthesis) {
const speakBtn = buildActionButton("speak", "Listen", "speak", "Listen");
speakBtn.setAttribute("aria-pressed", "false");
const stopIcon = buildIcon("stop", "icon-stop");
if (stopIcon) speakBtn.appendChild(stopIcon);
actions.appendChild(speakBtn);
}
actions.appendChild(buildActionButton("regenerate", "Regenerate response", "regenerate", "↻ Regenerate"));

// Thumbs up/down: stored locally on the message only (chatStore.js).
const up = buildActionButton("feedback-up", "Good response", "up", "👍");
up.setAttribute("aria-pressed", String(feedback === "up"));
const down = buildActionButton("feedback-down", "Bad response", "down", "👎");
down.setAttribute("aria-pressed", String(feedback === "down"));
actions.appendChild(up);
actions.appendChild(down);
}
return actions;
}

function refreshMessageActions(wrapper, status) {
wrapper.dataset.status = status;
wrapper.classList.toggle("error", status === "failed");
setMessageStatusLabel(wrapper, status);
const old = wrapper.querySelector(".message-actions");
if (old) old.remove();
wrapper.appendChild(buildMessageActions(wrapper.dataset.role, status, wrapper.dataset.feedback));
}

// Pictures inside a sent message: click one to enlarge. After a reload only a
// small "not saved" note is left, because pictures are never stored.
function buildMessagePictures(urls, missing) {
const row = document.createElement("div");
row.className = "message-pictures";
urls.forEach((url, index) => {
const open = document.createElement("button");
open.type = "button";
open.className = "message-picture";
open.setAttribute("aria-label", "Enlarge image " + (index + 1));
const img = document.createElement("img");
img.setAttribute("src", url);
img.setAttribute("alt", "Attached image " + (index + 1));
open.appendChild(img);
open.addEventListener("click", () => window.LinguaHubImages.openLightbox(url, "Attached image " + (index + 1)));
row.appendChild(open);
});
for (let i = 0; i < missing; i += 1) {
const note = document.createElement("span");
note.className = "message-picture-missing";
note.textContent = "Image (not saved)";
row.appendChild(note);
}
return row;
}

function addMessage(role, text, options) {
const opts = options || {};
const status = opts.status || "complete";
const cssType = role === "user" ? "user" : "ai";
const shouldStick = shouldFollowStream();

const wrapper = document.createElement("div");
wrapper.className = `message ${cssType}`;
if (status === "failed") wrapper.classList.add("error");
wrapper.dataset.role = role;
wrapper.dataset.status = status;
if (opts.messageId) wrapper.dataset.messageId = opts.messageId;
wrapper.dataset.feedback = opts.feedback || "";

// LH identity mark (Phase 14) - assistant messages only, never on the
// user's own messages. Purely decorative brand presence; the message's
// real role is already conveyed structurally (data-role) and visually
// (alignment/color), so this is aria-hidden like every other LH mark.
if (cssType === "ai") {
const avatar = document.createElement("div");
avatar.className = "message-avatar";
avatar.setAttribute("aria-hidden", "true");
if (window.LinguaHubLogo) avatar.appendChild(window.LinguaHubLogo.create("lh-logo lh-logo-sm"));
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
} else if (role === "assistant" && status === "failed") {
renderErrorBlock(contentEl, storedErrorText(text), false);
} else if (role === "assistant" && status !== "failed" && text) {
renderAssistantContentFinal(contentEl, text);
} else if (role === "assistant" && status === "stopped" && !text) {
contentEl.textContent = "(Stopped - no response received)";
} else {
let shownText = text || "";
let pictures = opts.images || [];
let missingPictures = 0;
if (role === "user" && window.LinguaHubImages) {
// History keeps only "[image]" lines for pictures; this session may still hold them.
const parts = window.LinguaHubImages.splitStored(shownText);
if (parts.count) {
shownText = parts.text;
if (!pictures.length) pictures = window.LinguaHubImages.recall(opts.messageId);
if (!pictures.length) missingPictures = parts.count;
}
}
contentEl.textContent = shownText;
applyRtlIfNeeded(contentEl, shownText);
if (pictures.length || missingPictures) {
wrapper.insertBefore(buildMessagePictures(pictures, missingPictures), contentEl);
if (!shownText) contentEl.hidden = true;
}
}

setMessageStatusLabel(wrapper, status);
wrapper.appendChild(buildMessageActions(role, status, wrapper.dataset.feedback));

chatBox.appendChild(wrapper);
if (shouldStick) scrollChatToBottom();
updateScrollButton();
return wrapper;
}

// The status line is visible only when it carries news: offline, or the
// assistant is generating. The idle "Online" state is hidden by CSS
// (.status-bar[data-state="online"]).
function renderStatus() {
const offline = isOffline();
statusEl.textContent = offline ? "Offline" : (isBusy ? "LinguaHub AI is thinking..." : "Online");
if (statusBarEl && typeof statusBarEl.setAttribute === "function") {
statusBarEl.setAttribute("data-state", offline ? "offline" : (isBusy ? "busy" : "online"));
}
if (statusDotEl) statusDotEl.classList.toggle("active", isBusy && !offline);
if (composerHintEl && composerHintEl.classList) {
// While offline the composer explains why Send is disabled, in place of
// the usual AI-accuracy disclaimer, and restores it when back online.
if (offline) {
if (composerHintDefaultText === null) composerHintDefaultText = composerHintEl.textContent;
composerHintEl.textContent = "You're offline. Reconnect to send messages.";
composerHintEl.classList.add("is-offline");
} else if (composerHintDefaultText !== null) {
composerHintEl.textContent = composerHintDefaultText;
composerHintEl.classList.remove("is-offline");
composerHintDefaultText = null;
}
}
if (typeof sendBtn !== "undefined") updateComposerState();
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
window.addEventListener("online", renderStatus);
window.addEventListener("offline", renderStatus);
}
renderStatus();

function setBusy(busy) {
// The composer stays enabled while a reply generates: it keeps focus after
// sending and the next message can already be typed. Sending is blocked in
// sendMessage()/the Enter handler instead, and Send becomes Stop.
modeSelect.disabled = busy;
isBusy = busy;
renderStatus();
sendBtn.classList.toggle("is-stop", busy);
sendBtn.textContent = busy ? "Stop" : "Send";
sendBtn.setAttribute("aria-label", busy ? "Stop generating" : "Send message");
updateComposerState();
}

function isOffline() {
return typeof navigator !== "undefined" && navigator.onLine === false;
}

// Send is disabled for an empty (or whitespace-only) message and while
// offline; while a reply is generating the same button is Stop and stays
// enabled.
function updateComposerState() {
const hasPicture = Boolean(attachments && attachments.count());
const processing = Boolean(attachments && attachments.isBusy());
sendBtn.disabled = isBusy ? false : ((!input.value.trim() && !hasPicture) || processing || isOffline());
}

sendBtn.addEventListener("click", () => {
if (sendBtn.classList.contains("is-stop")) {
abortActiveGeneration();
} else {
sendMessage();
}
});

// Auto-grow while typing. The textarea's CSS max-height is 8 lines, so the
// height set here is clamped there and the field scrolls beyond that.
function autoResizeComposer() {
input.style.height = "auto";
input.style.height = input.scrollHeight + "px";
}
input.addEventListener("input", () => {
autoResizeComposer();
applyRtlIfNeeded(input, input.value);
updateComposerState();
});

chatBox.addEventListener("scroll", () => {
if (chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight < 4) userScrolledUp = false;
updateScrollButton();
});
// Deliberate upward scrolling = "stop following". (Programmatic scrolling
// while streaming only ever moves down, so it can never trip these.)
chatBox.addEventListener("wheel", (e) => {
if (e.deltaY < 0) userScrolledUp = true;
});
let lastTouchY = null;
chatBox.addEventListener("touchstart", (e) => {
lastTouchY = e.touches && e.touches[0] ? e.touches[0].clientY : null;
});
chatBox.addEventListener("touchmove", (e) => {
const y = e.touches && e.touches[0] ? e.touches[0].clientY : null;
if (lastTouchY !== null && y !== null && y > lastTouchY) userScrolledUp = true; // finger down = content up
lastTouchY = y;
});
chatBox.addEventListener("pointerdown", (e) => {
// Grabbing the scrollbar itself (the pointer is over the box's own scrollbar gutter).
if (e.target === chatBox && e.offsetX >= chatBox.clientWidth) userScrolledUp = true;
});
if (scrollToBottomBtn) {
scrollToBottomBtn.addEventListener("click", () => {
userScrolledUp = false;
// Smooth only when nothing is streaming: a smooth scroll aimed at the
// current bottom is already out of date a few frames later while a reply is
// still growing, so the view would never catch up and following would not resume.
if (typeof chatBox.scrollTo === "function") chatBox.scrollTo({ top: chatBox.scrollHeight, behavior: isBusy ? "instant" : "smooth" });
else chatBox.scrollTop = chatBox.scrollHeight;
scrollToBottomBtn.hidden = true;
});
}

// Real prompt-starters only (Task 5) - no fake modes. Clicking populates
// and focuses the composer; the user decides whether/what to send. The
// suggestion set itself is mode-specific (see www/mode-ui.js) and re-rendered
// whenever the selected mode changes.
const HOME_PROMPT_SUGGESTIONS = [
{ label: "Translate text", prompt: "Translate the following text to English:\n\n" },
{ label: "Practice English", prompt: "Help me practice English conversation. " },
{ label: "Practice Arabic", prompt: "Help me practice Arabic conversation. " },
{ label: "Improve writing", prompt: "Improve the clarity and tone of this text:\n\n" },
{ label: "Explain grammar", prompt: "Explain this grammar rule with examples: " },
{ label: "Study vocabulary", prompt: "Help me learn vocabulary for: " }
];

function renderEmptyStateCards() {
if (!emptyStateCardsEl) return;
emptyStateCardsEl.textContent = "";
const suggestions = modeSelect.value === "general"
? HOME_PROMPT_SUGGESTIONS
: window.LinguaHubModeUI
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
updateComposerState();
input.focus();
input.setSelectionRange(input.value.length, input.value.length);
});
emptyStateCardsEl.appendChild(card);
});
}
renderEmptyStateCards();
modeSelect.addEventListener("change", renderEmptyStateCards);
modeSelect.addEventListener("change", () => {
if (!attachments) return;
if (attachments.count() && !window.LinguaHubImages.supportsImages(modeSelect.value)) {
attachments.clear();
if (window.LinguaHubToast) window.LinguaHubToast.show({ type: "info", message: "The pictures were removed: this mode can't read images." });
}
attachments.refresh();
});

// The learning home (language pair, word of the day, progress, mode cards)
// replaces the plain hero while Free chat is selected - www/home-ui.js.
// Mode workspaces: Translate / Speak / Grammar / Vocabulary replace the chat
// while their mode is selected (www/workspace.js and the ws-*.js screens).
if (window.LinguaHubWorkspace && window.linguahubPair) {
window.LinguaHubWorkspace.init({
container: document.querySelector(".container"),
root: document.getElementById("workspace-root"),
modeSelect: modeSelect,
pair: window.linguahubPair,
vocab: window.linguahubVocab,
titleEl: conversationTitleEl,
focusComposer: () => input.focus()
});
}

// Tap a word in an AI message for its meaning - www/word-lookup.js.
if (window.LinguaHubWordLookup && window.linguahubPair) {
window.LinguaHubWordLookup.init({ chatBox: chatBox, pair: window.linguahubPair, vocab: window.linguahubVocab });
}

// "Save words" under the reply to a picture sent on its own - www/image-learning.js.
if (window.LinguaHubImageLearning && window.linguahubPair) {
window.LinguaHubImageLearning.init({
vocab: window.linguahubVocab,
pair: window.linguahubPair,
notify: (message, type) => { if (window.LinguaHubToast) window.LinguaHubToast.show({ type: type || "success", message }); }
});
}

// First launch only: native language, language to learn, level - www/onboarding.js.
if (window.LinguaHubOnboarding && window.linguahubPair) {
window.LinguaHubOnboarding.init({ pair: window.linguahubPair });
}

if (window.LinguaHubHome && window.linguahubPair) {
window.LinguaHubHome.init({
container: document.getElementById("home-root"),
modeSelect: modeSelect,
pair: window.linguahubPair,
vocab: window.linguahubVocab,
focusComposer: () => input.focus()
});
}

// ---------------------------------------------------------------------
// Chat history (conversations sidebar) - see www/chatStore.js and
// www/history-ui.js. history-ui.js owns conversation selection/list state
// and calls back here whenever the active conversation changes so this
// file can rebuild #chat-box from storage; this file owns sending/
// streaming and writes messages straight to historyUI.store as they happen.
// ---------------------------------------------------------------------

const historyUI = window.LinguaHubHistoryUI.init();
// Handle for e2e/debugging (the controller is otherwise a private const).
window.linguahubHistory = historyUI;

// ---------------------------------------------------------------------
// Chat sync (signed-in users): www/chat-sync.js mirrors local chats to
// Firestore and applies changes from other devices. Local history stays the
// source of truth and works offline.
// ---------------------------------------------------------------------
function firestoreOrNull() {
try {
return window.firebase && window.firebase.apps && window.firebase.apps.length && window.firebase.firestore ? window.firebase.firestore() : null;
} catch (err) {
return null;
}
}

// A chat changed (or arrived, or was deleted) on another device.
function handleRemoteChats(ids) {
historyUI.refreshList();
if (isBusy) return; // never disturb a reply that is being written
const activeId = historyUI.store.getActiveConversationId();
if (!activeId || ids.indexOf(activeId) !== -1 || !historyUI.store.getConversation(activeId)) {
historyUI.refreshActive();
}
}

const chatSync = window.LinguaHubChatSync
? window.LinguaHubChatSync.create({
store: historyUI.store,
storage: window.localStorage,
remote: window.LinguaHubChatSync.createFirestoreRemote(firestoreOrNull),
isOnline: () => !isOffline(),
onRemoteChange: handleRemoteChats
})
: null;
window.linguahubSync = chatSync;

// Saved words follow the account too (www/vocab-sync.js): same Firestore
// collection and rules as chats, own document kind.
const vocabSync = window.LinguaHubVocabSync && window.linguahubVocab
? window.LinguaHubVocabSync.create({
store: window.linguahubVocab,
storage: window.localStorage,
remote: window.LinguaHubVocabSync.createFirestoreRemote(firestoreOrNull),
isOnline: () => !isOffline()
})
: null;
window.linguahubVocabSync = vocabSync;

const syncStatusEl = document.getElementById("sync-status");
const syncStatusTextEl = document.getElementById("sync-status-text");
function renderSyncStatus(status) {
if (syncStatusEl) syncStatusEl.setAttribute("data-state", status);
if (syncStatusTextEl) syncStatusTextEl.textContent = window.LinguaHubChatSync.statusText(status);
}
if (chatSync) {
chatSync.onStatusChange(renderSyncStatus);
if (typeof window.addEventListener === "function") {
window.addEventListener("online", () => { chatSync.connectivityChanged(); if (vocabSync) vocabSync.connectivityChanged(); });
window.addEventListener("offline", () => { chatSync.connectivityChanged(); if (vocabSync) vocabSync.connectivityChanged(); });
}
}

// On the first sign-in of an account, offer (once) to upload the chats that
// were saved on this device while signed out. Yes copies them into the
// account's history (they then sync); No leaves them where they are.
async function offerGuestUpload(user) {
if (!chatSync.shouldOfferUpload(user.uid)) return;
const guestChats = historyUI.store.listGuestConversations();
const guestWords = window.linguahubVocab ? window.linguahubVocab.listGuestWords() : [];
if (!guestChats.length && !guestWords.length) return;
const upload = window.LinguaHubDialog
? await window.LinguaHubDialog.confirm(window.LinguaHubChatSync.uploadOffer(guestChats.length, guestWords.length))
: false;
chatSync.recordUploadDecision(user.uid, upload);
if (!upload) return;
const chatResult = guestChats.length ? historyUI.store.mergeConversations(guestChats) : { ok: true, added: 0 };
const wordResult = guestWords.length ? window.linguahubVocab.mergeWords(guestWords) : { ok: true, added: 0 };
if (chatResult.ok && chatResult.added) historyUI.refreshList();
const message = window.LinguaHubChatSync.uploadedToast(chatResult.ok ? chatResult.added : 0, wordResult.ok ? wordResult.added : 0);
if (message && window.LinguaHubToast) window.LinguaHubToast.show({ type: "success", message: message });
}

async function handleSyncUser(user) {
if (vocabSync) {
if (user) vocabSync.start(user);
else vocabSync.stop();
}
if (!chatSync) return;
if (!user) {
chatSync.stop();
return;
}
try { await offerGuestUpload(user); } catch (err) { /* the offer is optional */ }
chatSync.start(user);
}

// Populated once mode-ui.js resolves GET /api/ai/modes (see
// bootstrapModesAndHistory below) - the backend's public mode registry is
// the only source of truth for which mode ids exist and are currently
// enabled/selectable (Task 4).
let availableModes = [];

function renderConversationMessages(conversation) {
if (attachments) attachments.clear();
// Picking or creating a conversation always lands in the chat, even from a
// mode workspace (Translate, Speak, ...).
if (window.LinguaHubWorkspace) window.LinguaHubWorkspace.showChat();
// Never keep reading aloud a message that is about to leave the DOM.
if (window.LinguaHubVoice) window.LinguaHubVoice.stopSpeaking();
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
addMessage(message.role, message.content, { status: message.status, messageId: message.id, feedback: message.feedback });
});
scrollChatToBottom();
}

historyUI.onActiveConversationChanged(renderConversationMessages);

// After the search palette opens a chat: bring the matched message into view
// and flash it. Scrolling there counts as "scrolled up" so a stream that is
// still running does not pull the view back down.
function revealMessage(messageId) {
const target = Array.from(chatBox.children).find((m) => m.dataset && m.dataset.messageId === messageId);
if (!target) return;
userScrolledUp = true;
if (typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "center" });
target.classList.add("is-search-hit");
setTimeout(() => target.classList.remove("is-search-hit"), 2200);
updateScrollButton();
}

if (window.LinguaHubSearchPalette) {
window.LinguaHubSearchPalette.init({
getConversations: () => historyUI.store.listConversations(),
openConversation: (id, messageId) => {
historyUI.selectConversation(id);
if (messageId) revealMessage(messageId);
}
});
}
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
// Enter that confirms an IME composition (Arabic, Chinese, Japanese...)
// must not send the half-composed message.
if (e.isComposing || e.keyCode === 229) return;
if (e.key === "Enter" && !e.shiftKey) {
const enterToSend = window.LinguaHubSettingsUI ? window.LinguaHubSettingsUI.isEnterToSendEnabled() : true;
if (enterToSend) {
e.preventDefault();
if (!isBusy) sendMessage();
}
}
});

// Esc stops a running generation (the message keeps its partial text).
// Anything that owns Escape first - an open dialog, the chat menu, the edit
// box (they call preventDefault) - wins.
if (typeof document.addEventListener === "function") {
document.addEventListener("keydown", (e) => {
if (e.key !== "Escape" || e.defaultPrevented || !isBusy) return;
if (typeof document.querySelector === "function" && document.querySelector(".lh-dialog-backdrop")) return;
const menuList = document.getElementById("chat-menu-list");
if (menuList && !menuList.hidden) return;
abortActiveGeneration();
});
}

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

let streamText = "";
const throttledRender = window.LinguaHubChatStore.throttle((text) => renderStreamingContent(aiBubble, text), 80);

const response = await fetch(apiUrl("/api/chat/stream"), {
method: "POST",
headers: Object.assign({ "Content-Type": "application/json" }, authHeaders),
body: JSON.stringify({ messages: requestMessages, mode }),
signal: activeChatAbortController.signal
});

if (!response.ok || !response.body) {
const httpError = new Error(`Server responded ${response.status}`);
httpError.status = response.status;
throw httpError;
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
const streamError = new Error(parsed.error);
streamError.serverMessage = parsed.error;
throw streamError;
}
if (parsed.delta) {
if (!receivedAny) {
// First real token: clear the typing indicator (Task 7 - shown
// only until meaningful streamed text begins).
aiBubble.contentEl.textContent = "";
}
receivedAny = true;
// streamText is the Markdown SOURCE; the bubble shows its rendering, so
// the DOM text can no longer be used as the source of truth.
streamText += parsed.delta;
aiBubble.rawText = streamText;
throttledRender(streamText);
throttledSave(streamText);
}
}
}
} finally {
throttledRender.flush();
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
const fallbackError = new Error(data.reply || `Server responded ${response.status}`);
fallbackError.status = response.status;
throw fallbackError;
}
const replyText = data.reply || "❌ Empty response from server.";
aiBubble.contentEl.textContent = replyText;
aiBubble.rawText = replyText;
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
// picture (optional): { text, images } for the user message uptoMessageId - the
// text sent to the AI for it (the typed text, or the picture-lesson
// instruction) and its pictures. Only this last message carries pictures.
function buildMessagesForRequest(conversationId, uptoMessageId, fallbackText, picture) {
const withPicture = (message) => (picture && picture.images && picture.images.length
? { role: "user", content: picture.text, images: picture.images }
: message);
if (conversationId) {
const conversation = historyUI.store.getConversation(conversationId);
if (conversation) {
const messages = [];
for (const m of conversation.messages) {
if (m.role !== "user" && m.role !== "assistant") continue;
if (m.status === "failed") continue;
if (!m.content) continue;
const entry = { role: m.role, content: m.content };
messages.push(m.id === uptoMessageId ? withPicture(entry) : entry);
if (m.id === uptoMessageId) break;
}
if (messages.length) return messages;
}
}
return [withPicture({ role: "user", content: fallbackText })];
}

// The text and pictures to send for a stored user message (Retry / Regenerate),
// from what this session still remembers. null when the message had pictures that
// are gone (after a reload); undefined-free for plain text messages.
function pictureForStoredMessage(userMsg) {
if (!window.LinguaHubImages) return { picture: undefined };
const parts = window.LinguaHubImages.splitStored(userMsg.content);
if (!parts.count) return { picture: undefined };
const images = window.LinguaHubImages.recall(userMsg.id);
if (!images.length) return null;
return { picture: { text: pictureRequestText(parts.text, images.length), images }, lesson: !parts.text && modeSelect.value === "general" };
}

function pictureRequestText(typed, count) {
if (!window.LinguaHubImageLearning || !window.linguahubPair) return typed || "Describe this picture.";
return window.LinguaHubImageLearning.requestText({ typed, imageCount: count, pair: window.linguahubPair.get(), languages: window.LinguaHubLanguages });
}

// Shared by a brand-new send, regenerate, and retry - the one place that
// owns "run a generation into this bubble and persist the outcome", so
// none of the three call sites can drift out of sync or double-implement
// the streaming/fallback/abort/status logic.
async function generateAssistantReply(conversationId, requestMessages, mode, assistantMessageId, aiBubble) {
setBusy(true);
// Tells chat sync not to upload or overwrite this chat until the reply settles.
if (chatSync) chatSync.setGenerating(conversationId);
// Regenerate/retry reuse a bubble that still holds the previous reply's source.
aiBubble.rawText = "";
aiBubble.dataset.feedback = "";

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
let failure = err;
// The non-streaming fallback is only worth trying when nothing has been
// received yet and the request itself was not at fault (see isClientFault).
if (!aiBubble.rawText && !isClientFault(err)) {
try {
await fallbackChat(requestMessages, mode, aiBubble);
failure = null;
} catch (fallbackErr) {
failure = fallbackErr.status ? fallbackErr : err;
}
}
if (failure) {
const friendly = describeChatError(failure);
aiBubble.classList.add("error");
aiBubble.rawText = friendly;
renderErrorBlock(aiBubble.contentEl, friendly, true);
finalStatus = "failed";
}
}
} finally {
// The Markdown SOURCE (tracked while streaming; the bubble itself now
// shows rendered HTML, whose textContent is not the source). Non-streamed
// paths (fallback, errors, stop-before-first-token) set the DOM text only.
const rawText = aiBubble.rawText || aiBubble.contentEl.textContent;
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
if (chatSync) chatSync.setGenerating(null);
// Voice chat hook (Phase 14, www/voice.js): auto-read and Voice Mode's
// listen -> reply -> speak loop both key off this one settled event.
if (typeof CustomEvent === "function") {
document.dispatchEvent(new CustomEvent("linguahub:assistant-reply", {
detail: { text: isHardError ? "" : rawText, status: finalStatus, wrapper: aiBubble }
}));
}
}
}

async function sendMessage() {
const message = input.value.trim();
const pictures = attachments ? attachments.getImages() : [];
if ((!message && !pictures.length) || isBusy) return;
if (attachments && attachments.isBusy()) return;
if (isOffline()) {
// Keep the draft; the composer already explains why Send is disabled.
if (window.LinguaHubToast) window.LinguaHubToast.show({ type: "warning", message: "You're offline. Reconnect to send messages." });
return;
}

const mode = modeSelect.value;
if (pictures.length && !window.LinguaHubImages.supportsImages(mode)) {
if (window.LinguaHubToast) window.LinguaHubToast.show({ type: "warning", message: "This mode can't read images. Remove them or switch to Free chat." });
return;
}
if (typeof CustomEvent === "function") {
document.dispatchEvent(new CustomEvent("linguahub:tutor-message", { detail: { mode } }));
}
const conversationId = historyUI.store.getActiveConversationId();

if (emptyStateEl) emptyStateEl.hidden = true;

// Created up front (not just at save time) so its id can be attached to
// the DOM wrapper below - otherwise the Edit action has no message id to
// look up in the store.
// History and sync keep the text plus one "[image]" line per picture - never the pictures.
const storedText = pictures.length ? window.LinguaHubImages.storedContent(message, pictures.length) : message;
const userMessage = window.LinguaHubChatStore.createMessage("user", storedText, "complete");
if (pictures.length) window.LinguaHubImages.remember(userMessage.id, pictures);
userScrolledUp = false;
addMessage("user", message, { status: "complete", messageId: userMessage.id, images: pictures });
scrollChatToBottom();
if (attachments) attachments.take();
input.value = "";
input.style.height = "auto";
input.removeAttribute("dir");
updateComposerState();
input.focus();

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
// A picture sent on its own in Free chat is a little lesson: description + 5 words
// (www/image-learning.js adds "Save words" under the reply).
if (pictures.length && !message && mode === "general") aiBubble.dataset.imageLesson = "1";

const requestMessages = buildMessagesForRequest(conversationId, userMessage.id, message,
pictures.length ? { text: pictureRequestText(message, pictures.length), images: pictures } : undefined);
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

if (isOffline()) {
if (window.LinguaHubToast) window.LinguaHubToast.show({ type: "warning", message: "You're offline. Reconnect to try again." });
return;
}

const userMsg = findUserPromptForAssistant(conversationId, assistantMessageId);
if (!userMsg) {
if (window.LinguaHubToast) {
window.LinguaHubToast.show({ type: "error", message: "Could not find the original prompt to regenerate from." });
}
return;
}

// Pictures are not stored, so after a reload there is nothing to retry with.
const stored = pictureForStoredMessage(userMsg);
if (!stored) {
if (window.LinguaHubToast) window.LinguaHubToast.show({ type: "warning", message: "That picture isn't saved. Attach it again to ask once more." });
return;
}

abortActiveGeneration();
if (stored.lesson) wrapper.dataset.imageLesson = "1";
else delete wrapper.dataset.imageLesson;

const conversation = historyUI.store.getConversation(conversationId);
const mode = (conversation && conversation.metadata && conversation.metadata.mode) || modeSelect.value;

wrapper.classList.remove("error");
wrapper.contentEl.removeAttribute("dir");
showTypingIndicator(wrapper.contentEl);
refreshMessageActions(wrapper, "streaming");

const requestMessages = buildMessagesForRequest(conversationId, userMsg.id, userMsg.content, stored.picture);
await generateAssistantReply(conversationId, requestMessages, mode, assistantMessageId, wrapper);
}

// Thumbs up/down on an assistant reply - stored locally with the message,
// clicking the active one again clears it. Updates the two buttons in place
// (no re-render, so focus stays on the button).
function handleFeedback(wrapper, value) {
const next = wrapper.dataset.feedback === value ? "" : value;
wrapper.dataset.feedback = next;
wrapper.querySelectorAll('.message-action-btn[data-action^="feedback-"]').forEach((btn) => {
btn.setAttribute("aria-pressed", String(btn.dataset.action === "feedback-" + next));
});
const conversationId = historyUI.store.getActiveConversationId();
if (conversationId && wrapper.dataset.messageId && typeof historyUI.store.setMessageFeedback === "function") {
historyUI.store.setMessageFeedback(conversationId, wrapper.dataset.messageId, next || null);
}
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
if (window.LinguaHubImages && window.LinguaHubImages.splitStored(originalText).count) {
if (window.LinguaHubToast) window.LinguaHubToast.show({ type: "info", message: "Messages with pictures can't be edited. Send a new one instead." });
return;
}
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
else if (action === "speak" && window.LinguaHubVoice) window.LinguaHubVoice.toggleReadAloud(wrapper);
else if (action === "feedback-up" || action === "feedback-down") handleFeedback(wrapper, action === "feedback-up" ? "up" : "down");
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
const accountSettingsBtn = document.getElementById("account-settings-btn");
if (accountSettingsBtn) {
accountSettingsBtn.addEventListener("click", () => {
if (window.LinguaHubSettingsUI && typeof window.LinguaHubSettingsUI.open === "function") window.LinguaHubSettingsUI.open({ tab: "account" });
else settingsBtn.click();
});
}

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
// Saved words are per account, like chats.
if (window.linguahubVocab) window.linguahubVocab.setUserId(user && user.uid ? user.uid : null);
handleSyncUser(user);
});
} else {
loginBtn.disabled = true;
setAuthStatus(
window.LinguaHubAuth
? "Sign-in is unavailable: Firebase is not configured for this app."
: "Sign-in is unavailable: the Firebase SDK failed to load."
);
}
