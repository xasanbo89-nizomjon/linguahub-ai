"use strict";

// Phase 4, step 2: the JSON request layer, the grammar diff, the workspace
// framework and the Translate / Grammar / Speak screens - driven through a
// small DOM with a fake fetch, fake speech recognition and fake TTS.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const { createDom } = require("./helpers/miniDom.js");
const AI = require("../www/ai-json.js");
const Diff = require("../www/grammar-diff.js");

const WWW = (f) => fs.readFileSync(path.join(__dirname, "..", "www", f), "utf8");
const tick = (ms) => new Promise((r) => setTimeout(r, ms === undefined ? 15 : ms));

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)); }, removeItem: (k) => { map.delete(k); } };
}

// handler(body, index, init) -> { reply } | { ok:false, status } | throws
function makeFetch(handler) {
  const calls = [];
  const f = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, signal: init.signal, headers: init.headers });
    const r = await handler(body, calls.length - 1, init);
    return { ok: r.ok !== false, status: r.status || 200, json: async () => ({ reply: r.reply }) };
  };
  f.calls = calls;
  return f;
}

const reply = (obj) => ({ reply: JSON.stringify(obj) });

function build({ fetchImpl, withVoice = true, Recognition } = {}) {
  const dom = createDom();
  const storage = memoryStorage();
  const toasts = [];
  const spoken = [];
  const clipboard = [];
  const stats = { stops: 0 };
  const sandbox = {
    document: dom.document,
    localStorage: storage,
    fetch: fetchImpl || makeFetch(() => reply({})),
    setTimeout, clearTimeout, AbortController, console,
    Event: class { constructor(type, init) { this.type = type; this.bubbles = init && init.bubbles; } },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    navigator: { onLine: true, clipboard: { writeText: (t) => { clipboard.push(t); return Promise.resolve(); } } },
    LinguaHubToast: { show: (o) => toasts.push(o) },
    LINGUAHUB_CONFIG: { apiUrl: (p) => "http://api.test" + p }
  };
  if (withVoice) sandbox.LinguaHubVoice = { speakText: (t, l) => { spoken.push([t, l]); return Promise.resolve(true); }, stopSpeaking: () => { stats.stops += 1; } };
  if (Recognition) sandbox.SpeechRecognition = Recognition;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  ["language-pair.js", "ai-json.js", "grammar-diff.js", "workspace.js", "ws-translate.js", "ws-grammar.js", "ws-speak.js"].forEach((f) => vm.runInContext(WWW(f), sandbox, { filename: f }));
  const pair = sandbox.LinguaHubLanguages.create({ storage });

  const container = dom.document.createElement("div");
  const root = dom.document.createElement("div");
  root.hidden = true;
  const titleEl = dom.document.createElement("div");
  titleEl.textContent = "Chat title";
  const modeSelect = dom.document.createElement("select");
  modeSelect.value = "general";
  modeSelect.options = ["general", "translate", "speak", "grammar", "vocabulary", "codex"].map((v) => ({ value: v, disabled: false, textContent: v === "general" ? "Free chat" : v[0].toUpperCase() + v.slice(1) }));
  sandbox.LinguaHubWorkspace.init({ container, root, modeSelect, pair, vocab: null, titleEl, focusComposer: () => { sandbox.composerFocused = true; } });

  const select = (mode) => { modeSelect.value = mode; modeSelect.dispatchEvent(new sandbox.Event("change", { bubbles: true })); };
  const panel = (mode) => dom.all(root).find((n) => n.attrs && n.attrs["data-workspace"] === mode);
  return { dom, sandbox, pair, container, root, titleEl, modeSelect, select, panel, toasts, spoken, clipboard, stats, fetchImpl: sandbox.fetch };
}

// ---- the JSON request layer ------------------------------------------------------------------------

test("ai: parseJsonReply handles plain JSON, code fences and chatter around the object; rejects everything else", () => {
  assert.equal(AI.parseJsonReply('{"a":1}').a, 1);
  assert.equal(AI.parseJsonReply('```json\n{"a":2}\n```').a, 2);
  assert.equal(AI.parseJsonReply('Sure! Here you go: {"a":3} Hope that helps.').a, 3);
  assert.equal(AI.parseJsonReply("[1,2,3]"), null, "arrays are not the expected object");
  assert.equal(AI.parseJsonReply("just text"), null);
  assert.equal(AI.parseJsonReply('{"a":'), null);
  assert.equal(AI.parseJsonReply(""), null);
  assert.equal(AI.parseJsonReply(null), null);
  assert.equal(AI.parseJsonReply('"string"'), null);
});

test("ai: normalizers keep only the shape each screen needs and bound the text", () => {
  assert.equal(JSON.stringify(AI.normalizeTranslate({ detected: "UZ-latn", translation: " Hello " })), '{"detected":"uz","translation":"Hello"}');
  assert.equal(AI.normalizeTranslate({ translation: "" }), null);
  assert.equal(AI.normalizeTranslate({ detected: "uz" }), null);
  assert.equal(AI.normalizeTranslate({ detected: "???", translation: "x" }).detected, "");

  const speak = AI.normalizeSpeak({ reply: "Hi!", notes: [{ kind: "grammar", text: "a" }, { kind: "weird", text: "b" }, { kind: "pronunciation", text: "" }, { kind: "vocabulary", text: "c" }, null, 5] });
  assert.equal(speak.reply, "Hi!");
  assert.equal(speak.notes.length, 2, "at most two notes, empty ones dropped");
  assert.equal(speak.notes[1].kind, "grammar", "an unknown kind becomes a plain grammar note");
  assert.equal(AI.normalizeSpeak({ notes: [] }), null);

  assert.equal(AI.normalizeLookup({ translation: "kitob", language: "EN", partOfSpeech: "noun", example: "a book", exampleTranslation: "kitob" }).language, "en");
  assert.equal(AI.normalizeLookup({ language: "en" }), null);

  const words = AI.normalizeWords({ words: Array.from({ length: 12 }, (_, i) => ({ word: "w" + i, translation: "t" + i })).concat([{ word: "", translation: "x" }, null]) });
  assert.equal(words.words.length, 8);
  assert.equal(AI.normalizeWords({ words: [] }), null);
});

test("ai: prompt builders carry the language pair and treat the text as quoted data", () => {
  const sandbox = build().sandbox;
  const P = sandbox.LinguaHubAI.prompts;
  assert.match(P.translate("auto", "en", "Salom"), /detect it automatically[\s\S]*Target language: English[\s\S]*Salom$/);
  assert.match(P.translate("uz", "en", "x"), /Source language: Uzbek/);
  assert.match(P.grammar({ from: "uz", to: "en" }, "I has"), /Writing language: English[\s\S]*native language: Uzbek[\s\S]*I has$/);
  assert.match(P.speak({ from: "uz", to: "en" }, "hello"), /^\[Practice language: English \| Native language: Uzbek\]\nhello$/);
  assert.match(P.lookup({ from: "uz", to: "en" }, "cat", "The cat sat."), /Word: cat\nSentence it appeared in: The cat sat\./);
});

test("ai: request sends the mode and messages, adds the auth header only when signed in, and returns parsed data plus the raw text", async () => {
  const fetchImpl = makeFetch(() => reply({ detected: "uz", translation: "Hello" }));
  const t = build({ fetchImpl });
  const result = await t.sandbox.LinguaHubAI.request({ mode: "translate", messages: [{ role: "user", content: "hi" }], normalize: t.sandbox.LinguaHubAI.normalizeTranslate });
  assert.equal(result.data.translation, "Hello");
  assert.equal(fetchImpl.calls[0].url, "http://api.test/api/chat");
  assert.equal(fetchImpl.calls[0].body.mode, "translate");
  assert.equal(fetchImpl.calls[0].headers.Authorization, undefined);

  t.sandbox.LinguaHubAuth = { isAvailable: () => true, getCurrentUser: () => ({ uid: "u" }), getIdToken: async () => "tok" };
  await t.sandbox.LinguaHubAI.request({ mode: "translate", messages: [{ role: "user", content: "hi" }] });
  assert.equal(fetchImpl.calls[1].headers.Authorization, "Bearer tok");
});

test("ai: request errors become friendly sentences (never raw codes); aborts are flagged, not reported", async () => {
  const cases = [[429, /too quickly/], [401, /Sign in again/], [400, /too long/], [500, /AI service ran into a problem/]];
  for (const [status, pattern] of cases) {
    const t = build({ fetchImpl: makeFetch(() => ({ ok: false, status })) });
    await assert.rejects(t.sandbox.LinguaHubAI.request({ mode: "translate", messages: [{ role: "user", content: "x" }] }), (err) => {
      assert.match(err.userMessage, pattern);
      assert.doesNotMatch(err.userMessage, /\b(429|401|400|500)\b|http/i);
      assert.equal(err.status, status);
      return true;
    });
  }
  const offline = build({ fetchImpl: makeFetch(() => { throw new TypeError("Failed to fetch"); }) });
  await assert.rejects(offline.sandbox.LinguaHubAI.request({ mode: "x", messages: [] }), (err) => /Couldn't reach/.test(err.userMessage));
  offline.sandbox.navigator.onLine = false;
  await assert.rejects(offline.sandbox.LinguaHubAI.request({ mode: "x", messages: [] }), (err) => /offline/.test(err.userMessage));

  const abortFetch = async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; };
  const aborted = build({ fetchImpl: abortFetch });
  await assert.rejects(aborted.sandbox.LinguaHubAI.request({ mode: "x", messages: [] }), (err) => err.aborted === true && err.userMessage === "");
});

test("ai: a reply that is not the expected JSON comes back as plain text with data null", async () => {
  const t = build({ fetchImpl: makeFetch(() => ({ reply: "Sorry, I can only answer in prose." })) });
  const result = await t.sandbox.LinguaHubAI.request({ mode: "translate", messages: [{ role: "user", content: "x" }], normalize: t.sandbox.LinguaHubAI.normalizeTranslate });
  assert.equal(result.data, null);
  assert.equal(result.text, "Sorry, I can only answer in prose.");
  const wrongShape = build({ fetchImpl: makeFetch(() => reply({ unrelated: true })) });
  const second = await wrongShape.sandbox.LinguaHubAI.request({ mode: "translate", messages: [{ role: "user", content: "x" }], normalize: wrongShape.sandbox.LinguaHubAI.normalizeTranslate });
  assert.equal(second.data, null);
});

// ---- grammar diff -----------------------------------------------------------------------------------

const edit = (original, correction, explanation) => ({ original, correction, explanation: explanation || "" });

test("grammar diff: edits are placed in order inside the learner's own text", () => {
  const text = "I has two cat and she go home.";
  const built = Diff.buildSegments(text, [edit("has", "have"), edit("cat", "cats"), edit("go", "goes")]);
  assert.equal(built.unplaced.length, 0);
  assert.equal(built.segments.filter((s) => s.type === "edit").map((s) => s.edit.original).join(","), "has,cat,go");
  assert.equal(built.segments.map((s) => (s.type === "text" ? s.text : "[" + s.edit.original + "]")).join(""), "I [has] two [cat] and she [go] home.");
});

test("grammar diff: a repeated word is matched at the right occurrence (searching forward), not always the first", () => {
  const built = Diff.buildSegments("go go go", [edit("go", "went"), edit("go", "going")]);
  const texts = built.segments.map((s) => (s.type === "text" ? s.text : "[" + s.edit.correction + "]")).join("");
  assert.equal(texts, "[went] [going] go");
});

test("grammar diff: an edit that is not in the text is kept aside, never inserted blindly", () => {
  const built = Diff.buildSegments("She walk.", [edit("walk", "walks"), edit("a phrase the model invented", "x")]);
  assert.equal(built.unplaced.length, 1);
  assert.equal(built.unplaced[0].original, "a phrase the model invented");
  assert.equal(Diff.applyAll("She walk.", [edit("walk", "walks")], "She walks."), "She walks.");
});

test("grammar diff: overlapping edits never overlap in the result", () => {
  const built = Diff.buildSegments("abcdef", [edit("abcd", "X"), edit("cdef", "Y")]);
  assert.equal(built.segments.filter((s) => s.type === "edit").length, 1);
  assert.equal(built.unplaced.length, 1);
});

test("grammar diff: out-of-order edits still land on free spots", () => {
  const built = Diff.buildSegments("one two three", [edit("three", "3"), edit("one", "1")]);
  assert.equal(Diff.applyAll("one two three", [edit("three", "3"), edit("one", "1")]), "1 two 3");
  assert.equal(built.unplaced.length, 0);
});

test("grammar diff: applyOne accepts a single edit and leaves the others untouched", () => {
  const edits = [edit("has", "have"), edit("go", "goes")];
  const next = Diff.applyOne("I has and she go", edits, 1);
  assert.equal(next.applied, true);
  assert.equal(next.text, "I has and she goes");
  assert.equal(next.remaining.length, 1);
  assert.equal(next.remaining[0].original, "has");
  assert.equal(Diff.applyOne("nothing", edits, 0).applied, false);
});

test("grammar diff: applyAll builds from the learner's text; with unplaced edits it uses the model's corrected text", () => {
  assert.equal(Diff.applyAll("a b c", [edit("a", "A"), edit("c", "C")], "totally different"), "A b C");
  assert.equal(Diff.applyAll("a b c", [edit("zzz", "Z")], "a b C"), "a b C");
  assert.equal(Diff.applyAll("a b c", [edit("zzz", "Z")], ""), "a b c", "no corrected text -> nothing is invented");
  assert.equal(Diff.applyAll("keep me", [], "keep me"), "keep me");
});

test("grammar diff: normalize drops malformed and no-op edits, bounds the list and requires a usable shape", () => {
  const n = Diff.normalize({ corrected: "x", edits: [null, 5, { original: "", correction: "a" }, { original: "a", correction: "a" }, { original: "b", correction: "c", explanation: "why" }, { original: "d" }] }, "orig");
  assert.equal(n.edits.length, 2);
  assert.equal(n.edits[1].correction, "", "a missing correction means 'remove it'");
  assert.equal(Diff.normalize({ corrected: "" }, "orig").corrected, "orig");
  assert.equal(Diff.normalize({}, "orig"), null);
  assert.equal(Diff.normalize(null, "orig"), null);
  const many = { edits: Array.from({ length: 80 }, (_, i) => ({ original: "w" + i, correction: "v" + i })) };
  assert.equal(Diff.normalize(many, "t").edits.length, Diff.MAX_EDITS);
});

// ---- the workspace framework ---------------------------------------------------------------------------

test("workspace: choosing Translate replaces the chat with its screen and titles the header; other modes bring the chat back", () => {
  const t = build();
  assert.equal(t.root.hidden, true);
  t.select("translate");
  assert.equal(t.container.getAttribute("data-workspace"), "translate");
  assert.equal(t.root.hidden, false);
  assert.ok(t.panel("translate"));
  assert.equal(t.titleEl.textContent, "Translate");
  t.select("general");
  assert.equal(t.container.getAttribute("data-workspace"), null);
  assert.equal(t.root.hidden, true);
  assert.equal(t.titleEl.textContent, "Chat title", "the conversation title is restored");
  t.select("codex");
  assert.equal(t.root.hidden, true, "a mode without a screen keeps the chat");
});

test("workspace: screens are built once and keep their content when you switch away and back", () => {
  const t = build();
  t.select("translate");
  const first = t.panel("translate");
  const area = t.dom.byClass(first, "ws-textarea")[0];
  area.value = "kept text";
  t.select("grammar");
  assert.equal(first.hidden, true);
  assert.equal(t.panel("grammar").hidden, false);
  t.select("translate");
  assert.equal(t.panel("translate"), first);
  assert.equal(first.hidden, false);
  assert.equal(t.dom.byClass(first, "ws-textarea")[0].value, "kept text");
});

test("workspace: open() selects a listed mode (and passes options to the screen); an unlisted one explains itself", () => {
  const t = build();
  assert.equal(t.sandbox.LinguaHubWorkspace.open("grammar"), true);
  assert.equal(t.modeSelect.value, "grammar");
  assert.equal(t.sandbox.LinguaHubWorkspace.getActive(), "grammar");
  t.modeSelect.options = [{ value: "general", disabled: false }];
  assert.equal(t.sandbox.LinguaHubWorkspace.open("speak"), false);
  assert.equal(t.toasts.length, 1);
});

test("workspace: showChat() returns to Free chat from any screen, and does nothing when already in the chat", () => {
  const t = build();
  const events = [];
  t.modeSelect.addEventListener("change", () => events.push(t.modeSelect.value));
  t.sandbox.LinguaHubWorkspace.showChat();
  assert.deepEqual(events.slice(), []);
  t.select("speak");
  t.sandbox.LinguaHubWorkspace.showChat();
  assert.equal(t.modeSelect.value, "general");
  assert.equal(t.root.hidden, true);
});

test("workspace: leaving a screen deactivates it (microphone, speech and requests stop)", () => {
  const t = build();
  t.select("speak");
  t.select("general");
  assert.ok(t.stats.stops >= 1, "speech is stopped when leaving Speak");
});

// ---- Translate ---------------------------------------------------------------------------------------------

function translateParts(t) {
  const p = t.panel("translate");
  return {
    p,
    source: t.dom.byClass(p, "ws-textarea")[0],
    output: t.dom.byClass(p, "ws-output")[0],
    selects: t.dom.byTag(p, "select"),
    swap: t.dom.byClass(p, "lang-pair-swap")[0],
    buttons: t.dom.byClass(p, "ws-icon-btn"),
    detected: t.dom.byClass(p, "ws-detected")[0],
    counter: t.dom.byClass(p, "ws-counter")[0]
  };
}
const type = (el, text) => { el.value = text; el.dispatch("input"); };

test("translate: auto-detect is on by default; typing translates after a short pause and shows what was detected", async () => {
  const fetchImpl = makeFetch(() => reply({ detected: "uz", translation: "Good morning" }));
  const t = build({ fetchImpl });
  t.select("translate");
  const x = translateParts(t);
  assert.equal(x.selects[0].value, "auto");
  assert.equal(x.selects[1].value, "en");
  assert.match(x.output.textContent, /appears here/);

  type(x.source, "Xayrli tong");
  assert.equal(fetchImpl.calls.length, 0, "not on every keystroke");
  await tick(950);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].body.mode, "translate");
  assert.match(fetchImpl.calls[0].body.messages[0].content, /detect it automatically[\s\S]*Target language: English[\s\S]*Xayrli tong/);
  assert.equal(x.output.textContent, "Good morning");
  assert.equal(x.detected.textContent, "Detected: Uzbek");
  assert.equal(x.counter.textContent, "11 / 2000");
});

test("translate: Enter translates immediately; Shift+Enter does not", async () => {
  const fetchImpl = makeFetch(() => reply({ detected: "en", translation: "Salom" }));
  const t = build({ fetchImpl });
  t.select("translate");
  const x = translateParts(t);
  type(x.source, "Hello");
  const shift = x.source.dispatch("keydown", { key: "Enter", shiftKey: true });
  assert.equal(shift.defaultPrevented, false, "Shift+Enter is a new line");
  assert.equal(fetchImpl.calls.length, 0);
  const enter = x.source.dispatch("keydown", { key: "Enter" });
  assert.equal(enter.defaultPrevented, true);
  await tick();
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(x.output.textContent, "Salom");
  await tick(950);
  assert.equal(fetchImpl.calls.length, 1, "the pending debounce was cancelled by Enter");
  x.source.dispatch("keydown", { key: "Enter", isComposing: true });
  await tick();
  assert.equal(fetchImpl.calls.length, 1, "Enter during IME composition never translates");
});

test("translate: the same text is not translated twice; a newer request aborts the older one", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const fetchImpl = makeFetch(async (body, index) => {
    if (index === 0) await gate;
    return reply({ detected: "en", translation: "T" + index });
  });
  const t = build({ fetchImpl });
  t.select("translate");
  const x = translateParts(t);
  type(x.source, "first");
  x.source.dispatch("keydown", { key: "Enter" });
  await tick(5);
  type(x.source, "second");
  x.source.dispatch("keydown", { key: "Enter" });
  await tick(5);
  assert.equal(fetchImpl.calls[0].signal.aborted, true, "the older request was cancelled");
  release();
  await tick();
  assert.equal(x.output.textContent, "T1", "only the newest answer is shown");
  x.source.dispatch("keydown", { key: "Enter" });
  await tick();
  assert.equal(fetchImpl.calls.length, 2, "unchanged text, pair and mode: no new request");
});

test("translate: Copy and Listen work on both sides, in the right language", async () => {
  const fetchImpl = makeFetch(() => reply({ detected: "ru", translation: "Hello" }));
  const t = build({ fetchImpl });
  t.select("translate");
  const x = translateParts(t);
  type(x.source, "Привет");
  x.source.dispatch("keydown", { key: "Enter" });
  await tick();
  const [srcListen, srcCopy, tgtListen, tgtCopy] = x.buttons;
  srcListen.click();
  tgtListen.click();
  assert.deepEqual(t.spoken[0], ["Привет", "ru-RU"], "the detected source language is used");
  assert.deepEqual(t.spoken[1], ["Hello", "en-US"]);
  srcCopy.click();
  tgtCopy.click();
  assert.deepEqual(t.clipboard, ["Привет", "Hello"]);
});

test("translate: swapping exchanges the languages, moves the translation into the source and translates back", async () => {
  const fetchImpl = makeFetch((body) => reply(/Target language: Uzbek/.test(body.messages[0].content) ? { detected: "en", translation: "Salom dunyo" } : { detected: "uz", translation: "Hello world" }));
  const t = build({ fetchImpl });
  t.pair.set({ from: "uz", to: "en" });
  t.select("translate");
  const x = translateParts(t);
  type(x.source, "Salom dunyo");
  x.source.dispatch("keydown", { key: "Enter" });
  await tick();
  assert.equal(x.output.textContent, "Hello world");

  x.swap.click();
  await tick();
  assert.equal(JSON.stringify(t.pair.get()), '{"from":"en","to":"uz"}');
  assert.equal(x.source.value, "Hello world");
  assert.equal(x.selects[0].value, "en", "swapping switches auto-detect off");
  assert.equal(x.selects[1].value, "uz");
  assert.match(fetchImpl.calls[1].body.messages[0].content, /Source language: English[\s\S]*Target language: Uzbek/);
  assert.equal(x.output.textContent, "Salom dunyo");
});

test("translate: picking a source language (or Detect) and a target language updates the shared pair", async () => {
  const fetchImpl = makeFetch(() => reply({ detected: "ru", translation: "x" }));
  const t = build({ fetchImpl });
  t.select("translate");
  const x = translateParts(t);
  x.selects[0].value = "ru";
  x.selects[0].dispatch("change");
  assert.equal(t.pair.get().from, "ru");
  assert.equal(t.sandbox.localStorage.getItem("linguahub-ai:translate-auto"), "0");
  x.selects[1].value = "ar";
  x.selects[1].dispatch("change");
  assert.equal(t.pair.get().to, "ar");
  x.selects[0].value = "auto";
  x.selects[0].dispatch("change");
  assert.equal(t.sandbox.localStorage.getItem("linguahub-ai:translate-auto"), "1");
});

test("translate: failures show a friendly message with Retry; a non-JSON reply is shown as plain text", async () => {
  let fail = true;
  const fetchImpl = makeFetch(() => (fail ? { ok: false, status: 429 } : { reply: "Plain prose translation" }));
  const t = build({ fetchImpl });
  t.select("translate");
  const x = translateParts(t);
  type(x.source, "hello");
  x.source.dispatch("keydown", { key: "Enter" });
  await tick();
  assert.match(x.output.textContent, /too quickly/);
  assert.doesNotMatch(x.output.textContent, /429/);
  const retry = t.dom.byClass(x.output, "ws-retry")[0];
  assert.ok(retry);
  fail = false;
  retry.click();
  await tick();
  assert.equal(x.output.textContent, "Plain prose translation");
});

test("translate: clearing the text clears the translation and cancels pending work; it counts as practice once", async () => {
  const fetchImpl = makeFetch(() => reply({ detected: "en", translation: "Bonjour" }));
  const t = build({ fetchImpl });
  const activity = [];
  t.dom.document.addEventListener("linguahub:activity", () => activity.push(1));
  t.select("translate");
  const x = translateParts(t);
  type(x.source, "Hello");
  x.source.dispatch("keydown", { key: "Enter" });
  await tick();
  type(x.source, "Hello again");
  x.source.dispatch("keydown", { key: "Enter" });
  await tick();
  assert.equal(activity.length, 1, "one activity record per session");
  type(x.source, "");
  assert.match(x.output.textContent, /appears here/);
  assert.ok(x.buttons[2].disabled && x.buttons[3].disabled, "nothing to copy or listen to");
  await tick(950);
  assert.equal(fetchImpl.calls.length, 2, "no request for empty text");
});

// ---- Grammar ---------------------------------------------------------------------------------------------------

function grammarParts(t) {
  const p = t.panel("grammar");
  return { p, input: t.dom.byClass(p, "ws-textarea")[0], check: t.dom.byClass(p, "ws-check")[0], card: t.dom.byClass(p, "ws-grammar-result")[0], body: t.dom.byClass(p, "gr-text")[0], title: t.dom.byClass(p, "ws-result-title")[0], acceptAll: t.dom.byClass(p, "ws-accept-all")[0], unplaced: t.dom.byClass(p, "gr-unplaced")[0] };
}

const GRAMMAR_REPLY = reply({ corrected: "I have two cats.", edits: [{ original: "has", correction: "have", explanation: "Use 'have' with 'I'." }, { original: "cat", correction: "cats", explanation: "Plural after 'two'." }] });

test("grammar: checking shows corrections inline - wrong part struck through, correction beside it, explanation in a tooltip", async () => {
  const fetchImpl = makeFetch(() => GRAMMAR_REPLY);
  const t = build({ fetchImpl });
  t.select("grammar");
  const x = grammarParts(t);
  assert.equal(x.card.hidden, true);
  assert.equal(x.check.disabled, true, "nothing to check yet");
  type(x.input, "I has two cat.");
  assert.equal(x.check.disabled, false);
  x.check.click();
  await tick();

  assert.match(fetchImpl.calls[0].body.messages[0].content, /Writing language: English[\s\S]*native language: Uzbek[\s\S]*I has two cat\./);
  assert.equal(fetchImpl.calls[0].body.mode, "grammar");
  assert.equal(x.card.hidden, false);
  assert.equal(x.title.textContent, "2 suggestions");
  const dels = t.dom.byTag(x.body, "del");
  const inss = t.dom.byTag(x.body, "ins");
  assert.deepEqual(dels.map((d) => d.textContent), ["has", "cat"]);
  assert.deepEqual(inss.map((d) => d.textContent), ["have", "cats"]);
  assert.equal(dels[0].className, "gr-del");
  assert.equal(inss[0].className, "gr-ins");
  const tips = t.dom.byClass(x.body, "gr-tip-text");
  assert.equal(tips[0].textContent, "Use 'have' with 'I'.");
  assert.equal(x.body.textContent.replace(/Accept/g, "").includes("two"), true, "the untouched words stay in place");
});

test("grammar: the tooltip opens on click or Enter, closes on Escape, and is described for assistive tech", async () => {
  const t = build({ fetchImpl: makeFetch(() => GRAMMAR_REPLY) });
  t.select("grammar");
  const x = grammarParts(t);
  type(x.input, "I has two cat.");
  x.check.click();
  await tick();
  const first = t.dom.byClass(x.body, "gr-edit")[0];
  assert.equal(first.getAttribute("role"), "button");
  assert.match(first.getAttribute("aria-label"), /has to have\. Use 'have'/);
  assert.equal(first.getAttribute("aria-expanded"), "false");
  first.click();
  assert.equal(first.getAttribute("aria-expanded"), "true");
  assert.ok(first.classList.contains("is-open"));
  first.dispatch("keydown", { key: "Escape" });
  assert.equal(first.getAttribute("aria-expanded"), "false");
  first.dispatch("keydown", { key: "Enter" });
  assert.equal(first.getAttribute("aria-expanded"), "true");
  t.dom.document.dispatchEvent({ type: "click", target: x.input });
  assert.equal(first.getAttribute("aria-expanded"), "false", "clicking elsewhere closes it");
});

test("grammar: Accept on one correction applies just that one and keeps the rest", async () => {
  const t = build({ fetchImpl: makeFetch(() => GRAMMAR_REPLY) });
  t.select("grammar");
  const x = grammarParts(t);
  type(x.input, "I has two cat.");
  x.check.click();
  await tick();
  t.dom.byClass(x.body, "gr-accept")[0].click();
  assert.equal(x.input.value, "I have two cat.");
  assert.equal(x.title.textContent, "1 suggestion");
  assert.deepEqual(t.dom.byTag(x.body, "del").map((d) => d.textContent), ["cat"]);
});

test("grammar: Accept all applies everything, clears the markup and tells the learner", async () => {
  const t = build({ fetchImpl: makeFetch(() => GRAMMAR_REPLY) });
  t.select("grammar");
  const x = grammarParts(t);
  type(x.input, "I has two cat.");
  x.check.click();
  await tick();
  x.acceptAll.click();
  assert.equal(x.input.value, "I have two cats.");
  assert.equal(x.card.hidden, true);
  assert.match(t.toasts[t.toasts.length - 1].message, /Applied 2 corrections/);
});

test("grammar: a text with no mistakes says so and offers no Accept all", async () => {
  const t = build({ fetchImpl: makeFetch(() => reply({ corrected: "All fine here.", edits: [] })) });
  t.select("grammar");
  const x = grammarParts(t);
  type(x.input, "All fine here.");
  x.check.click();
  await tick();
  assert.match(x.title.textContent, /No mistakes found/);
  assert.equal(x.acceptAll.hidden, true);
});

test("grammar: suggestions the text cannot place are listed separately; applying never corrupts the text", async () => {
  const t = build({ fetchImpl: makeFetch(() => reply({ corrected: "She walks.", edits: [{ original: "walk", correction: "walks", explanation: "s" }, { original: "never said this", correction: "x", explanation: "y" }] })) });
  t.select("grammar");
  const x = grammarParts(t);
  type(x.input, "She walk.");
  x.check.click();
  await tick();
  assert.equal(x.unplaced.hidden, false);
  assert.match(x.unplaced.textContent, /never said this/);
  x.acceptAll.click();
  assert.equal(x.input.value, "She walks.", "the model's corrected text is used when an edit could not be placed");
});

test("grammar: editing the text discards the old result; Ctrl+Enter checks; a non-JSON reply is shown as plain feedback", async () => {
  let call = 0;
  const t = build({ fetchImpl: makeFetch(() => (call++ === 0 ? GRAMMAR_REPLY : { reply: "Your text looks good overall." })) });
  t.select("grammar");
  const x = grammarParts(t);
  type(x.input, "I has two cat.");
  x.input.dispatch("keydown", { key: "Enter", ctrlKey: true });
  await tick();
  assert.equal(x.card.hidden, false);
  type(x.input, "I has two cats.");
  assert.equal(x.card.hidden, true, "stale corrections are removed");
  x.check.click();
  await tick();
  assert.equal(x.title.textContent, "Feedback");
  assert.equal(x.body.textContent, "Your text looks good overall.");
  assert.equal(x.acceptAll.hidden, true);
});

test("grammar: a failed check shows a friendly message with Retry and records no practice", async () => {
  let fail = true;
  const t = build({ fetchImpl: makeFetch(() => (fail ? { ok: false, status: 503 } : GRAMMAR_REPLY)) });
  const activity = [];
  t.dom.document.addEventListener("linguahub:activity", () => activity.push(1));
  t.select("grammar");
  const x = grammarParts(t);
  type(x.input, "I has two cat.");
  x.check.click();
  await tick();
  assert.equal(x.title.textContent, "Couldn't check your text");
  assert.match(x.body.textContent, /AI service ran into a problem/);
  assert.equal(activity.length, 0);
  fail = false;
  t.dom.byClass(x.body, "lh-btn")[0].click();
  await tick();
  assert.equal(x.title.textContent, "2 suggestions");
  assert.equal(activity.length, 1);
});

test("grammar: text from the model is only ever shown as text (no markup is interpreted)", async () => {
  const t = build({ fetchImpl: makeFetch(() => reply({ corrected: "x", edits: [{ original: "has", correction: "<img src=x onerror=1>", explanation: "<script>1</script>" }] })) });
  t.select("grammar");
  const x = grammarParts(t);
  type(x.input, "I has");
  x.check.click();
  await tick();
  assert.equal(t.dom.byTag(x.body, "img").length, 0);
  assert.equal(t.dom.byTag(x.body, "script").length, 0);
  assert.equal(t.dom.byTag(x.body, "ins")[0].textContent, "<img src=x onerror=1>");
});

// ---- Speak -----------------------------------------------------------------------------------------------------------

class FakeRecognition {
  constructor() { FakeRecognition.last = this; this.started = false; this.stopped = false; this.aborted = false; }
  start() { this.started = true; }
  stop() { this.stopped = true; }
  abort() { this.aborted = true; }
}
const result = (text, isFinal) => ({ 0: { transcript: text }, isFinal, length: 1 });

function speakParts(t) {
  const p = t.panel("speak");
  return { p, mic: t.dom.byClass(p, "speak-mic")[0], status: t.dom.byClass(p, "speak-status")[0], transcript: t.dom.byClass(p, "speak-transcript")[0], log: t.dom.byClass(p, "speak-log")[0], typed: t.dom.byClass(p, "speak-typed")[0], typedInput: t.dom.byClass(p, "speak-typed-input")[0], reset: t.dom.byClass(p, "ws-reset")[0] };
}

const SPEAK_REPLY = reply({ reply: "I'm fine, thanks! What did you do today?", notes: [{ kind: "grammar", text: "Say 'I went', not 'I go' for the past." }, { kind: "pronunciation", text: "Stress the first syllable of 'today'." }] });

test("speak: a typed sentence gets a spoken-and-written answer with notes under the learner's line", async () => {
  const fetchImpl = makeFetch(() => SPEAK_REPLY);
  const t = build({ fetchImpl });
  t.select("speak");
  const x = speakParts(t);
  x.typedInput.value = "I go to school yesterday";
  x.typed.dispatch("submit");
  assert.match(x.status.textContent, /Thinking/);
  await tick();

  assert.equal(fetchImpl.calls[0].body.mode, "speak");
  assert.equal(fetchImpl.calls[0].body.messages[0].content, "[Practice language: English | Native language: Uzbek]\nI go to school yesterday");
  const turns = t.dom.byClass(x.log, "speak-turn");
  assert.equal(turns.length, 2);
  assert.equal(t.dom.byClass(turns[0], "speak-bubble")[0].textContent, "I go to school yesterday");
  assert.equal(t.dom.byClass(turns[1], "speak-bubble")[0].textContent, "I'm fine, thanks! What did you do today?");
  const notes = t.dom.byClass(turns[0], "speak-note");
  assert.equal(notes.length, 2, "feedback sits under the learner's own line");
  assert.equal(notes[0].attrs["data-kind"], "grammar");
  assert.match(notes[0].textContent, /Grammar.*I went/);
  assert.deepEqual(t.spoken[0], ["I'm fine, thanks! What did you do today?", "en-US"], "the answer is spoken in the practice language");
  assert.equal(x.typedInput.value, "");
  assert.match(x.status.textContent, /type your sentence below/, "back to idle (no recognition in this environment)");
});

test("speak: the conversation history is sent with every turn, trimmed, and always starts with the learner", async () => {
  const fetchImpl = makeFetch(() => reply({ reply: "Okay.", notes: [] }));
  const t = build({ fetchImpl });
  t.select("speak");
  const x = speakParts(t);
  for (let i = 0; i < 7; i += 1) {
    x.typedInput.value = "sentence " + i;
    x.typed.dispatch("submit");
    await tick();
  }
  const last = fetchImpl.calls[6].body.messages;
  assert.ok(last.length <= 8);
  assert.equal(last[0].role, "user");
  assert.equal(last[last.length - 1].role, "user");
  assert.match(last[last.length - 1].content, /sentence 6$/);
  last.forEach((m, i) => assert.equal(m.role, i % 2 === 0 ? "user" : "assistant", "roles alternate"));
});

test("speak: the microphone listens, shows a live transcript, then sends the finished sentence", async () => {
  const fetchImpl = makeFetch(() => reply({ reply: "Nice to meet you!", notes: [] }));
  const t = build({ fetchImpl, Recognition: FakeRecognition });
  t.select("speak");
  const x = speakParts(t);
  x.mic.click();
  const rec = FakeRecognition.last;
  assert.equal(rec.started, true);
  assert.equal(rec.lang, "en-US", "listens in the language being practised");
  rec.onstart();
  assert.ok(x.mic.classList.contains("is-listening"), "the waveform animation is on");
  assert.equal(x.mic.getAttribute("aria-pressed"), "true");
  assert.match(x.status.textContent, /Listening/);
  rec.onresult({ resultIndex: 0, results: [result("hel", false)] });
  assert.equal(x.transcript.textContent, "hel");
  rec.onresult({ resultIndex: 0, results: [result("hello there", true)] });
  rec.onend();
  await tick();
  assert.equal(fetchImpl.calls.length, 1);
  assert.match(fetchImpl.calls[0].body.messages[0].content, /hello there$/);
  assert.equal(x.mic.classList.contains("is-listening"), false);
  assert.equal(x.transcript.textContent, "", "the transcript is cleared once it became a turn");
});

test("speak: tapping the microphone while it listens stops it; stopping with nothing said sends nothing", async () => {
  const fetchImpl = makeFetch(() => reply({ reply: "x", notes: [] }));
  const t = build({ fetchImpl, Recognition: FakeRecognition });
  t.select("speak");
  const x = speakParts(t);
  x.mic.click();
  const rec = FakeRecognition.last;
  rec.onstart();
  x.mic.click();
  assert.equal(rec.stopped, true);
  rec.onend();
  await tick();
  assert.equal(fetchImpl.calls.length, 0);
  assert.match(x.status.textContent, /didn't catch that/);
});

test("speak: microphone problems give plain-language help and point to typing", async () => {
  const codes = { "not-allowed": /blocked/, "no-speech": /didn't hear/, "audio-capture": /No microphone/, "network": /internet connection/, "language-not-supported": /isn't available for this language/ };
  for (const code of Object.keys(codes)) {
    const t = build({ fetchImpl: makeFetch(() => reply({ reply: "x" })), Recognition: FakeRecognition });
    t.select("speak");
    const x = speakParts(t);
    x.mic.click();
    const rec = FakeRecognition.last;
    rec.onstart();
    rec.onerror({ error: code });
    rec.onend();
    assert.match(x.status.textContent, codes[code], code);
    assert.doesNotMatch(x.status.textContent, new RegExp("\\b" + code + "\\b"), "no raw error code is shown");
  }
});

test("speak: where speech recognition does not exist (e.g. Electron) the screen says so and typing still works", async () => {
  const fetchImpl = makeFetch(() => reply({ reply: "Hello!", notes: [] }));
  const t = build({ fetchImpl });
  t.select("speak");
  const x = speakParts(t);
  assert.match(x.status.textContent, /Speech input isn't available here/);
  x.mic.click();
  assert.equal(t.dom.document.activeElement, x.typedInput, "focus moves to the text box");
  x.typedInput.value = "Hi";
  x.typed.dispatch("submit");
  await tick();
  assert.equal(fetchImpl.calls.length, 1);
});

test("speak: a failed answer shows a friendly message with Retry; Retry resends without a duplicate line or history", async () => {
  let fail = true;
  const fetchImpl = makeFetch(() => (fail ? { ok: false, status: 500 } : reply({ reply: "Welcome back!", notes: [] })));
  const t = build({ fetchImpl });
  t.select("speak");
  const x = speakParts(t);
  x.typedInput.value = "good morning";
  x.typed.dispatch("submit");
  await tick();
  const error = t.dom.byClass(x.log, "speak-error")[0];
  assert.ok(error);
  assert.match(error.textContent, /AI service ran into a problem/);
  assert.equal(x.mic.disabled, false, "the screen is usable again");
  fail = false;
  t.dom.byClass(error, "lh-btn")[0].click();
  await tick();
  assert.equal(t.dom.byClass(x.log, "speak-user").length, 1, "no duplicated learner line");
  assert.equal(t.dom.byClass(x.log, "speak-error").length, 0);
  assert.equal(fetchImpl.calls[1].body.messages.length, 1, "the failed attempt is not part of the history");
});

test("speak: New conversation clears the log and history; leaving the screen stops the microphone and speech", async () => {
  const fetchImpl = makeFetch(() => reply({ reply: "Hi!", notes: [] }));
  const t = build({ fetchImpl, Recognition: FakeRecognition });
  t.select("speak");
  const x = speakParts(t);
  x.typedInput.value = "hello";
  x.typed.dispatch("submit");
  await tick();
  x.reset.click();
  assert.equal(t.dom.byClass(x.log, "speak-turn").length, 0);
  assert.equal(t.dom.byClass(x.log, "speak-intro").length, 1, "the intro is back");
  x.typedInput.value = "again";
  x.typed.dispatch("submit");
  await tick();
  assert.equal(fetchImpl.calls[1].body.messages.length, 1, "history started over");

  x.mic.click();
  const rec = FakeRecognition.last;
  rec.onstart();
  const stopsBefore = t.stats.stops;
  t.select("general");
  assert.equal(rec.aborted, true);
  assert.ok(t.stats.stops > stopsBefore);
});

test("speak: text in the conversation is only ever shown as text", async () => {
  const t = build({ fetchImpl: makeFetch(() => reply({ reply: "<img src=x onerror=1>", notes: [{ kind: "grammar", text: "<script>1</script>" }] })) });
  t.select("speak");
  const x = speakParts(t);
  x.typedInput.value = "<b>hi</b>";
  x.typed.dispatch("submit");
  await tick();
  assert.equal(t.dom.byTag(x.log, "img").length, 0);
  assert.equal(t.dom.byTag(x.log, "script").length, 0);
  assert.equal(t.dom.byTag(x.log, "b").length, 0);
  assert.equal(t.dom.byClass(x.log, "speak-bubble")[1].textContent, "<img src=x onerror=1>");
});

// ---- wiring ---------------------------------------------------------------------------------------------------------------

test("wiring: scripts load in dependency order, the workspace root exists and the chat is hidden while a screen is open", () => {
  const html = WWW("index.html");
  const names = ["language-pair.js", "ai-json.js", "workspace.js", "home-ui.js", "app.js"];
  const positions = names.map((n) => html.indexOf('<script src="' + n + '"></script>'));
  assert.ok(positions.every((p) => p > -1), "every script is included: " + positions.join(","));
  assert.deepEqual(positions.slice().sort((a, b) => a - b), positions, "dependency order");
  assert.match(html, /<div id="workspace-root" class="workspace-root" hidden><\/div>/);
  const css = WWW("styles.css");
  assert.match(css, /\.container\[data-workspace\] > \.chat-scroll-wrapper,\s*\.container\[data-workspace\] > \.composer\{\s*display:\s*none/);
  const app = WWW("app.js");
  assert.match(app, /LinguaHubWorkspace\.init\(/);
  assert.match(app, /function renderConversationMessages\(conversation\) \{[\s\S]{0,200}LinguaHubWorkspace\.showChat\(\)/);
});

test("wiring: green text meets AA on its tinted hover background (own token), and the speak animation respects reduced motion", () => {
  const theme = WWW("theme.css");
  assert.equal((theme.match(/--success-text:/g) || []).length, 4, "defined in both palettes and both no-JS fallbacks");
  assert.match(WWW("styles.css"), /\.gr-ins\{[^}]*color:\s*var\(--success-text\)/);
  assert.match(WWW("styles.css"), /@media \(prefers-reduced-motion: reduce\)/);
});
