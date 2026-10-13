// LinguaHub AI - settings panel.
//
// Two-column dialog: a tab list on the left (Appearance, Chat, Voice, Data,
// Account) and the selected tab's settings on the right. Only real,
// already-supported capabilities are surfaced: theme (www/theme.js), WOW
// effects, Enter-to-send, clear the current chat, voice (owned by
// www/voice.js), export / import / clear all chats, and the account
// (delegates to the existing #login-btn / #logout-btn). No fake model
// picker, no fake subscription.

var LinguaHubSettingsUI = (function () {
"use strict";

var SETTINGS_KEY = "linguahub-ai:settings";
var DEFAULT_SETTINGS = { enterToSend: true, wowEffects: false };
var FOCUSABLE_SELECTOR = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function loadSettings() {
try {
var raw = window.localStorage.getItem(SETTINGS_KEY);
if (!raw) return Object.assign({}, DEFAULT_SETTINGS);
var parsed = JSON.parse(raw);
if (typeof parsed !== "object" || parsed === null) return Object.assign({}, DEFAULT_SETTINGS);
// Unknown fields are simply not copied - ignored, never crash.
return {
enterToSend: typeof parsed.enterToSend === "boolean" ? parsed.enterToSend : DEFAULT_SETTINGS.enterToSend,
wowEffects: typeof parsed.wowEffects === "boolean" ? parsed.wowEffects : DEFAULT_SETTINGS.wowEffects
};
} catch (err) {
return Object.assign({}, DEFAULT_SETTINGS);
}
}

function saveSettings(settings) {
// Keep the legacy payload byte-for-byte stable while WOW is off; the new
// preference is stored only when it differs from its false default.
var persisted = { enterToSend: settings.enterToSend !== false };
if (settings.wowEffects === true) persisted.wowEffects = true;
try { window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(persisted)); } catch (err) { /* non-fatal */ }
}

var settings = loadSettings();
var activeState = null;

function isEnterToSendEnabled() {
return settings.enterToSend !== false;
}

function close() {
if (!activeState) return;
var state = activeState;
activeState = null;
(state.cleanups || []).forEach(function (cleanup) { try { cleanup(); } catch (err) { /* ignore */ } });
state.backdrop.remove();
document.removeEventListener("keydown", state.onKeydown, true);
if (state.previouslyFocused && typeof state.previouslyFocused.focus === "function") {
state.previouslyFocused.focus();
}
}

function trapFocus(panel, event) {
// Controls inside the hidden tab panels still match the selector but can
// never take focus; offsetParent is null for exactly those.
var focusable = Array.prototype.slice.call(panel.querySelectorAll(FOCUSABLE_SELECTOR)).filter(function (el) {
return typeof el.offsetParent === "undefined" || el.offsetParent !== null;
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

function section(title) {
var el = document.createElement("div");
el.className = "settings-section";
var heading = document.createElement("div");
heading.className = "settings-section-title";
heading.textContent = title;
el.appendChild(heading);
return el;
}

function row(labelText) {
var el = document.createElement("div");
el.className = "settings-row";
var label = document.createElement("span");
label.className = "settings-row-label";
label.textContent = labelText;
el.appendChild(label);
return el;
}

function buildAppearanceSection() {
var el = section("Appearance");
var themeRow = row("Theme");
var group = document.createElement("div");
group.className = "theme-option-group";
group.setAttribute("role", "group");
group.setAttribute("aria-label", "Theme");

var options = [["system", "System"], ["light", "Light"], ["dark", "Dark"]];
var currentMode = window.LinguaHubTheme ? window.LinguaHubTheme.getMode() : "system";

options.forEach(function (opt) {
var btn = document.createElement("button");
btn.type = "button";
btn.className = "theme-option";
btn.textContent = opt[1];
btn.setAttribute("aria-pressed", opt[0] === currentMode ? "true" : "false");
btn.addEventListener("click", function () {
if (!window.LinguaHubTheme) return;
window.LinguaHubTheme.setMode(opt[0]);
Array.prototype.forEach.call(group.children, function (child) {
child.setAttribute("aria-pressed", "false");
});
btn.setAttribute("aria-pressed", "true");
});
group.appendChild(btn);
});

themeRow.appendChild(group);
el.appendChild(themeRow);

var wowRow = row("WOW Effects");
var wowSwitch = buildSwitch("settings-wow-effects", settings.wowEffects === true);
wowSwitch.input.setAttribute("aria-label", "Enable WOW Effects");
wowSwitch.input.addEventListener("change", function () {
settings.wowEffects = wowSwitch.input.checked;
saveSettings(settings);
if (window.LinguaHubWowEffects) window.LinguaHubWowEffects.apply(settings.wowEffects);
});
wowRow.appendChild(wowSwitch.wrapper);
el.appendChild(wowRow);
return el;
}

function buildSwitch(id, checked) {
var wrapper = document.createElement("label");
wrapper.className = "lh-switch";
wrapper.htmlFor = id;

var input = document.createElement("input");
input.type = "checkbox";
input.id = id;
input.checked = checked;

var track = document.createElement("span");
track.className = "lh-switch-track";
track.setAttribute("aria-hidden", "true");

wrapper.appendChild(input);
wrapper.appendChild(track);
return { wrapper: wrapper, input: input };
}

function buildChatSection(controller) {
var el = section("Chat");

var enterRow = row("Enter to send");
var enterSwitch = buildSwitch("settings-enter-to-send", isEnterToSendEnabled());
enterSwitch.input.setAttribute("aria-label", "Enter to send");
enterSwitch.input.addEventListener("change", function () {
settings.enterToSend = enterSwitch.input.checked;
saveSettings(settings);
});
enterRow.appendChild(enterSwitch.wrapper);
el.appendChild(enterRow);

var clearRow = row("Clear current conversation");
var clearBtn = document.createElement("button");
clearBtn.type = "button";
clearBtn.className = "lh-btn lh-btn-secondary";
clearBtn.textContent = "Clear";
clearBtn.addEventListener("click", function () {
if (controller && controller.clearActiveConversation) controller.clearActiveConversation();
});
clearRow.appendChild(clearBtn);
el.appendChild(clearRow);

return el;
}

function inlineButton(label, onClick, ariaLabel) {
var btn = document.createElement("button");
btn.type = "button";
btn.className = "lh-btn lh-btn-secondary";
btn.textContent = label;
if (ariaLabel) btn.setAttribute("aria-label", ariaLabel);
btn.addEventListener("click", onClick);
return btn;
}

function buildDataSection(controller) {
var el = section("Data");
var c = controller || {};

// Export / import are hidden when a host shell owns them (embedded mode).
var transferAllowed = !(window.LinguaHubAppMode && window.LinguaHubAppMode.showImportExport === false);
if (transferAllowed) {
var exportRow = row("Export chats");
var exportControls = document.createElement("div");
exportControls.className = "settings-inline-controls";
exportControls.appendChild(inlineButton("This chat", function () {
if (c.exportActiveConversation) c.exportActiveConversation();
}, "Export this chat"));
exportControls.appendChild(inlineButton("All chats", function () {
if (c.exportAllConversations) c.exportAllConversations();
}, "Export all chats"));
exportRow.appendChild(exportControls);
el.appendChild(exportRow);

var importRow = row("Import chats");
var fileInput = document.createElement("input");
fileInput.type = "file";
fileInput.accept = ".json,application/json";
fileInput.id = "settings-import-file";
fileInput.hidden = true;
fileInput.setAttribute("aria-hidden", "true");
fileInput.setAttribute("tabindex", "-1");
fileInput.addEventListener("change", function () {
var file = fileInput.files && fileInput.files[0];
if (file && c.importFile) c.importFile(file);
fileInput.value = ""; // allow picking the same file again later
});
importRow.appendChild(fileInput);
importRow.appendChild(inlineButton("Choose file\u2026", function () { fileInput.click(); }, "Import chats from a file"));
el.appendChild(importRow);
}

var clearAllRow = row("Delete all chats");
var clearAllBtn = document.createElement("button");
clearAllBtn.type = "button";
clearAllBtn.className = "lh-btn lh-btn-danger";
clearAllBtn.textContent = "Clear all";
clearAllBtn.addEventListener("click", async function () {
if (c.clearAllConversations) {
var cleared = await c.clearAllConversations();
if (cleared) close();
}
});
clearAllRow.appendChild(clearAllBtn);
el.appendChild(clearAllRow);

return el;
}

function buildAccountSection(controller, cleanups) {
var el = section("Account");
var user = window.LinguaHubAuth && window.LinguaHubAuth.getCurrentUser ? window.LinguaHubAuth.getCurrentUser() : null;

var infoRow = row(user ? (user.displayName || user.email || "Signed in") : "Signed out");
if (user && user.email && user.displayName) {
var emailSpan = document.createElement("span");
emailSpan.className = "settings-row-label settings-row-label-muted";
emailSpan.textContent = user.email;
infoRow.appendChild(emailSpan);
}
el.appendChild(infoRow);

if (!user) {
var note = document.createElement("p");
note.className = "settings-note";
note.textContent = "You're using LinguaHub as a guest: your chats are saved on this device only. Sign in to keep them in your account and see them on your other devices.";
el.appendChild(note);

var signInRow = row("");
signInRow.appendChild(inlineButton("Sign in", function () {
var realLoginBtn = document.getElementById("login-btn");
close();
if (realLoginBtn) realLoginBtn.click();
}));
el.appendChild(signInRow);
return el;
}

// Sync status, kept live while the dialog is open.
var sync = window.linguahubSync;
if (sync && window.LinguaHubChatSync) {
var syncRow = row("Chat sync");
var statusText = document.createElement("span");
statusText.className = "settings-row-label settings-row-label-muted";
statusText.id = "settings-sync-status";
statusText.setAttribute("role", "status");
statusText.textContent = window.LinguaHubChatSync.statusText(sync.getStatus());
syncRow.appendChild(statusText);
el.appendChild(syncRow);
var unsubscribe = sync.onStatusChange(function (status) {
statusText.textContent = window.LinguaHubChatSync.statusText(status);
});
cleanups.push(unsubscribe);
}

// Chats saved on this device before signing in (guest history).
var guestChats = controller && controller.store && controller.store.listGuestConversations ? controller.store.listGuestConversations() : [];
if (guestChats.length) {
var uploadRow = row("Chats from this device (" + guestChats.length + ")");
uploadRow.appendChild(inlineButton("Upload to account", function () {
var result = controller.store.mergeConversations(guestChats);
if (result.ok && controller.refreshList) controller.refreshList();
if (window.LinguaHubToast) {
window.LinguaHubToast.show({
type: result.ok ? "success" : "error",
message: result.ok ? "Uploaded " + result.added + (result.added === 1 ? " chat" : " chats") + " to your account." : "Could not upload your chats."
});
}
if (result.ok) uploadRow.hidden = true;
}));
el.appendChild(uploadRow);
}

var logoutRow = row("");
var logoutBtn = document.createElement("button");
logoutBtn.type = "button";
logoutBtn.className = "lh-btn lh-btn-secondary";
logoutBtn.textContent = "Sign out";
// Delegates to the app's existing, already-tested logout flow (loading
// state, abort-active-generation, Firebase signOut) instead of
// duplicating that logic here.
logoutBtn.addEventListener("click", function () {
var realLogoutBtn = document.getElementById("logout-btn");
if (realLogoutBtn) realLogoutBtn.click();
close();
});
logoutRow.appendChild(logoutBtn);
el.appendChild(logoutRow);

return el;
}

// open(controller, { tab }) - controller is the history UI (clear / export /
// import / the chat store). A first argument that only has a "tab" is treated
// as the options, for callers that just want a specific tab.
function open(controller, options) {
if (activeState) close();
if (controller && typeof controller.tab === "string" && !controller.clearActiveConversation && !controller.store) {
options = controller;
controller = window.linguahubHistory;
}
var opts = options || {};

var previouslyFocused = document.activeElement;
var cleanups = [];

var backdrop = document.createElement("div");
backdrop.className = "lh-dialog-backdrop";

var panel = document.createElement("div");
panel.className = "lh-dialog lh-settings-dialog";
panel.setAttribute("role", "dialog");
panel.setAttribute("aria-modal", "true");

var titleId = "lh-settings-title";
var title = document.createElement("h2");
title.className = "lh-dialog-title";
title.id = titleId;
title.textContent = "Settings";
panel.setAttribute("aria-labelledby", titleId);
panel.appendChild(title);

var tabs = [
{ id: "appearance", label: "Appearance", content: buildAppearanceSection() },
{ id: "chat", label: "Chat", content: buildChatSection(controller) }
];
// Voice (Phase 14) - owned and persisted by www/voice.js under its own
// storage key; this dialog only provides the shared row/switch builders.
if (window.LinguaHubVoice && window.LinguaHubVoice.buildSettingsSection) {
tabs.push({ id: "voice", label: "Voice", content: window.LinguaHubVoice.buildSettingsSection({ section: section, row: row, buildSwitch: buildSwitch }) });
}
tabs.push({ id: "data", label: "Data", content: buildDataSection(controller) });
// Embedded mode assumes LinguaHub's own shell already shows the signed-in
// account - an Account tab would duplicate it. Standalone always has it.
if (!window.LinguaHubAppMode || window.LinguaHubAppMode.showAccountUI !== false) {
tabs.push({ id: "account", label: "Account", content: buildAccountSection(controller, cleanups) });
}

var layout = document.createElement("div");
layout.className = "settings-layout";

var tablist = document.createElement("div");
tablist.className = "settings-tabs";
tablist.setAttribute("role", "tablist");
tablist.setAttribute("aria-label", "Settings sections");
tablist.setAttribute("aria-orientation", "vertical");

var panels = document.createElement("div");
panels.className = "settings-panels";

var activeIndex = 0;
tabs.forEach(function (tab, index) {
if (tab.id === opts.tab) activeIndex = index;
tab.button = document.createElement("button");
tab.button.type = "button";
tab.button.className = "settings-tab";
tab.button.id = "settings-tab-" + tab.id;
tab.button.setAttribute("role", "tab");
tab.button.setAttribute("aria-controls", "settings-panel-" + tab.id);
tab.button.textContent = tab.label;
tab.button.addEventListener("click", function () { selectTab(index, false); });

tab.panel = document.createElement("div");
tab.panel.className = "settings-panel";
tab.panel.id = "settings-panel-" + tab.id;
tab.panel.setAttribute("role", "tabpanel");
tab.panel.setAttribute("aria-labelledby", tab.button.id);
tab.panel.appendChild(tab.content);

tablist.appendChild(tab.button);
panels.appendChild(tab.panel);
});

function selectTab(index, moveFocus) {
activeIndex = (index + tabs.length) % tabs.length;
tabs.forEach(function (tab, i) {
var selected = i === activeIndex;
tab.button.setAttribute("aria-selected", String(selected));
tab.button.setAttribute("tabindex", selected ? "0" : "-1");
tab.panel.hidden = !selected;
});
if (moveFocus) tabs[activeIndex].button.focus();
}

// Vertical tab list: Up/Down (and Left/Right) move between tabs and select
// them, Home/End jump to the first/last (WAI-ARIA tabs pattern).
tablist.addEventListener("keydown", function (event) {
if (event.key === "ArrowDown" || event.key === "ArrowRight") { event.preventDefault(); selectTab(activeIndex + 1, true); }
else if (event.key === "ArrowUp" || event.key === "ArrowLeft") { event.preventDefault(); selectTab(activeIndex - 1, true); }
else if (event.key === "Home") { event.preventDefault(); selectTab(0, true); }
else if (event.key === "End") { event.preventDefault(); selectTab(tabs.length - 1, true); }
});

layout.appendChild(tablist);
layout.appendChild(panels);
panel.appendChild(layout);
selectTab(activeIndex, false);

var actions = document.createElement("div");
actions.className = "lh-dialog-actions";
var closeBtn = document.createElement("button");
closeBtn.type = "button";
closeBtn.className = "lh-btn lh-btn-primary";
closeBtn.textContent = "Done";
closeBtn.addEventListener("click", close);
actions.appendChild(closeBtn);
panel.appendChild(actions);

backdrop.appendChild(panel);
document.body.appendChild(backdrop);

function onKeydown(event) {
if (event.key === "Escape") {
event.preventDefault();
close();
} else if (event.key === "Tab") {
trapFocus(panel, event);
}
}

backdrop.addEventListener("mousedown", function (event) {
if (event.target === backdrop) close();
});

document.addEventListener("keydown", onKeydown, true);

activeState = { backdrop: backdrop, previouslyFocused: previouslyFocused, onKeydown: onKeydown, cleanups: cleanups };
setTimeout(function () { tabs[activeIndex].button.focus(); }, 0);
}

return {
open: open,
close: close,
isEnterToSendEnabled: isEnterToSendEnabled
};
})();

if (typeof module !== "undefined" && module.exports) {
module.exports = LinguaHubSettingsUI;
}

if (typeof window !== "undefined") {
window.LinguaHubSettingsUI = LinguaHubSettingsUI;
}
