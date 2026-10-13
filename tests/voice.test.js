"use strict";

// Phase 14 - voice chat pure helpers (www/voice.js). The browser runtime
// (SpeechRecognition/SpeechSynthesis) is exercised manually; these cover
// the logic that decides what gets spoken and which message users see.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const voice = require("../www/voice.js");
const strings = require("../www/strings.js");
const INDEX_HTML = fs.readFileSync(path.join(__dirname, "..", "www", "index.html"), "utf8");

test("supports exactly English, Uzbek, Arabic, Russian and Turkish", () => {
  assert.deepEqual(voice.LANGUAGES.map((l) => l[0]), ["en-US", "uz-UZ", "ar-SA", "ru-RU", "tr-TR"]);
});

test("default speech language follows the browser language when supported, else English", () => {
  assert.equal(voice.defaultLanguage("uz"), "uz-UZ");
  assert.equal(voice.defaultLanguage("ru-RU"), "ru-RU");
  assert.equal(voice.defaultLanguage("tr"), "tr-TR");
  assert.equal(voice.defaultLanguage("fr-FR"), "en-US");
  assert.equal(voice.defaultLanguage(undefined), "en-US");
});

test("settings normalize corrupt/unknown values to safe defaults", () => {
  assert.deepEqual(voice.normalizeSettings(null, "en-US"), { enabled: true, autoRead: false, lang: "en-US", langManual: false, rate: 1 });
  assert.deepEqual(
    voice.normalizeSettings({ enabled: "yes", autoRead: 1, lang: "xx-XX", rate: 99, extra: true }, "ar"),
    { enabled: true, autoRead: false, lang: "ar-SA", langManual: false, rate: 1 }
  );
  assert.deepEqual(
    voice.normalizeSettings({ enabled: false, autoRead: true, lang: "tr-TR", rate: 1.25 }, "en"),
    { enabled: false, autoRead: true, lang: "tr-TR", langManual: true, rate: 1.25 }
  );
});

test("markdown is converted to speakable text (no syntax, no code, no URLs)", () => {
  const md = "## Tip\n\n**Present perfect** uses `have` + participle.\n\n- one\n- two\n\n```js\nconsole.log(1)\n```\nSee [docs](https://x.y) or https://example.com";
  const spoken = voice.toSpeakableText(md);
  assert.doesNotMatch(spoken, /[#*`]|https?:|console\.log/);
  assert.match(spoken, /Present perfect uses have \+ participle/);
  assert.match(spoken, /code example/);
  assert.match(spoken, /See docs/);
});

test("long text is chunked under the per-utterance limit without losing words", () => {
  const text = "This is a sentence that keeps going. ".repeat(30) + "word ".repeat(80);
  const chunks = voice.splitIntoChunks(text);
  assert.ok(chunks.length > 1);
  chunks.forEach((c) => assert.ok(c.length <= 221, `chunk too long: ${c.length}`));
  assert.equal(chunks.join(" ").split(/\s+/).length, text.trim().split(/\s+/).length);
});

test("reply script overrides the recognition language for the read-aloud voice", () => {
  assert.equal(voice.detectSpeechLang("مرحبا بك", "en-US"), "ar-SA");
  assert.equal(voice.detectSpeechLang("Привет", "en-US"), "ru-RU");
  assert.equal(voice.detectSpeechLang("Salom, qalaysiz?", "uz-UZ"), "uz-UZ");
  assert.equal(voice.detectSpeechLang("Merhaba", "tr-TR"), "tr-TR");
});

test("every Web Speech error maps to friendly, non-technical copy", () => {
  const copy = strings.voice;
  for (const code of ["not-allowed", "service-not-allowed", "no-speech", "audio-capture", "network", "language-not-supported", "unsupported", "something-new"]) {
    const message = voice.friendlyErrorMessage(code, copy);
    assert.ok(message && message.length > 10, `missing message for ${code}`);
    assert.doesNotMatch(message, /not-allowed|audio-capture|no-speech/);
  }
  assert.match(voice.friendlyErrorMessage("not-allowed", copy), /Microphone access is blocked/);
  assert.match(voice.friendlyErrorMessage("no-speech", copy), /No speech detected/);
  assert.match(voice.friendlyErrorMessage("unsupported", copy), /isn't supported/);
});

test("composer markup has accessible mic and voice-mode buttons, loaded before app.js", () => {
  assert.match(INDEX_HTML, /id="voice-ptt-btn"[^>]*aria-label="Voice input"/);
  assert.match(INDEX_HTML, /id="voice-mode-btn"[^>]*aria-label="Start voice conversation"/);
  assert.ok(INDEX_HTML.indexOf('<script src="voice.js">') < INDEX_HTML.indexOf('<script src="app.js">'));
  assert.ok(INDEX_HTML.indexOf('<script src="strings.js">') < INDEX_HTML.indexOf('<script src="voice.js">'));
});

// ---- Phase 3: speech language follows the practice mode until chosen manually --------------------

test("practice modes map to their language; modes without one map to nothing", () => {
  ["ielts-reading", "ielts-listening", "ielts-writing", "ielts-speaking", "vocabulary-coach", "grammar-coach", "linguahub-tutor"].forEach((id) => {
    assert.equal(voice.languageForMode(id), "en-US", id);
  });
  ["general", "codex", "cyber", "deep-thinking", "platform-help", "nope", undefined, null].forEach((id) => {
    assert.equal(voice.languageForMode(id), null, String(id));
  });
  assert.equal(Object.prototype.hasOwnProperty.call(voice.MODE_LANGUAGES, "constructor"), false);
  assert.equal(voice.languageForMode("constructor"), null, "prototype keys are never modes");
});

test("effective language: the mode's language until the user chooses one; then the user's choice always wins", () => {
  const auto = { lang: "ar-SA", langManual: false };
  assert.equal(voice.effectiveLanguage(auto, "ielts-speaking"), "en-US", "follows the practice mode");
  assert.equal(voice.effectiveLanguage(auto, "general"), "ar-SA", "no mode language -> the default");
  assert.equal(voice.effectiveLanguage(auto, null), "ar-SA");
  const manual = { lang: "ar-SA", langManual: true };
  assert.equal(voice.effectiveLanguage(manual, "ielts-speaking"), "ar-SA", "a manual choice is never overridden");
});

test("settings saved before the manual flag existed: a non-default language counts as chosen, a default one does not", () => {
  assert.equal(voice.normalizeSettings({ lang: "ar-SA" }, "en-US").langManual, true);
  assert.equal(voice.normalizeSettings({ lang: "en-US" }, "en-US").langManual, false);
  assert.equal(voice.normalizeSettings({ lang: "uz-UZ" }, "uz").langManual, false);
  assert.equal(voice.normalizeSettings({ lang: "ar-SA", langManual: false }, "en-US").langManual, false, "an explicit flag wins");
  assert.equal(voice.normalizeSettings({ lang: "xx-XX", langManual: true }, "en-US").langManual, false, "an invalid language can never be 'chosen'");
});
