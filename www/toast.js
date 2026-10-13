// LinguaHub AI - toast/status notification system.
//
// A single aria-live region hosts up to MAX_VISIBLE toasts at once; beyond
// that the oldest dismissible toast is removed to make room (no unbounded
// stacking/overflow). Respects prefers-reduced-motion via CSS only (no
// timing logic here depends on animation, so disabling motion in CSS never
// breaks the dismiss timer).
//
// API: LinguaHubToast.show({ type: "success"|"error"|"warning"|"info", message, duration,
//                            action: { label, onClick } })
//      action adds one button (e.g. "Undo"); clicking it runs onClick once and
//      dismisses the toast.
//      returns a dismiss() function. duration omitted/0 = must be dismissed
//      manually (used sparingly - e.g. never for routine success toasts).

var LinguaHubToast = (function () {
"use strict";

var MAX_VISIBLE = 3;
var DEFAULT_DURATION = 4000;
var container = null;
var active = [];

function ensureContainer() {
if (container && document.body.contains(container)) return container;
container = document.getElementById("toast-region");
if (!container) {
container = document.createElement("div");
container.id = "toast-region";
document.body.appendChild(container);
}
container.className = "lh-toast-region";
container.setAttribute("aria-live", "polite");
container.setAttribute("role", "status");
return container;
}

function dismiss(entry) {
var index = active.indexOf(entry);
if (index === -1) return;
active.splice(index, 1);
if (entry.timer) clearTimeout(entry.timer);
if (entry.el && entry.el.parentNode) entry.el.parentNode.removeChild(entry.el);
}

function show(options) {
var opts = options || {};
var type = ["success", "error", "warning", "info"].indexOf(opts.type) !== -1 ? opts.type : "info";
var region = ensureContainer();

while (active.length >= MAX_VISIBLE) {
dismiss(active[0]);
}

var el = document.createElement("div");
el.className = "lh-toast lh-toast-" + type;
el.setAttribute("role", type === "error" ? "alert" : "status");

var messageEl = document.createElement("span");
messageEl.className = "lh-toast-message";
messageEl.textContent = opts.message || "";
el.appendChild(messageEl);

var entry = { el: el, timer: null };

if (opts.action && typeof opts.action.onClick === "function" && opts.action.label) {
var actionBtn = document.createElement("button");
actionBtn.type = "button";
actionBtn.className = "lh-toast-action";
actionBtn.textContent = String(opts.action.label);
actionBtn.addEventListener("click", function () {
dismiss(entry);
opts.action.onClick();
});
el.appendChild(actionBtn);
}

var closeBtn = document.createElement("button");
closeBtn.type = "button";
closeBtn.className = "lh-toast-close";
closeBtn.setAttribute("aria-label", "Dismiss notification");
closeBtn.textContent = "✕";
el.appendChild(closeBtn);

region.appendChild(el);

closeBtn.addEventListener("click", function () { dismiss(entry); });

var duration = typeof opts.duration === "number" ? opts.duration : DEFAULT_DURATION;
if (duration > 0) {
entry.timer = setTimeout(function () { dismiss(entry); }, duration);
}

active.push(entry);
return function () { dismiss(entry); };
}

return { show: show };
})();

if (typeof module !== "undefined" && module.exports) {
module.exports = LinguaHubToast;
}

if (typeof window !== "undefined") {
window.LinguaHubToast = LinguaHubToast;
}
