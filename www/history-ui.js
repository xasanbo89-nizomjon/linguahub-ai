"use strict";

// LinguaHub AI - conversation sidebar (list, search, rename, delete, clear,
// import/export) wired on top of the pure www/chatStore.js repository.
//
// Ownership split with www/app.js:
//   - history-ui.js owns conversation SELECTION/list state and persistence
//     of everything except the live streaming token buffer.
//   - app.js owns sending/streaming and calls LinguaHubHistoryUI.store
//     directly to persist user/assistant messages as they happen, then
//     calls LinguaHubHistoryUI.refreshList() so the sidebar reflects the
//     new title/timestamp/order.
//   - When the user picks a different conversation (or a new one is
//     created/restored), history-ui.js calls back into app.js's registered
//     onActiveConversationChanged handler to rebuild the visible chat-box
//     from that conversation's stored messages - app.js owns all chat-box
//     DOM rendering, history-ui.js never touches #chat-box directly.

var LinguaHubHistoryUI = (function () {
"use strict";

function debounce(fn, waitMs) {
var timer = null;
return function () {
var args = arguments;
if (timer) clearTimeout(timer);
timer = setTimeout(function () { fn.apply(null, args); }, waitMs);
};
}

function formatRelativeTime(iso) {
var then = new Date(iso).getTime();
if (isNaN(then)) return "";
var diffMs = Date.now() - then;
var minute = 60000, hour = 3600000, day = 86400000;
if (diffMs < minute) return "just now";
if (diffMs < hour) return Math.floor(diffMs / minute) + "m ago";
if (diffMs < day) return Math.floor(diffMs / hour) + "h ago";
if (diffMs < day * 7) return Math.floor(diffMs / day) + "d ago";
return new Date(then).toLocaleDateString();
}

// UTF-8-safe base64 encoding (plain btoa() only handles Latin1, and this
// app's exports routinely contain non-Latin1 text - Arabic/Russian/Uzbek
// messages, etc.).
function toBase64Utf8(str) {
var bytes = new TextEncoder().encode(str);
var binary = "";
for (var i = 0; i < bytes.length; i += 1) {
binary += String.fromCharCode(bytes[i]);
}
return btoa(binary);
}

function downloadTextFile(filename, content, mimeType) {
// A data: URL, not a blob: URL - found via real Electron runtime testing
// (Phase 9) that Electron's native download handling does not reliably
// fire for blob: URL downloads triggered via <a download> (a known
// Electron/Chromium limitation with blob-URL downloads specifically,
// separate from this app's own logic), so clicking Export silently
// produced no file despite reporting success. data: URLs use the same
// <a download> mechanism but are handled reliably by Electron's downloader
// - verified live after this change. Works identically in every browser
// this app already supports (data URLs are equally well-supported there).
var dataUrl = "data:" + mimeType + ";base64," + toBase64Utf8(content);
var link = document.createElement("a");
link.href = dataUrl;
link.download = filename;
document.body.appendChild(link);
link.click();
document.body.removeChild(link);
}

function safeFilenameFromTitle(title) {
var slug = String(title || "chat")
.trim()
.toLowerCase()
.replace(/[^a-z0-9]+/gi, "-")
.replace(/^-+|-+$/g, "")
.slice(0, 40) || "chat";
var date = new Date().toISOString().slice(0, 10);
return "linguahub-ai-" + slug + "-" + date;
}

function init(options) {
var opts = options || {};
var store = (opts.store) || (window.LinguaHubChatStore && window.LinguaHubChatStore.createChatStore({ storage: window.localStorage }));

var sidebar = document.getElementById("sidebar");
var appShell = document.getElementById("app-shell");
var sidebarToggleBtn = document.getElementById("sidebar-toggle-btn");
var sidebarBackdrop = document.getElementById("sidebar-backdrop");
var sidebarCollapseBtn = document.getElementById("sidebar-collapse-btn");
var newChatBtn = document.getElementById("new-chat-btn");
var searchInput = document.getElementById("chat-search-input");
var listEl = document.getElementById("conversation-list");
var emptyStateEl = document.getElementById("conversation-empty-state");
var exportBtn = document.getElementById("export-chat-btn");
var importInput = document.getElementById("import-chat-input");
var clearChatBtn = document.getElementById("clear-chat-btn");
var historyStatusEl = document.getElementById("history-status");

var activeConversationChangedHandler = null;
var abortActiveGenerationFn = null;
var currentQuery = "";
var drawerKeydownHandler = null;

function setHistoryStatus(text) {
if (historyStatusEl) historyStatusEl.textContent = text || "";
}

// Falls back to the native dialog only if dialog.js somehow isn't loaded
// (it always is, in this app's own index.html) - keeps this module usable
// standalone/defensively rather than hard-depending on load order.
function confirmDialog(opts) {
if (window.LinguaHubDialog) return window.LinguaHubDialog.confirm(opts);
return Promise.resolve(window.confirm((opts.title ? opts.title + ": " : "") + (opts.message || "")));
}

function notify(type, message) {
if (window.LinguaHubToast) window.LinguaHubToast.show({ type: type, message: message });
}

function abortActiveGeneration() {
if (typeof abortActiveGenerationFn === "function") abortActiveGenerationFn();
}

function notifyActiveConversationChanged(conversation) {
if (typeof activeConversationChangedHandler === "function") {
activeConversationChangedHandler(conversation);
}
}

// ---------------------------------------------------------------------
// Conversation list: groups (Pinned, Today, Yesterday, ...), a "..." menu per
// chat (Rename / Pin / Delete), inline rename, delete with Undo.
// ---------------------------------------------------------------------

// Inline rename state; kept outside renderList so a re-render (e.g. when a
// reply finishes) rebuilds the input with what the user has typed so far
// instead of throwing it away.
var renaming = null; // { id, value } | null
var openMenu = null; // { el, anchor, cleanup } | null

function groupsFor(conversations) {
if (currentQuery) return [{ key: "results", label: null, items: conversations }];
if (window.LinguaHubChatGroups) return window.LinguaHubChatGroups.groupConversations(conversations, new Date());
return [{ key: "all", label: null, items: conversations }];
}

function renderList() {
if (!listEl) return;
var conversations = currentQuery ? store.searchConversations(currentQuery) : store.listConversations();
var activeId = store.getActiveConversationId();

closeItemMenu();
listEl.textContent = "";

if (!conversations.length) {
if (emptyStateEl) {
emptyStateEl.hidden = false;
emptyStateEl.textContent = currentQuery ? "No conversations match your search." : "No conversations yet. Start a new chat.";
}
return;
}
if (emptyStateEl) emptyStateEl.hidden = true;

var focusInput = null;
groupsFor(conversations).forEach(function (group, groupIndex) {
var groupEl = document.createElement("div");
groupEl.className = "conversation-group";

var labelId = "conversation-group-" + groupIndex;
if (group.label) {
var labelEl = document.createElement("div");
labelEl.className = "conversation-group-label";
labelEl.id = labelId;
labelEl.textContent = group.label;
groupEl.appendChild(labelEl);
}

// Each group is its own list, so list semantics stay valid with the
// labels in between (a role="list" may only own listitems).
var itemsEl = document.createElement("div");
itemsEl.className = "conversation-group-items";
itemsEl.setAttribute("role", "list");
if (group.label) itemsEl.setAttribute("aria-labelledby", labelId);
else itemsEl.setAttribute("aria-label", "Conversations");

group.items.forEach(function (conv) {
var built = buildConversationItem(conv, activeId);
itemsEl.appendChild(built.item);
if (built.input) focusInput = built.input;
});
groupEl.appendChild(itemsEl);
listEl.appendChild(groupEl);
});

if (focusInput) {
focusInput.focus();
if (typeof focusInput.select === "function") focusInput.select();
}
}

function buildConversationItem(conv, activeId) {
var item = document.createElement("div");
item.className = "conversation-item" + (conv.id === activeId ? " active" : "");
// role="listitem" (not "option") because this row contains real nested
// interactive controls - the ARIA option/listbox pattern disallows
// focusable descendants of an option (axe "nested-interactive", Phase 7).
// aria-current (not aria-selected) marks the active item.
item.setAttribute("role", "listitem");
if (conv.id === activeId) item.setAttribute("aria-current", "true");
item.tabIndex = 0;
// Long titles are cut with an ellipsis (CSS); the full title is the tooltip.
item.setAttribute("title", conv.title);

var main = document.createElement("div");
main.className = "conversation-item-main";

var input = null;
var isRenaming = renaming && renaming.id === conv.id;
if (isRenaming) {
input = buildRenameInput(conv);
main.appendChild(input);
} else {
var titleEl = document.createElement("div");
titleEl.className = "conversation-item-title";
titleEl.textContent = conv.title; // textContent only - never innerHTML
main.appendChild(titleEl);
}

var actions = document.createElement("div");
actions.className = "conversation-item-actions";

var menuBtn = document.createElement("button");
menuBtn.type = "button";
menuBtn.className = "conversation-item-menu-btn";
menuBtn.setAttribute("aria-label", "Actions for " + conv.title);
menuBtn.setAttribute("aria-haspopup", "menu");
menuBtn.setAttribute("aria-expanded", "false");
menuBtn.textContent = "⋯";
menuBtn.addEventListener("click", function (e) {
e.stopPropagation();
if (openMenu && openMenu.anchor === menuBtn) closeItemMenu(true);
else openItemMenu(conv, menuBtn);
});
actions.appendChild(menuBtn);

item.appendChild(main);
if (!isRenaming) item.appendChild(actions);

function select() { selectConversation(conv.id); }
item.addEventListener("click", function () { if (!isRenaming) select(); });
item.addEventListener("contextmenu", function (e) {
if (isRenaming) return;
e.preventDefault();
openItemMenu(conv, menuBtn);
});
item.addEventListener("keydown", function (e) {
// Only the row itself (not nested controls) selects on Enter/Space -
// keydown bubbles from whichever element is focused, and handling it here
// for a nested button would swallow that button's own activation (found
// via real keyboard testing, Phase 7).
if (e.target !== item || isRenaming) return;
if (e.key === "Enter" || e.key === " ") {
e.preventDefault();
select();
}
});

return { item: item, input: input };
}

function buildRenameInput(conv) {
var input = document.createElement("input");
input.type = "text";
input.className = "conversation-rename-input";
input.value = renaming.value;
input.maxLength = store.LIMITS.maxTitleChars;
input.setAttribute("aria-label", "Rename conversation");
input.addEventListener("input", function () { if (renaming) renaming.value = input.value; });
input.addEventListener("click", function (e) { e.stopPropagation(); });
input.addEventListener("keydown", function (e) {
e.stopPropagation();
if (e.key === "Enter") { e.preventDefault(); commitRename(conv.id, input.value); }
else if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
});
// Leaving the field saves, like most apps (Escape is the way to abandon).
input.addEventListener("blur", function () { if (renaming && renaming.id === conv.id) commitRename(conv.id, input.value); });
return input;
}

function startRename(conv) {
renaming = { id: conv.id, value: conv.title };
renderList();
}

function cancelRename() {
renaming = null;
renderList();
}

function commitRename(id, value) {
if (!renaming || renaming.id !== id) return;
renaming = null; // first: the re-render below removes the focused input
var next = String(value || "").trim();
var conversation = store.getConversation(id);
if (!conversation || !next || next === conversation.title) { renderList(); return; }
var result = store.renameConversation(id, next);
if (!result.ok) {
setHistoryStatus("Could not rename conversation.");
notify("error", "Could not rename conversation.");
renderList();
return;
}
renderList();
if (id === store.getActiveConversationId()) notifyActiveConversationChanged(result.conversation);
}

function togglePin(conv) {
// touch:false - pinning must not change the chat's last-updated time (and
// with it the date group it belongs to once unpinned).
var result = store.updateConversation(conv.id, { pinned: !conv.pinned }, { touch: false });
if (!result.ok) {
notify("error", "Could not " + (conv.pinned ? "unpin" : "pin") + " this chat.");
return;
}
renderList();
}

function closeItemMenu(returnFocus) {
if (!openMenu) return;
var state = openMenu;
openMenu = null;
state.cleanup();
try { document.body.removeChild(state.el); } catch (err) { /* already gone */ }
if (state.anchor) {
state.anchor.setAttribute("aria-expanded", "false");
if (returnFocus && typeof state.anchor.focus === "function") state.anchor.focus();
}
}

function openItemMenu(conv, anchor) {
closeItemMenu();
var menu = document.createElement("div");
menu.className = "conversation-menu";
menu.setAttribute("role", "menu");
menu.setAttribute("aria-label", "Actions for " + conv.title);

var entries = [
{ label: "Rename", run: function () { startRename(conv); } },
{ label: conv.pinned ? "Unpin" : "Pin", run: function () { togglePin(conv); } },
{ label: "Delete", danger: true, run: function () { handleDelete(conv.id, conv.title); } }
];
var buttons = entries.map(function (entry) {
var btn = document.createElement("button");
btn.type = "button";
btn.className = "conversation-menu-item" + (entry.danger ? " conversation-menu-item-danger" : "");
btn.setAttribute("role", "menuitem");
btn.textContent = entry.label;
btn.addEventListener("click", function (e) {
e.stopPropagation();
closeItemMenu();
entry.run();
});
menu.appendChild(btn);
return btn;
});

// Appended to <body> and positioned against the viewport: the list itself
// scrolls and clips, which would cut a menu placed inside it.
document.body.appendChild(menu);
if (typeof anchor.getBoundingClientRect === "function") {
var rect = anchor.getBoundingClientRect();
var width = 168;
menu.style.left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)) + "px";
var below = rect.bottom + 4;
var menuHeight = 3 * 40 + 12;
menu.style.top = (below + menuHeight > window.innerHeight ? Math.max(8, rect.top - menuHeight - 4) : below) + "px";
}
anchor.setAttribute("aria-expanded", "true");

function onDocumentPointer(e) {
if (!menu.contains(e.target) && e.target !== anchor) closeItemMenu();
}
function onKeydown(e) {
if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeItemMenu(true); return; }
var index = buttons.indexOf(document.activeElement);
if (e.key === "ArrowDown") { e.preventDefault(); buttons[(index + 1) % buttons.length].focus(); }
else if (e.key === "ArrowUp") { e.preventDefault(); buttons[(index - 1 + buttons.length) % buttons.length].focus(); }
else if (e.key === "Tab") { closeItemMenu(); }
}
document.addEventListener("mousedown", onDocumentPointer, true);
document.addEventListener("keydown", onKeydown, true);
var listScrollTarget = listEl;
var onScroll = function () { closeItemMenu(); };
if (listScrollTarget && typeof listScrollTarget.addEventListener === "function") listScrollTarget.addEventListener("scroll", onScroll);

openMenu = {
el: menu,
anchor: anchor,
cleanup: function () {
document.removeEventListener("mousedown", onDocumentPointer, true);
document.removeEventListener("keydown", onKeydown, true);
if (listScrollTarget && typeof listScrollTarget.removeEventListener === "function") listScrollTarget.removeEventListener("scroll", onScroll);
}
};
if (buttons[0] && typeof buttons[0].focus === "function") buttons[0].focus();
}

function selectConversation(id) {
if (id === store.getActiveConversationId()) return;
abortActiveGeneration();
var result = store.setActiveConversationId(id);
if (!result.ok) return;
renderList();
notifyActiveConversationChanged(store.getConversation(id));
closeMobileDrawer();
}

function handleNewChat() {
abortActiveGeneration();
var result = store.createConversation();
if (!result.ok) {
setHistoryStatus("Could not create a new chat: storage is full.");
return;
}
renderList();
notifyActiveConversationChanged(result.conversation);
closeMobileDrawer();
}

async function handleDelete(id, title) {
var confirmed = await confirmDialog({
title: "Delete conversation",
message: 'Delete "' + title + '"? This cannot be undone.',
confirmLabel: "Delete",
destructive: true
});
if (!confirmed) return;

var wasActive = id === store.getActiveConversationId();
if (wasActive) abortActiveGeneration();

// Kept so Undo can put the chat back exactly as it was.
var snapshot = JSON.parse(JSON.stringify(store.getConversation(id)));
var result = store.deleteConversation(id);
if (!result.ok) {
setHistoryStatus("Could not delete conversation.");
notify("error", "Could not delete conversation.");
return;
}
renderList();
if (wasActive) {
var nextActive = result.activeConversationId ? store.getConversation(result.activeConversationId) : null;
notifyActiveConversationChanged(nextActive);
}
showUndoToast(snapshot, wasActive);
}

var UNDO_WINDOW_MS = 5000;

function showUndoToast(snapshot, wasActive) {
if (!window.LinguaHubToast) return;
window.LinguaHubToast.show({
type: "info",
message: "Deleted \u201C" + snapshot.title + "\u201D.",
duration: UNDO_WINDOW_MS,
action: {
label: "Undo",
onClick: function () {
var restored = store.restoreConversation(snapshot);
if (!restored.ok) {
notify("error", "Could not restore the conversation.");
return;
}
if (wasActive) store.setActiveConversationId(snapshot.id);
renderList();
if (wasActive) notifyActiveConversationChanged(store.getConversation(snapshot.id));
}
}
});
}

async function handleClearActiveConversation() {
var activeId = store.getActiveConversationId();
if (!activeId) return;
var confirmed = await confirmDialog({
title: "Clear conversation",
message: "Clear all messages in this conversation? This cannot be undone.",
confirmLabel: "Clear",
destructive: true
});
if (!confirmed) return;

abortActiveGeneration();
var result = store.clearConversationMessages(activeId);
if (!result.ok) {
setHistoryStatus("Could not clear conversation.");
notify("error", "Could not clear conversation.");
return;
}
renderList();
notifyActiveConversationChanged(result.conversation);
notify("success", "Conversation cleared.");
}

async function handleClearAllConversations() {
var confirmed = await confirmDialog({
title: "Clear all local history",
message: "Delete every conversation in this " + (store.getNamespace() === "guest" ? "guest" : "account") + " history on this device? This cannot be undone.",
confirmLabel: "Clear everything",
destructive: true
});
if (!confirmed) return false;

abortActiveGeneration();
var result = store.clearAllConversations();
if (!result.ok) {
notify("error", "Could not clear local history.");
return false;
}
renderList();
notifyActiveConversationChanged(result.conversation);
notify("success", "Local history cleared.");
return true;
}

function handleExport() {
var activeId = store.getActiveConversationId();
if (!activeId) {
setHistoryStatus("Nothing to export yet.");
notify("info", "Nothing to export yet.");
return;
}
var result = store.exportConversationJson(activeId);
if (!result.ok) {
setHistoryStatus("Could not export this conversation.");
notify("error", "Could not export this conversation.");
return;
}
var conversation = store.getConversation(activeId);
downloadTextFile(safeFilenameFromTitle(conversation.title) + ".json", result.json, "application/json");
setHistoryStatus("Exported.");
notify("success", "Exported “" + conversation.title + "”.");
}

function handleImportFile(file) {
if (!file) return;
if (file.size > store.LIMITS.maxImportBytes) {
setHistoryStatus("Import failed: file is too large.");
notify("error", "Import failed: file is too large.");
return;
}
var reader = new FileReader();
reader.onload = function () {
var result = store.importConversationJson(String(reader.result || ""));
if (!result.ok) {
var msg = "Import failed: " + (result.reason || "invalid file") + ".";
setHistoryStatus(msg);
notify("error", msg);
return;
}
renderList();
notifyActiveConversationChanged(result.conversation);
setHistoryStatus("Imported “" + result.conversation.title + "”.");
notify("success", "Imported “" + result.conversation.title + "”.");
};
reader.onerror = function () {
setHistoryStatus("Import failed: could not read the file.");
notify("error", "Import failed: could not read the file.");
};
reader.readAsText(file);
}

var DRAWER_FOCUSABLE_SELECTOR = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function trapDrawerFocus(event) {
if (!sidebar) return;
// querySelectorAll only sees DOM structure, not CSS - a control inside a
// [hidden] ancestor (e.g. #logout-btn inside #user-profile in guest
// mode) still matches ":not([disabled])" even though it can never
// actually receive focus. offsetParent is null for anything not
// actually rendered (display:none, or a [hidden] ancestor), which is
// exactly what real Tab navigation itself already skips - filtering on
// it keeps the trap's first/last in sync with true keyboard reality.
var focusable = Array.prototype.slice.call(sidebar.querySelectorAll(DRAWER_FOCUSABLE_SELECTOR)).filter(function (el) {
return el.offsetParent !== null;
});
if (!focusable.length) return;
var first = focusable[0];
var last = focusable[focusable.length - 1];
if (event.shiftKey && document.activeElement === first) {
event.preventDefault();
last.focus();
} else if (!event.shiftKey && document.activeElement === last) {
event.preventDefault();
first.focus();
}
}

function onDrawerKeydown(event) {
if (event.key === "Escape") {
event.preventDefault();
closeMobileDrawer();
} else if (event.key === "Tab") {
trapDrawerFocus(event);
}
}

function openMobileDrawer() {
if (!appShell) return;
appShell.classList.add("sidebar-open");
if (sidebarToggleBtn) sidebarToggleBtn.setAttribute("aria-expanded", "true");
if (sidebarBackdrop) sidebarBackdrop.hidden = false;
document.body.classList.add("lh-scroll-locked");
drawerKeydownHandler = onDrawerKeydown;
document.addEventListener("keydown", drawerKeydownHandler, true);
if (newChatBtn) setTimeout(function () { newChatBtn.focus(); }, 0);
}

// Idempotent and safe to call even when the drawer isn't open, or on a
// desktop viewport where "sidebar-open" has no visual effect - always
// tears down the backdrop/scroll-lock/listener so nothing can leak.
function closeMobileDrawer() {
if (!appShell) return;
appShell.classList.remove("sidebar-open");
if (sidebarToggleBtn) sidebarToggleBtn.setAttribute("aria-expanded", "false");
if (sidebarBackdrop) sidebarBackdrop.hidden = true;
document.body.classList.remove("lh-scroll-locked");
if (drawerKeydownHandler) {
document.removeEventListener("keydown", drawerKeydownHandler, true);
drawerKeydownHandler = null;
}
if (sidebarToggleBtn && sidebar && document.activeElement && sidebar.contains(document.activeElement)) {
sidebarToggleBtn.focus();
}
}

function toggleMobileDrawer() {
if (!appShell) return;
if (appShell.classList.contains("sidebar-open")) {
closeMobileDrawer();
} else {
openMobileDrawer();
}
}

// Desktop sidebar collapse (icons-only rail) - purely a layout preference,
// persisted separately from any conversation data.
var SIDEBAR_COLLAPSE_KEY = "linguahub-ai:sidebar-collapsed";

function applySidebarCollapsed(collapsed) {
if (!appShell) return;
appShell.classList.toggle("sidebar-collapsed", collapsed);
if (sidebarCollapseBtn) {
sidebarCollapseBtn.setAttribute("aria-expanded", collapsed ? "false" : "true");
sidebarCollapseBtn.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
}
}

if (sidebarCollapseBtn) {
var storedCollapsedRaw = null;
try { storedCollapsedRaw = window.localStorage.getItem(SIDEBAR_COLLAPSE_KEY); } catch (err) { storedCollapsedRaw = null; }
var storedCollapsed;
if (storedCollapsedRaw === null) {
// Task 12 (embedded panel readiness): a narrow embedded panel
// (desktop right-side, ~420-480px - see docs/integration-prep/
// embedded-mode.md) shouldn't default to a persistent 272px
// conversation-history rail eating most of its width. Reuses the
// EXISTING collapsed-icon-rail mechanism (already tested, and
// width-independent - it works the same at any viewport size,
// unlike the mobile off-canvas drawer, which only engages under a
// max-width media query) rather than building new responsive
// infrastructure. Only the very first, ever-untouched default
// differs by mode - the moment ANY user (embedded or standalone)
// explicitly toggles it once, that stored choice wins from then on,
// exactly as it always has.
storedCollapsed = Boolean(window.LinguaHubAppMode && window.LinguaHubAppMode.isEmbedded);
} else {
storedCollapsed = storedCollapsedRaw === "true";
}
applySidebarCollapsed(storedCollapsed);

sidebarCollapseBtn.addEventListener("click", function () {
var next = !(appShell && appShell.classList.contains("sidebar-collapsed"));
applySidebarCollapsed(next);
try { window.localStorage.setItem(SIDEBAR_COLLAPSE_KEY, String(next)); } catch (err) { /* non-fatal */ }
});
}

if (newChatBtn) newChatBtn.addEventListener("click", handleNewChat);
if (clearChatBtn) clearChatBtn.addEventListener("click", handleClearActiveConversation);
if (exportBtn) exportBtn.addEventListener("click", handleExport);
if (sidebarToggleBtn) sidebarToggleBtn.addEventListener("click", toggleMobileDrawer);
if (sidebarBackdrop) sidebarBackdrop.addEventListener("click", closeMobileDrawer);
if (importInput) {
importInput.addEventListener("change", function () {
var file = importInput.files && importInput.files[0];
handleImportFile(file);
importInput.value = ""; // allow re-importing the same filename later
});
}

// The Import control is a <label for="import-chat-input"> wrapping a
// hidden file input (index.html) - a mouse click on the label natively
// forwards to the input via the browser's own label/for behavior, but
// that's mouse-only. tabindex="0" (index.html) makes the label reachable
// by Tab; this handler gives it the same Enter/Space activation any real
// button already has, so keyboard users can trigger the same file picker.
var importLabel = document.getElementById("import-label-btn");
if (importLabel && importInput) {
importLabel.addEventListener("keydown", function (event) {
if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
event.preventDefault();
importInput.click();
}
});
}
if (searchInput) {
searchInput.addEventListener("input", debounce(function () {
currentQuery = searchInput.value || "";
renderList();
}, 200));
}

// Ctrl/Cmd+K is handled by www/search-palette.js (a full chats + messages
// search overlay); the sidebar field above still filters the list by title.

function restoreOrCreateActiveConversation() {
var activeId = store.getActiveConversationId();
var conversation = activeId ? store.getConversation(activeId) : null;
if (!conversation) {
var result = store.createConversation();
conversation = result.conversation;
}
renderList();
notifyActiveConversationChanged(conversation);
}

// Note: restoration is deliberately NOT performed here. init() only wires
// up DOM listeners and returns the control object; the caller (app.js)
// must register onActiveConversationChanged (and, if it wants delete/clear
// to cancel an in-flight stream, registerAbortActiveGeneration) and then
// call start() - otherwise the very first restore notification would fire
// before anything is listening for it.
return {
store: store,
onActiveConversationChanged: function (handler) { activeConversationChangedHandler = handler; },
registerAbortActiveGeneration: function (fn) { abortActiveGenerationFn = fn; },
refreshList: renderList,
// Re-reads the active chat from storage and re-renders it (after sync changed it).
refreshActive: restoreOrCreateActiveConversation,
selectConversation: selectConversation,
startRename: function (id) { var c = store.getConversation(id); if (c) startRename(c); },
togglePin: function (id) { var c = store.getConversation(id); if (c) togglePin(c); },
deleteConversation: handleDelete,
setUser: function (user) {
abortActiveGeneration();
store.setUserId(user && user.uid ? user.uid : null);
currentQuery = "";
if (searchInput) searchInput.value = "";
restoreOrCreateActiveConversation();
},
setHistoryStatus: setHistoryStatus,
clearActiveConversation: handleClearActiveConversation,
clearAllConversations: handleClearAllConversations,
exportActiveConversation: handleExport,
triggerImport: function () { if (importInput) importInput.click(); },
// Same validated pipeline the (currently UI-less) file input uses; lets e2e
// and any future entry point import a File without a DOM input.
importFile: handleImportFile,
closeMobileDrawer: closeMobileDrawer,
start: function () {
// One-time, idempotent legacy-data migration (safe no-op if there is
// nothing to migrate or it already ran - see chatStore.js).
try {
store.migrateLegacyData();
} catch (err) {
console.error("[LinguaHub AI] Legacy chat history migration failed:", err.message);
}
restoreOrCreateActiveConversation();
}
};
}

return { init: init, formatRelativeTime: formatRelativeTime, safeFilenameFromTitle: safeFilenameFromTitle };
})();

if (typeof module !== "undefined" && module.exports) {
module.exports = LinguaHubHistoryUI;
}

if (typeof window !== "undefined") {
window.LinguaHubHistoryUI = LinguaHubHistoryUI;
}
