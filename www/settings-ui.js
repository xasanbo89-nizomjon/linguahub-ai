// LinguaHub AI - settings panel.
//
// Only real, already-supported capabilities are surfaced here: theme
// (www/theme.js), Enter-to-send (a genuine local preference), clear/export
// of the active conversation and clearing all local history, and account
// info/logout (delegates to the existing #logout-btn - see "why" below).
// No fake model picker, no fake subscription, no fake cloud sync.

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
state.backdrop.remove();
document.removeEventListener("keydown", state.onKeydown, true);
if (state.previouslyFocused && typeof state.previouslyFocused.focus === "function") {
state.previouslyFocused.focus();
}
}

function trapFocus(panel, event) {
var focusable = Array.prototype.slice.call(panel.querySelectorAll(FOCUSABLE_SELECTOR));
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

function buildDataSection(controller) {
var el = section("Data");

var clearAllRow = row("Clear local history");
var clearAllBtn = document.createElement("button");
clearAllBtn.type = "button";
clearAllBtn.className = "lh-btn lh-btn-danger";
clearAllBtn.textContent = "Clear all";
clearAllBtn.addEventListener("click", async function () {
if (controller && controller.clearAllConversations) {
var cleared = await controller.clearAllConversations();
if (cleared) close();
}
});
clearAllRow.appendChild(clearAllBtn);
el.appendChild(clearAllRow);

return el;
}

function buildAccountSection() {
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

if (user) {
var logoutRow = row("");
var logoutBtn = document.createElement("button");
logoutBtn.type = "button";
logoutBtn.className = "lh-btn lh-btn-secondary";
logoutBtn.textContent = "Logout";
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
}

return el;
}

function open(controller) {
if (activeState) close();

var previouslyFocused = document.activeElement;

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

panel.appendChild(buildAppearanceSection());
panel.appendChild(buildChatSection(controller));
panel.appendChild(buildDataSection(controller));
// Task 5: embedded mode assumes LinguaHub's own shell already shows the
// signed-in account - this dialog's Account section (email/logout) would
// otherwise duplicate it. Standalone always shows it, unchanged.
if (!window.LinguaHubAppMode || window.LinguaHubAppMode.showAccountUI !== false) {
panel.appendChild(buildAccountSection());
}

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

activeState = { backdrop: backdrop, previouslyFocused: previouslyFocused, onKeydown: onKeydown };
setTimeout(function () { closeBtn.focus(); }, 0);
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
