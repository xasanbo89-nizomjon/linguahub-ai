"use strict";

// LinguaHub AI - runtime app-mode resolution (Integration Prep phase).
//
// Introduces exactly one new concept: this app runs in either
//   - "standalone" (today's real, only-used deployment: the full app, its
//     own sidebar/history/profile/import-export/mode-selector, usable on
//     its own)
//   - "embedded" (future: reused as a panel/component inside LinguaHub -
//     see docs/integration-prep/embedded-mode.md) - simplifies specific,
//     named UI surfaces (Import/Export, account UI, mode selector - see
//     each surface's own "why" comment at its call site) so the assistant
//     doesn't duplicate controls LinguaHub's own shell already owns.
//
// Nothing in this repository sets APP_MODE to "embedded" today - this file
// is dormant/inert until a future host page does. Standalone is always the
// default with zero configuration, exactly like today.
//
// Resolution mirrors www/config.js's own documented override pattern
// exactly (same window.LINGUAHUB_CONFIG object, same "inline <script>
// BEFORE this file loads" mechanism) rather than inventing a second config
// system:
//   window.LINGUAHUB_CONFIG = {
//     APP_MODE: "embedded",              // "standalone" (default) | "embedded"
//     SHOW_IMPORT_EXPORT: false,          // optional per-feature override
//     SHOW_MODE_SELECTOR: false,          // optional per-feature override
//     SHOW_ACCOUNT_UI: false              // optional per-feature override
//   };
//
// Each per-feature flag defaults to `true` in standalone and `false` in
// embedded when not explicitly set - embedded mode's simplifications are a
// sensible default, not a hardcoded requirement, so a future integration
// can turn any one of them back on without forking this file.
//
// This file only READS window.LINGUAHUB_CONFIG's raw override (if any) - it
// does not depend on config.js having already run (config.js's own
// resolve() preserves unknown keys via Object.assign, so load order between
// the two never matters for APP_MODE). Loaded in <head>, immediately after
// theme.js, so the data-app-mode attribute (used by styles.css to hide
// embedded-inappropriate controls) is set before first paint - the exact
// same "no flash of the wrong UI" reasoning theme.js's own header comment
// already documents for [data-theme].

var LinguaHubAppMode = (function () {

function resolveFlag(cfg, isEmbedded, name) {
if (typeof cfg[name] === "boolean") return cfg[name];
return !isEmbedded;
}

// Pure - takes a plain config object, returns a plain result object. No
// window/document access, so this is directly unit-testable the same way
// www/config.js's own resolve()/computeApiBase() are (see tests/config.test.js).
function resolve(overrideConfig) {
var cfg = overrideConfig || {};
var mode = cfg.APP_MODE === "embedded" ? "embedded" : "standalone";
var isEmbedded = mode === "embedded";

return {
mode: mode,
isEmbedded: isEmbedded,
isStandalone: !isEmbedded,
// Task 2: Import/Export never render in embedded mode by default -
// the underlying store methods (chatStore.js, history-ui.js's
// exportActiveConversation/triggerImport) are untouched and still
// fully callable; only visibility changes.
showImportExport: resolveFlag(cfg, isEmbedded, "SHOW_IMPORT_EXPORT"),
// Task 10: student-facing embedded mode hides the mode selector by
// default (general/automatic mode) - backend mode registry
// (lib/aiModes.js) is completely unchanged; this only controls
// whether the <select> is shown.
showModeSelector: resolveFlag(cfg, isEmbedded, "SHOW_MODE_SELECTOR"),
// Task 5: embedded mode assumes LinguaHub's own shell already shows
// the signed-in account - no duplicate Google sign-in button/profile
// card. Standalone keeps showing it exactly as today.
showAccountUI: resolveFlag(cfg, isEmbedded, "SHOW_ACCOUNT_UI")
};
}

return { resolve: resolve };
})();

// Node (tests) export - exposes the pure resolver only; the browser-wiring
// block below (window.LinguaHubAppMode = the already-resolved object, plus
// the [data-app-mode] attribute) intentionally does not run under Node.
if (typeof module !== "undefined" && module.exports) {
module.exports = LinguaHubAppMode;
}

// Browser wiring: resolve once against whatever window.LINGUAHUB_CONFIG
// already holds (set by an inline override script before this file loads,
// exactly like config.js's own documented mechanism), then stamp
// [data-app-mode] (and, for a per-feature override back on, a matching
// [data-show-*] attribute - see styles.css's own "Embedded mode" section)
// on <html> before first paint.
if (typeof window !== "undefined") {
var existingConfig = window.LINGUAHUB_CONFIG || {};
var resolvedAppMode = LinguaHubAppMode.resolve(existingConfig);
window.LinguaHubAppMode = resolvedAppMode;
if (typeof document !== "undefined" && document.documentElement) {
var root = document.documentElement;
root.setAttribute("data-app-mode", resolvedAppMode.mode);
root.setAttribute("data-show-import-export", String(resolvedAppMode.showImportExport));
root.setAttribute("data-show-mode-selector", String(resolvedAppMode.showModeSelector));
root.setAttribute("data-show-account-ui", String(resolvedAppMode.showAccountUI));
}
}
