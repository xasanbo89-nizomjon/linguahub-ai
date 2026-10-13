// LinguaHub AI - voice chat (Phase 14).
//
// Browser-native only: Web Speech API SpeechRecognition for speech-to-text
// and SpeechSynthesis for read-aloud. No audio ever reaches our backend -
// recognized speech becomes ordinary composer text and is sent through the
// exact same sendMessage() path as typed text (www/app.js), so Firebase
// Auth, Guest Mode, chat history and every API route are untouched.
//
// Three features share this one module:
//   1. Dictation  - tap the mic, speak, the transcript fills #user-input.
//   2. Read aloud - per-message action (app.js) + optional auto-read.
//   3. Voice mode - hands-free loop: listen -> send -> reply -> speak ->
//                   listen again, in a panel that replaces the composer so
//                   the conversation itself stays visible above it.
//
// Voice preferences live under their own storage key (not
// "linguahub-ai:settings") so settings-ui.js's persisted payload stays
// byte-for-byte stable (tests/settings-ui.test.js).
(function () {
"use strict";

var SETTINGS_KEY = "linguahub-ai:voice-settings";

var LANGUAGES = [
["en-US", "English"],
["uz-UZ", "O'zbekcha"],
["ar-SA", "العربية"],
["ru-RU", "Русский"],
["tr-TR", "Türkçe"]
];
var RATES = [["0.75", "0.75×"], ["1", "1× (normal)"], ["1.25", "1.25×"], ["1.5", "1.5×"]];

var ARABIC_SCRIPT = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;
var CYRILLIC_SCRIPT = /[Ѐ-ӿ]/;
var MAX_CHUNK = 220; // Chrome silently stops long utterances after ~15s

// ---------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------

function defaultLanguage(navigatorLanguage) {
var prefix = String(navigatorLanguage || "").slice(0, 2).toLowerCase();
for (var i = 0; i < LANGUAGES.length; i++) {
if (LANGUAGES[i][0].slice(0, 2) === prefix) return LANGUAGES[i][0];
}
return "en-US";
}

// The language each practice mode is about. A mode that is not listed (free
// chat, code, ...) has no language of its own.
var MODE_LANGUAGES = {
"linguahub-tutor": "en-US",
"ielts-reading": "en-US",
"ielts-listening": "en-US",
"ielts-writing": "en-US",
"ielts-speaking": "en-US",
"vocabulary-coach": "en-US",
"grammar-coach": "en-US"
};

function languageForMode(modeId) {
return Object.prototype.hasOwnProperty.call(MODE_LANGUAGES, modeId) ? MODE_LANGUAGES[modeId] : null;
}

// Until the user picks a speech language themselves (langManual), it follows
// the selected practice mode, falling back to the browser-derived default.
function effectiveLanguage(settings, modeId) {
if (settings.langManual) return settings.lang;
return languageForMode(modeId) || settings.lang;
}

function normalizeSettings(raw, navigatorLanguage) {
var value = raw && typeof raw === "object" ? raw : {};
var langOk = LANGUAGES.some(function (l) { return l[0] === value.lang; });
var rate = Number(value.rate);
var lang = langOk ? value.lang : defaultLanguage(navigatorLanguage);
var manual;
if (typeof value.langManual === "boolean") manual = langOk && value.langManual;
// settings saved before this flag existed: a language that differs from the
// browser default can only have been picked by the user
else manual = langOk && value.lang !== defaultLanguage(navigatorLanguage);
return {
enabled: typeof value.enabled === "boolean" ? value.enabled : true,
autoRead: typeof value.autoRead === "boolean" ? value.autoRead : false,
lang: lang,
langManual: manual,
rate: rate >= 0.5 && rate <= 2 ? rate : 1
};
}

// Assistant replies are Markdown - read the words, not the syntax.
function toSpeakableText(markdown) {
return String(markdown || "")
.replace(/```[\s\S]*?```/g, " (code example) ")
.replace(/`([^`]+)`/g, "$1")
.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
.replace(/https?:\/\/\S+/g, "")
.replace(/^\s{0,3}#{1,6}\s+/gm, "")
.replace(/^\s*>\s?/gm, "")
.replace(/^\s*[-*+]\s+/gm, "")
.replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, "")
.replace(/\|/g, ", ")
.replace(/(\*\*|__|\*|_|~~)(\S[\s\S]*?\S|\S)\1/g, "$2")
.replace(/[ \t]+/g, " ")
.replace(/\n{2,}/g, ".\n")
.replace(/\.\s*\.(\s)/g, ".$1")
.trim();
}

// Sentence-sized chunks, each <= MAX_CHUNK chars, split on the gentlest
// boundary available (sentence, then clause, then word).
function splitIntoChunks(text) {
var sentences = String(text || "").match(/[^.!?。؟\n]+[.!?。؟]*\s*|\n+/g) || [];
var chunks = [];
var current = "";
function push(piece) {
piece = piece.trim();
if (piece) chunks.push(piece);
}
sentences.forEach(function (sentence) {
if ((current + sentence).length <= MAX_CHUNK) {
current += sentence;
return;
}
push(current);
current = "";
while (sentence.length > MAX_CHUNK) {
var cut = sentence.lastIndexOf(",", MAX_CHUNK);
if (cut < MAX_CHUNK / 2) cut = sentence.lastIndexOf(" ", MAX_CHUNK);
if (cut <= 0) cut = MAX_CHUNK;
push(sentence.slice(0, cut + 1));
sentence = sentence.slice(cut + 1);
}
current = sentence;
});
push(current);
return chunks;
}

// The reply's own script wins over the recognition language, so an Arabic
// answer to an English question is still read with an Arabic voice.
function detectSpeechLang(text, fallbackLang) {
if (ARABIC_SCRIPT.test(text)) return "ar-SA";
if (CYRILLIC_SCRIPT.test(text) && fallbackLang !== "uz-UZ") return "ru-RU";
return fallbackLang || "en-US";
}

function friendlyErrorMessage(code, strings) {
var s = strings || {};
switch (code) {
case "not-allowed":
case "service-not-allowed":
return s.permissionDenied;
case "no-speech":
return s.noSpeech;
case "audio-capture":
return s.noMicrophone;
case "network":
return s.network;
case "language-not-supported":
return s.languageUnsupported;
case "unsupported":
return s.unsupported;
default:
return s.generic;
}
}

var helpers = {
LANGUAGES: LANGUAGES,
defaultLanguage: defaultLanguage,
languageForMode: languageForMode,
effectiveLanguage: effectiveLanguage,
MODE_LANGUAGES: MODE_LANGUAGES,
normalizeSettings: normalizeSettings,
toSpeakableText: toSpeakableText,
splitIntoChunks: splitIntoChunks,
detectSpeechLang: detectSpeechLang,
friendlyErrorMessage: friendlyErrorMessage
};

if (typeof module !== "undefined" && module.exports) {
module.exports = helpers;
}
if (typeof window === "undefined" || typeof document === "undefined") return;

// ---------------------------------------------------------------------
// Browser runtime
// ---------------------------------------------------------------------

var Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
var synth = window.speechSynthesis || null;
var root = document.documentElement;

function copy() {
return (window.LinguaHubStrings && window.LinguaHubStrings.voice) || {};
}

function loadSettings() {
try {
return normalizeSettings(JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || "{}"), navigator.language);
} catch (err) {
return normalizeSettings(null, navigator.language);
}
}

var settings = loadSettings();

// The language actually used for speaking and listening right now.
function activeLang() {
var modeSelect = document.getElementById("mode-select");
return effectiveLanguage(settings, modeSelect ? modeSelect.value : null);
}

function saveSettings() {
try { window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (err) { /* optional */ }
}

function notify(message, type) {
if (!message) return;
if (window.LinguaHubToast) window.LinguaHubToast.show({ type: type || "warning", message: message, duration: 4000 });
}

// ---- DOM references (resolved on DOMContentLoaded) -------------------

var els = {};

function $(id) { return document.getElementById(id); }

// ---- Speech synthesis --------------------------------------------------

var speakingToken = 0;
var speakingWrapper = null;
var cachedVoices = [];

function refreshVoices() {
if (synth) cachedVoices = synth.getVoices() || [];
}

function pickVoice(lang) {
if (!cachedVoices.length) refreshVoices();
var exact = null, partial = null, prefix = lang.slice(0, 2).toLowerCase();
for (var i = 0; i < cachedVoices.length; i++) {
var v = cachedVoices[i], vl = String(v.lang || "").replace("_", "-").toLowerCase();
if (vl === lang.toLowerCase()) { if (!exact || v.localService) exact = v; }
else if (vl.slice(0, 2) === prefix && !partial) partial = v;
}
return exact || partial || null;
}

function setReadAloudButton(wrapper, active) {
if (!wrapper) return;
var btn = wrapper.querySelector('.message-action-btn[data-action="speak"]');
if (!btn) return;
btn.classList.toggle("is-speaking", active);
btn.setAttribute("aria-pressed", String(active));
btn.setAttribute("aria-label", active ? "Stop listening" : "Listen");
btn.setAttribute("title", active ? "Stop listening" : "Listen");
// Icon buttons (app.js) hold both a speaker and a stop glyph and CSS swaps
// them on .is-speaking; only the text-fallback button needs its label set.
if (!btn.querySelector("svg")) btn.textContent = active ? "■ Stop" : "Listen";
}

function stopSpeaking() {
speakingToken++;
if (synth) synth.cancel();
setReadAloudButton(speakingWrapper, false);
speakingWrapper = null;
}

// Speaks markdown text in chunks; resolves when finished or interrupted.
function speak(markdown, options) {
var opts = options || {};
stopSpeaking();
var text = toSpeakableText(markdown);
if (!synth || !text) return Promise.resolve(false);

var token = speakingToken;
var lang = detectSpeechLang(text, activeLang());
var voice = pickVoice(lang);
var chunks = splitIntoChunks(text);
speakingWrapper = opts.wrapper || null;
setReadAloudButton(speakingWrapper, true);

return new Promise(function (resolve) {
var index = 0;
function finish(completed) {
if (token === speakingToken) {
setReadAloudButton(speakingWrapper, false);
speakingWrapper = null;
}
resolve(completed);
}
function next() {
if (token !== speakingToken) return finish(false);
if (index >= chunks.length) return finish(true);
var utterance = new SpeechSynthesisUtterance(chunks[index++]);
utterance.lang = lang;
utterance.rate = settings.rate;
if (voice) utterance.voice = voice;
utterance.onend = next;
utterance.onerror = function (event) {
// "interrupted"/"canceled" is our own stopSpeaking(); anything else
// skips the chunk instead of aborting the whole reply.
if (event && (event.error === "interrupted" || event.error === "canceled")) finish(false);
else next();
};
synth.speak(utterance);
}
next();
});
}

// Mobile Safari only lets speechSynthesis talk after a user gesture; an
// empty utterance spoken from the gesture that opens voice mode unlocks it.
function primeSynthesis() {
if (!synth) return;
try { synth.speak(new SpeechSynthesisUtterance("")); } catch (err) { /* ignore */ }
}

// ---- Speech recognition ------------------------------------------------

var recognition = null;
var session = null; // { mode: "dictation"|"voice", base, finalText, heard, errored }

function stopListening() {
if (recognition) {
try { recognition.stop(); } catch (err) { /* already stopped */ }
}
}

function abortListening() {
if (recognition) {
try { recognition.abort(); } catch (err) { /* already stopped */ }
}
}

function listen(mode) {
if (!Recognition) {
notify(friendlyErrorMessage("unsupported", copy()));
return false;
}
if (recognition) abortListening();
stopSpeaking();

var rec = new Recognition();
rec.lang = activeLang();
rec.continuous = false;
rec.interimResults = true;
rec.maxAlternatives = 1;

var current = {
mode: mode,
base: mode === "dictation" && els.input ? els.input.value.replace(/\s+$/, "") : "",
finalText: "",
interimText: "",
errored: null
};
session = current;
recognition = rec;

rec.onsoundstart = rec.onspeechstart = function () {
setHearing(true);
};
rec.onresult = function (event) {
var finalText = "", interim = "";
for (var i = 0; i < event.results.length; i++) {
var chunk = event.results[i][0] ? event.results[i][0].transcript : "";
if (event.results[i].isFinal) finalText += chunk;
else interim += chunk;
}
current.finalText = finalText.trim();
current.interimText = interim.trim();
onTranscript(current);
};
rec.onerror = function (event) {
current.errored = event && event.error ? event.error : "generic";
};
rec.onend = function () {
if (recognition === rec) recognition = null;
if (session === current) session = null;
setHearing(false);
onListeningEnded(current);
};

try {
rec.start();
} catch (err) {
recognition = null;
session = null;
notify(friendlyErrorMessage("generic", copy()));
return false;
}
onListeningStarted(current);
return true;
}

function transcriptOf(s) {
return [s.finalText, s.interimText].filter(Boolean).join(" ").trim();
}

function setHearing(active) {
if (els.status) els.status.classList.toggle("is-hearing", active);
if (els.panel) els.panel.classList.toggle("is-hearing", active);
}

function onListeningStarted(s) {
if (s.mode === "dictation") {
setMicState(true);
showStatus(copy().listening || "Listening...", "");
} else {
setVoiceState("listening");
}
}

function onTranscript(s) {
var text = transcriptOf(s);
if (s.mode === "dictation") {
if (els.input) {
els.input.value = s.base ? s.base + " " + text : text;
els.input.dispatchEvent(new Event("input", { bubbles: true }));
}
showStatus(copy().listening || "Listening...", text);
} else if (els.panelTranscript) {
els.panelTranscript.textContent = text;
applyDir(els.panelTranscript, text);
}
}

function onListeningEnded(s) {
var text = (s.finalText || s.interimText).trim();
var code = s.errored;
// "aborted" is always ours (a new session, closing voice mode) - silent.
var showError = code && code !== "aborted";
if (!code && !text) code = "no-speech";

if (s.mode === "dictation") {
setMicState(false);
hideStatus();
if (showError || (!text && code === "no-speech")) notify(friendlyErrorMessage(code, copy()));
if (text && els.input) {
els.input.focus();
els.input.setSelectionRange(els.input.value.length, els.input.value.length);
}
return;
}

if (!voiceModeOpen) return;
if (text && !showError) {
sendFromVoice(text);
} else if (code === "aborted") {
// Deliberately interrupted; whoever aborted sets the next state.
} else if (code === "no-speech") {
setVoiceState("idle", copy().noSpeechVoiceMode || "I didn't catch that. Tap the orb and try again.");
} else {
setVoiceState("idle", friendlyErrorMessage(code, copy()));
}
}

// ---- Dictation UI ------------------------------------------------------

function setMicState(active) {
if (!els.mic) return;
els.mic.classList.toggle("is-recording", active);
els.mic.setAttribute("aria-pressed", String(active));
els.mic.setAttribute("aria-label", active ? "Stop voice input" : "Voice input");
els.mic.title = active ? "Stop listening" : "Voice input";
}

function showStatus(label, transcript) {
if (!els.status) return;
els.status.hidden = false;
els.statusLabel.textContent = label;
els.statusTranscript.textContent = transcript || "";
applyDir(els.statusTranscript, transcript || "");
}

function hideStatus() {
if (els.status) els.status.hidden = true;
}

function applyDir(el, text) {
if (ARABIC_SCRIPT.test(text)) el.setAttribute("dir", "rtl");
else el.removeAttribute("dir");
}

function toggleDictation() {
if (session && session.mode === "dictation") {
stopListening();
return;
}
if (els.input && els.input.disabled) return; // a reply is streaming
listen("dictation");
}

// ---- Voice conversation mode -------------------------------------------

var voiceModeOpen = false;
var awaitingReply = false;

var STATE_LABELS = {
idle: "Tap the orb to speak",
listening: "Listening...",
thinking: "Thinking...",
speaking: "Speaking..."
};

function setVoiceState(state, message) {
if (!els.panel) return;
els.panel.dataset.state = state;
var labels = copy().states || STATE_LABELS;
els.panelLabel.textContent = labels[state] || STATE_LABELS[state];
els.orb.setAttribute("aria-label", state === "listening" ? "Stop listening" : state === "speaking" ? "Stop speaking and talk" : "Start talking");
if (message !== undefined) {
els.panelTranscript.textContent = message || "";
els.panelTranscript.classList.toggle("is-hint", Boolean(message));
} else {
els.panelTranscript.classList.remove("is-hint");
if (state === "listening") els.panelTranscript.textContent = "";
}
}

function openVoiceMode() {
if (voiceModeOpen || !els.panel) return;
if (!Recognition) {
notify(friendlyErrorMessage("unsupported", copy()));
return;
}
if (session) abortListening();
voiceModeOpen = true;
primeSynthesis();
els.composer.classList.add("is-voice-mode");
els.panel.hidden = false;
els.panelLang.value = activeLang();
setVoiceState("idle");
els.orb.focus();
// The composer may be mid-stream from a typed message; wait for it.
if (els.input && els.input.disabled) {
awaitingReply = true;
setVoiceState("thinking");
} else {
listen("voice");
}
}

function closeVoiceMode() {
if (!voiceModeOpen) return;
voiceModeOpen = false;
awaitingReply = false;
abortListening();
stopSpeaking();
els.panel.hidden = true;
els.composer.classList.remove("is-voice-mode");
if (els.voiceModeBtn) els.voiceModeBtn.focus();
}

function onOrbClick() {
var state = els.panel.dataset.state;
if (state === "listening") {
stopListening();
} else if (state === "speaking") {
stopSpeaking();
listen("voice");
} else if (state === "idle") {
listen("voice");
}
// "thinking": nothing to interrupt from here - End or wait.
}

function sendFromVoice(text) {
if (!els.input || !els.sendBtn || els.input.disabled || els.sendBtn.classList.contains("is-stop")) {
setVoiceState("idle", copy().busy || "Please wait for the current reply to finish.");
return;
}
els.input.value = text;
els.input.dispatchEvent(new Event("input", { bubbles: true }));
awaitingReply = true;
setVoiceState("thinking", "");
els.panelTranscript.textContent = text;
els.sendBtn.click();
}

// Fired by www/app.js once a generation settles (complete/stopped/failed).
function onAssistantReply(event) {
var detail = (event && event.detail) || {};
if (voiceModeOpen && awaitingReply) {
awaitingReply = false;
if (detail.status === "failed" || !detail.text) {
setVoiceState("idle", copy().replyFailed || "The reply could not be generated. Tap the orb to try again.");
return;
}
if (!settings.enabled || !synth) {
listen("voice");
return;
}
setVoiceState("speaking");
speak(detail.text, { wrapper: detail.wrapper }).then(function (completed) {
// Interrupted playback is followed by whatever interrupted it.
if (completed && voiceModeOpen && els.panel.dataset.state === "speaking") listen("voice");
});
return;
}
if (!voiceModeOpen && settings.enabled && settings.autoRead && detail.status === "complete" && detail.text) {
speak(detail.text, { wrapper: detail.wrapper });
}
}

// ---- Per-message Read aloud (button rendered by app.js) ----------------

function toggleReadAloud(wrapper) {
if (!wrapper) return;
if (speakingWrapper === wrapper) {
stopSpeaking();
return;
}
if (!synth) {
notify(copy().ttsUnsupported || "Read aloud isn't supported in this browser.");
return;
}
var text = typeof wrapper.rawText === "string" && wrapper.rawText ? wrapper.rawText : (wrapper.contentEl ? wrapper.contentEl.textContent : "");
speak(text, { wrapper: wrapper });
}

// ---- Settings (rendered inside settings-ui.js's dialog) ----------------

function applyEnabled() {
root.toggleAttribute("data-voice-off", !settings.enabled);
if (!settings.enabled) {
closeVoiceMode();
if (session) abortListening();
stopSpeaking();
}
}

function buildSelect(id, options, value) {
var select = document.createElement("select");
select.id = id;
select.className = "settings-select";
options.forEach(function (opt) {
var option = document.createElement("option");
option.value = opt[0];
option.textContent = opt[1];
select.appendChild(option);
});
select.value = String(value);
return select;
}

function buildSettingsSection(ui) {
var el = ui.section("Voice");

var enabledRow = ui.row("Voice features");
var enabledSwitch = ui.buildSwitch("settings-voice-enabled", settings.enabled);
enabledSwitch.input.setAttribute("aria-label", "Enable voice features");
enabledRow.appendChild(enabledSwitch.wrapper);
el.appendChild(enabledRow);

var autoRow = ui.row("Auto-read responses");
var autoSwitch = ui.buildSwitch("settings-voice-autoread", settings.autoRead);
autoSwitch.input.setAttribute("aria-label", "Automatically read AI responses aloud");
autoRow.appendChild(autoSwitch.wrapper);
el.appendChild(autoRow);

var langRow = ui.row("Speech language");
// "Automatic" follows the selected practice mode until a language is chosen.
var langSelect = buildSelect("settings-voice-lang", [["auto", "Automatic (follows the practice mode)"]].concat(LANGUAGES), settings.langManual ? settings.lang : "auto");
langSelect.setAttribute("aria-label", "Speech language");
langRow.appendChild(langSelect);
el.appendChild(langRow);

var rateRow = ui.row("Speech speed");
var rateControls = document.createElement("div");
rateControls.className = "settings-inline-controls";
var rateSelect = buildSelect("settings-voice-rate", RATES, settings.rate);
rateSelect.setAttribute("aria-label", "Speech speed");
var previewBtn = document.createElement("button");
previewBtn.type = "button";
previewBtn.className = "lh-btn lh-btn-secondary";
previewBtn.textContent = "Test";
previewBtn.setAttribute("aria-label", "Test the voice");
rateControls.appendChild(rateSelect);
rateControls.appendChild(previewBtn);
rateRow.appendChild(rateControls);
el.appendChild(rateRow);

var support = [];
if (!Recognition) support.push("speech input");
if (!synth) support.push("read aloud");
if (support.length) {
var note = document.createElement("p");
note.className = "settings-note";
note.textContent = "This browser doesn't support " + support.join(" or ") + ". Chrome, Edge or Safari offer the full voice experience.";
el.appendChild(note);
}

function syncDisabled() {
[autoSwitch.input, langSelect, rateSelect, previewBtn].forEach(function (c) { c.disabled = !settings.enabled; });
}
syncDisabled();

enabledSwitch.input.addEventListener("change", function () {
settings.enabled = enabledSwitch.input.checked;
saveSettings();
applyEnabled();
syncDisabled();
});
autoSwitch.input.addEventListener("change", function () {
settings.autoRead = autoSwitch.input.checked;
saveSettings();
});
langSelect.addEventListener("change", function () {
if (langSelect.value === "auto") {
settings.langManual = false;
} else {
settings.lang = langSelect.value;
settings.langManual = true;
}
saveSettings();
if (els.panelLang) els.panelLang.value = activeLang();
});
rateSelect.addEventListener("change", function () {
settings.rate = Number(rateSelect.value);
saveSettings();
});
previewBtn.addEventListener("click", function () {
if (!synth) { notify(copy().ttsUnsupported); return; }
var samples = copy().samples || {};
speak(samples[activeLang().slice(0, 2)] || "Hello! I'm LinguaHub AI.");
});

return el;
}

// ---- Voice-mode panel markup -------------------------------------------

function buildPanel() {
var panel = document.createElement("section");
panel.id = "voice-mode-panel";
panel.className = "voice-panel";
panel.hidden = true;
panel.setAttribute("aria-label", "Voice conversation");
panel.dataset.state = "idle";

var orb = document.createElement("button");
orb.type = "button";
orb.className = "voice-orb";
// Initial name; setState() below keeps it in sync with the voice state.
orb.setAttribute("aria-label", "Start talking");
var core = document.createElement("span");
core.className = "voice-orb-core";
core.setAttribute("aria-hidden", "true");
core.appendChild(buildWave(5, "voice-orb-wave"));
orb.appendChild(core);

var body = document.createElement("div");
body.className = "voice-panel-body";
var label = document.createElement("div");
label.className = "voice-panel-label";
label.setAttribute("aria-live", "polite");
var transcript = document.createElement("div");
transcript.className = "voice-panel-transcript";
body.appendChild(label);
body.appendChild(transcript);

var actions = document.createElement("div");
actions.className = "voice-panel-actions";
var langSelect = buildSelect("voice-panel-lang", LANGUAGES.map(function (l) { return [l[0], l[0].slice(0, 2).toUpperCase()]; }), activeLang());
langSelect.className = "voice-panel-lang";
langSelect.setAttribute("aria-label", "Speech language");
langSelect.title = "Speech language";
var endBtn = document.createElement("button");
endBtn.type = "button";
endBtn.className = "voice-panel-end";
endBtn.setAttribute("aria-label", "End voice conversation");
endBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
actions.appendChild(langSelect);
actions.appendChild(endBtn);

panel.appendChild(orb);
panel.appendChild(body);
panel.appendChild(actions);

orb.addEventListener("click", onOrbClick);
endBtn.addEventListener("click", closeVoiceMode);
langSelect.addEventListener("change", function () {
settings.lang = langSelect.value;
settings.langManual = true; // an explicit choice stops following the practice mode
saveSettings();
var settingsSelect = document.getElementById("settings-voice-lang");
if (settingsSelect) settingsSelect.value = settings.lang;
if (panel.dataset.state === "listening") listen("voice");
});

// Changing the practice mode changes the language the quick switch shows
// (unless the user has chosen one).
document.addEventListener("change", function (event) {
if (event.target && event.target.id === "mode-select" && els.panelLang) els.panelLang.value = activeLang();
});
panel.addEventListener("keydown", function (event) {
if (event.key === "Escape") { event.preventDefault(); closeVoiceMode(); }
});

els.panel = panel;
els.orb = orb;
els.panelLabel = label;
els.panelTranscript = transcript;
els.panelLang = langSelect;
return panel;
}

function buildWave(bars, className) {
var wave = document.createElement("span");
wave.className = "voice-wave " + (className || "");
wave.setAttribute("aria-hidden", "true");
for (var i = 0; i < bars; i++) wave.appendChild(document.createElement("i"));
return wave;
}

function buildStatus() {
var status = document.createElement("div");
status.id = "voice-status";
status.className = "voice-status";
status.hidden = true;
status.setAttribute("role", "status");
var label = document.createElement("span");
label.className = "voice-status-label";
var transcript = document.createElement("span");
transcript.className = "voice-status-transcript";
var stopBtn = document.createElement("button");
stopBtn.type = "button";
stopBtn.className = "voice-status-stop";
stopBtn.textContent = "Done";
stopBtn.setAttribute("aria-label", "Stop listening");
stopBtn.addEventListener("click", stopListening);
status.appendChild(buildWave(4));
status.appendChild(label);
status.appendChild(transcript);
status.appendChild(stopBtn);
els.status = status;
els.statusLabel = label;
els.statusTranscript = transcript;
return status;
}

// ---- Boot ---------------------------------------------------------------

applyEnabled();

document.addEventListener("DOMContentLoaded", function () {
els.input = $("user-input");
els.sendBtn = $("send-btn");
els.mic = $("voice-ptt-btn");
els.voiceModeBtn = $("voice-mode-btn");
els.composer = document.querySelector(".composer");
if (!els.composer) return;

var controls = els.composer.querySelector(".controls");
els.composer.insertBefore(buildStatus(), controls);
els.composer.insertBefore(buildPanel(), controls);

// Unsupported browsers keep the buttons (discoverability) but explain
// why instead of silently doing nothing.
if (els.mic) {
els.mic.classList.toggle("is-unsupported", !Recognition);
els.mic.addEventListener("click", toggleDictation);
}
if (els.voiceModeBtn) {
els.voiceModeBtn.classList.toggle("is-unsupported", !Recognition);
els.voiceModeBtn.addEventListener("click", openVoiceMode);
}

if (synth) {
refreshVoices();
if (typeof synth.addEventListener === "function") synth.addEventListener("voiceschanged", refreshVoices);
}
window.addEventListener("pagehide", function () { abortListening(); stopSpeaking(); });
});

document.addEventListener("linguahub:assistant-reply", onAssistantReply);

window.LinguaHubVoice = {
isSupported: function () { return Boolean(Recognition); },
isSpeechSynthesisSupported: function () { return Boolean(synth); },
getSettings: function () { return Object.assign({}, settings); },
startDictation: function () { return listen("dictation"); },
stop: stopListening,
speak: speak,
stopSpeaking: stopSpeaking,
toggleReadAloud: toggleReadAloud,
openVoiceMode: openVoiceMode,
closeVoiceMode: closeVoiceMode,
buildSettingsSection: buildSettingsSection
};
})();
