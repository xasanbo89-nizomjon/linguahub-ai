// LinguaHub AI - theme detection and persistence.
//
// Loaded as the very first <script> in <head>, before any CSS or body
// content, and deliberately NOT deferred/async/module - a plain blocking
// <script src> runs before first paint, which is what lets this set
// data-theme on <html> with no flash of the wrong theme, without needing
// an inline <script> (which would require a CSP script-src exception this
// app otherwise doesn't need - see docs/phase-04-premium-ui.md, "CSP").
//
// Modes: "system" (default - follows the OS/browser preference and keeps
// following it live), "light", "dark" (explicit user override, persisted).

var LinguaHubTheme = (function () {
"use strict";

var STORAGE_KEY = "linguahub-ai:theme";
var VALID_MODES = ["system", "light", "dark"];

function safeGetStored() {
try {
var value = window.localStorage.getItem(STORAGE_KEY);
return VALID_MODES.indexOf(value) !== -1 ? value : null;
} catch (err) {
// Private-browsing/storage-disabled: fall back to system, never throw.
return null;
}
}

function safeSetStored(mode) {
try {
window.localStorage.setItem(STORAGE_KEY, mode);
return true;
} catch (err) {
return false;
}
}

function prefersDark() {
return typeof window.matchMedia === "function" &&
window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolve(mode) {
if (mode === "light" || mode === "dark") return mode;
return prefersDark() ? "dark" : "light";
}

function apply(mode) {
var resolved = resolve(mode);
document.documentElement.setAttribute("data-theme", resolved);
document.documentElement.setAttribute("data-theme-mode", mode);
return resolved;
}

var currentMode = safeGetStored() || "system";
apply(currentMode);

// Live-follow the OS theme while in "system" mode (and only then) - an
// explicit light/dark choice is never silently overridden by an OS change.
if (typeof window.matchMedia === "function") {
var media = window.matchMedia("(prefers-color-scheme: dark)");
var onSystemChange = function () {
if (currentMode === "system") apply("system");
};
if (typeof media.addEventListener === "function") {
media.addEventListener("change", onSystemChange);
} else if (typeof media.addListener === "function") {
media.addListener(onSystemChange); // older WebView engines (Capacitor/Electron)
}
}

function setMode(mode) {
if (VALID_MODES.indexOf(mode) === -1) return currentMode;
currentMode = mode;
safeSetStored(mode);
apply(mode);
return mode;
}

function getMode() {
return currentMode;
}

function getResolvedTheme() {
return document.documentElement.getAttribute("data-theme");
}

return { setMode: setMode, getMode: getMode, getResolvedTheme: getResolvedTheme, VALID_MODES: VALID_MODES };
})();

if (typeof window !== "undefined") {
window.LinguaHubTheme = LinguaHubTheme;
}
