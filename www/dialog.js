// LinguaHub AI - accessible custom dialog system.
//
// Replaces window.prompt/window.confirm (used previously for rename/
// delete/clear) with a themed, keyboard-accessible modal: focus trap,
// focus restoration to whatever triggered it, Escape to cancel, backdrop
// click to cancel, aria-modal semantics. Only one dialog can be open at a
// time (a second call while one is open resolves the first as cancelled
// first) so instances never stack or leak.
//
// API:
//   LinguaHubDialog.confirm({ title, message, confirmLabel, cancelLabel, destructive })
//     -> Promise<boolean>
//   LinguaHubDialog.prompt({ title, message, defaultValue, confirmLabel, cancelLabel })
//     -> Promise<string|null>   (null means cancelled)

var LinguaHubDialog = (function () {
"use strict";

var FOCUSABLE_SELECTOR = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

var activeState = null; // { backdrop, dialog, resolve, previouslyFocused }

function closeActive(result) {
if (!activeState) return;
var state = activeState;
activeState = null;

state.backdrop.remove();
document.removeEventListener("keydown", state.onKeydown, true);

if (state.previouslyFocused && typeof state.previouslyFocused.focus === "function") {
state.previouslyFocused.focus();
}
state.resolve(result);
}

function trapFocus(dialog, event) {
var focusable = Array.prototype.slice.call(dialog.querySelectorAll(FOCUSABLE_SELECTOR));
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

function buildDialog(options, extraContentBuilder) {
if (activeState) closeActive(null); // never stack

return new Promise(function (resolve) {
var previouslyFocused = document.activeElement;

var backdrop = document.createElement("div");
backdrop.className = "lh-dialog-backdrop";

var dialog = document.createElement("div");
dialog.className = "lh-dialog" + (options.destructive ? " lh-dialog-destructive" : "");
dialog.setAttribute("role", "alertdialog");
dialog.setAttribute("aria-modal", "true");

var titleId = "lh-dialog-title-" + Date.now();
var descId = "lh-dialog-desc-" + Date.now();

var titleEl = document.createElement("h2");
titleEl.className = "lh-dialog-title";
titleEl.id = titleId;
titleEl.textContent = options.title || "";
dialog.setAttribute("aria-labelledby", titleId);

var messageEl = document.createElement("p");
messageEl.className = "lh-dialog-message";
messageEl.id = descId;
messageEl.textContent = options.message || "";
dialog.setAttribute("aria-describedby", descId);

dialog.appendChild(titleEl);
if (options.message) dialog.appendChild(messageEl);

var extra = extraContentBuilder ? extraContentBuilder(dialog) : null;

var actions = document.createElement("div");
actions.className = "lh-dialog-actions";

var cancelBtn = document.createElement("button");
cancelBtn.type = "button";
cancelBtn.className = "lh-btn lh-btn-secondary";
cancelBtn.textContent = options.cancelLabel || "Cancel";

var confirmBtn = document.createElement("button");
confirmBtn.type = "button";
confirmBtn.className = "lh-btn " + (options.destructive ? "lh-btn-danger" : "lh-btn-primary");
confirmBtn.textContent = options.confirmLabel || "OK";

actions.appendChild(cancelBtn);
actions.appendChild(confirmBtn);
dialog.appendChild(actions);
backdrop.appendChild(dialog);
document.body.appendChild(backdrop);

function onKeydown(event) {
if (event.key === "Escape") {
event.preventDefault();
closeActive(extra ? null : false);
} else if (event.key === "Tab") {
trapFocus(dialog, event);
} else if (event.key === "Enter" && extra && document.activeElement === extra.input) {
event.preventDefault();
confirmBtn.click();
}
}

backdrop.addEventListener("mousedown", function (event) {
if (event.target === backdrop) closeActive(extra ? null : false);
});

cancelBtn.addEventListener("click", function () {
closeActive(extra ? null : false);
});

confirmBtn.addEventListener("click", function () {
if (extra) {
var value = extra.input.value.trim();
if (!value) {
extra.showError("This field cannot be empty.");
extra.input.focus();
return;
}
closeActive(value);
} else {
closeActive(true);
}
});

document.addEventListener("keydown", onKeydown, true);

activeState = {
backdrop: backdrop,
dialog: dialog,
resolve: resolve,
previouslyFocused: previouslyFocused,
onKeydown: onKeydown
};

// Focus the most useful control once the dialog is in the DOM.
var toFocus = (extra && extra.input) || confirmBtn;
setTimeout(function () { toFocus.focus(); toFocus.select && toFocus.select(); }, 0);
});
}

function confirm(options) {
var opts = options || {};
return buildDialog(opts, null);
}

function prompt(options) {
var opts = options || {};
return buildDialog(opts, function (dialog) {
var field = document.createElement("div");
field.className = "lh-dialog-field";

var input = document.createElement("input");
input.type = "text";
input.className = "lh-dialog-input";
input.value = opts.defaultValue || "";
input.maxLength = opts.maxLength || 200;

var errorEl = document.createElement("div");
errorEl.className = "lh-dialog-field-error";
errorEl.setAttribute("role", "alert");

field.appendChild(input);
field.appendChild(errorEl);
dialog.insertBefore(field, dialog.querySelector(".lh-dialog-actions"));

return {
input: input,
showError: function (text) { errorEl.textContent = text; }
};
});
}

return { confirm: confirm, prompt: prompt };
})();

if (typeof module !== "undefined" && module.exports) {
module.exports = LinguaHubDialog;
}

if (typeof window !== "undefined") {
window.LinguaHubDialog = LinguaHubDialog;
}
