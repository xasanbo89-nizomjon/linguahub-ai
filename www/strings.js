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
composerDisclaimer: "LinguaHub AI can make mistakes. Verify important information.",

// Voice chat copy (Phase 14, www/voice.js). Errors are phrased as what
// the user can do next, never as raw Web Speech API error codes.
voice: {
listening: "Listening...",
states: {
idle: "Tap the orb to speak",
listening: "Listening...",
thinking: "Thinking...",
speaking: "Speaking..."
},
permissionDenied: "Microphone access is blocked. Allow the microphone for this site in your browser settings, then try again.",
noSpeech: "No speech detected. Tap the microphone and try speaking again.",
noSpeechVoiceMode: "I didn't catch that. Tap the orb and try again.",
noMicrophone: "No microphone was found. Connect a microphone and try again.",
network: "The speech service couldn't be reached. Check your connection, or type your message instead.",
languageUnsupported: "This speech language isn't supported by your browser. Choose another one in Settings → Voice.",
unsupported: "Voice input isn't supported in this browser. Try Chrome, Edge or Safari, or type your message instead.",
ttsUnsupported: "Read aloud isn't supported in this browser.",
generic: "Voice input stopped unexpectedly. Please try again.",
busy: "Please wait for the current reply to finish.",
replyFailed: "The reply couldn't be generated. Tap the orb to try again.",
samples: {
en: "Hello! I'm LinguaHub AI. Let's practice together.",
uz: "Salom! Men LinguaHub AI man. Keling, birga mashq qilamiz.",
ar: "مرحبا! أنا LinguaHub AI. لنتدرب معا.",
ru: "Привет! Я LinguaHub AI. Давайте потренируемся вместе.",
tr: "Merhaba! Ben LinguaHub AI. Birlikte pratik yapalım."
}
}
};

// Node (tests) export.
if (typeof module !== "undefined" && module.exports) {
module.exports = LinguaHubStrings;
}

if (typeof window !== "undefined") {
window.LinguaHubStrings = LinguaHubStrings;
}
