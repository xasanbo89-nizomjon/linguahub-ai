"use strict";

// LinguaHub AI - centralized user-facing copy (Integration Prep phase,
// Task 14).
//
// Today this holds exactly one string. It exists as its own module - not
// because one string needs an abstraction, but so a second appearance of
// the same copy (or a future one) never gets hardcoded a second time
// somewhere else, and so a future localization pass has exactly one place
// to change per string instead of hunting through index.html/app.js.
//
// This project has no i18n/localization framework today (no translation
// loader, no locale-file convention) - this file intentionally does not
// invent one. When one exists, the natural extension is keying each value
// by locale (e.g. LinguaHubStrings.composerDisclaimer becoming a function
// of the active UI language, the same language lib/aiModes.js's system
// prompts already support - English/Arabic/Russian/Uzbek) rather than
// changing every call site again.
var LinguaHubStrings = {
// Replaces the old plain keyboard-shortcut hint ("Enter to send ·
// Shift+Enter for a new line") - the shortcut itself is unchanged (see
// www/app.js's keydown handler), only the visible composer footer text
// changed. Deliberately NOT aria-hidden (index.html) - unlike the old
// shortcut hint, an AI-accuracy disclaimer is exactly the kind of content
// that should reach assistive-technology users too.
composerDisclaimer: "LinguaHub AI can make mistakes. Verify important information."
};

// Node (tests) export.
if (typeof module !== "undefined" && module.exports) {
module.exports = LinguaHubStrings;
}

if (typeof window !== "undefined") {
window.LinguaHubStrings = LinguaHubStrings;
}
