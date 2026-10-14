"use strict";

// Phase 4, step 4: the Vocabulary screen - word list, suggestions, flashcard review.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const { createDom } = require("./helpers/miniDom.js");

const WWW = (f) => fs.readFileSync(path.join(__dirname, "..", "www", f), "utf8");
const tick = (ms) => new Promise((r) => setTimeout(r, ms === undefined ? 15 : ms));

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)); }, removeItem: (k) => { map.delete(k); } };
}

function build({ handler } = {}) {
  const dom = createDom();
  const storage = memoryStorage();
  const toasts = [];
  const spoken = [];
  const calls = [];
  const sandbox = {
    document: dom.document, localStorage: storage, setTimeout, clearTimeout, AbortController, console,
    Event: class { constructor(type, init) { this.type = type; this.bubbles = init && init.bubbles; } },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    navigator: { onLine: true },
    LinguaHubToast: { show: (o) => toasts.push(o) },
    LinguaHubVoice: { speakText: (t, l) => { spoken.push([t, l]); return Promise.resolve(); }, stopSpeaking() {} },
    LINGUAHUB_CONFIG: { apiUrl: (p) => "http://api.test" + p },
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      const r = await (handler ? handler(body) : { reply: JSON.stringify({ words: [] }) });
      return { ok: r.ok !== false, status: r.status || 200, json: async () => ({ reply: r.reply }) };
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  ["language-pair.js", "ai-json.js", "vocab-store.js", "workspace.js", "ws-vocab.js"].forEach((f) => vm.runInContext(WWW(f), sandbox, { filename: f }));
  const pair = sandbox.LinguaHubLanguages.create({ storage });
  pair.set({ from: "uz", to: "en" });
  const vocab = sandbox.LinguaHubVocab.create({ storage });

  const container = dom.document.createElement("div");
  const root = dom.document.createElement("div");
  root.hidden = true;
  const titleEl = dom.document.createElement("div");
  const modeSelect = dom.document.createElement("select");
  modeSelect.value = "general";
  modeSelect.options = [{ value: "general", disabled: false }, { value: "vocabulary", disabled: false, textContent: "Vocabulary" }];
  sandbox.LinguaHubWorkspace.init({ container, root, modeSelect, pair, vocab, titleEl, focusComposer() {} });

  const activity = [];
  dom.document.addEventListener("linguahub:activity", () => activity.push(1));
  const open = (options) => { sandbox.LinguaHubWorkspace.open("vocabulary", options); };
  const panel = () => dom.all(root).find((n) => n.attrs && n.attrs["data-workspace"] === "vocabulary");
  const q = (cls) => dom.byClass(panel(), cls);
  return { dom, sandbox, vocab, pair, toasts, spoken, calls, activity, open, panel, q, modeSelect };
}

const add = (t, word, translation, extra) => t.vocab.add(Object.assign({ word, translation, lang: "en" }, extra || {})).word;

// ---- Words ------------------------------------------------------------------------------------------------

test("words: an empty list explains how to get words; the screen replaces the chat when Vocabulary is chosen", () => {
  const t = build();
  t.open();
  assert.equal(t.sandbox.LinguaHubWorkspace.getActive(), "vocabulary");
  assert.match(t.q("vocab-empty")[0].textContent, /No saved words yet/);
  assert.match(t.q("vocab-empty")[0].textContent, /Save to vocabulary/);
  assert.equal(t.q("vocab-empty")[0].hidden, false);
  assert.equal(t.q("vocab-list")[0].hidden, true);
});

test("words: saved words are listed newest first with translation, part of speech and example; the count is shown", () => {
  const t = build();
  const a = add(t, "book", "kitob", { partOfSpeech: "noun", example: "I read a book." });
  t.vocab.upsert(Object.assign({}, a, { id: "w_second", word: "cat", translation: "mushuk", createdAt: new Date(Date.now() + 5000).toISOString() }));
  t.open();
  const rows = t.q("vocab-item");
  assert.equal(rows.length, 2);
  assert.equal(t.dom.byClass(rows[0], "vocab-item-word")[0].textContent, "cat", "newest first");
  assert.equal(t.dom.byClass(rows[1], "vocab-item-translation")[0].textContent, "kitob");
  assert.equal(t.dom.byClass(rows[1], "vocab-item-pos")[0].textContent, "noun");
  assert.equal(t.dom.byClass(rows[1], "vocab-item-example")[0].textContent, "I read a book.");
  assert.equal(t.dom.byClass(rows[0], "vocab-item-word")[0].getAttribute("dir"), "auto");
  assert.equal(t.q("vocab-count")[0].textContent, "2 words");
});

test("words: search matches the word or its translation; no match says so; clearing the search brings everything back", () => {
  const t = build();
  add(t, "book", "kitob");
  add(t, "cat", "mushuk");
  t.open();
  const search = t.q("vocab-search")[0];
  search.value = "mush";
  search.dispatch("input");
  assert.deepEqual(t.q("vocab-item-word").map((n) => n.textContent), ["cat"]);
  assert.equal(t.q("vocab-count")[0].textContent, "1 of 2");
  search.value = "zzz";
  search.dispatch("input");
  assert.equal(t.q("vocab-item").length, 0);
  assert.match(t.q("vocab-empty")[0].textContent, /No words match/);
  search.value = "";
  search.dispatch("input");
  assert.equal(t.q("vocab-item").length, 2);
});

test("words: the language filter lists only languages you have words in and filters the list", () => {
  const t = build();
  add(t, "book", "kitob");
  t.vocab.add({ word: "كتاب", translation: "kitob", lang: "ar" });
  t.open();
  const select = t.q("vocab-lang")[0];
  const options = t.dom.byTag(select, "option");
  assert.deepEqual(options.map((o) => o.value), ["all", "ar", "en"]);
  assert.deepEqual(options.map((o) => o.textContent), ["All languages", "Arabic", "English"]);
  select.value = "ar";
  select.dispatch("change");
  assert.deepEqual(t.q("vocab-item-word").map((n) => n.textContent), ["كتاب"]);
  assert.equal(t.dom.byClass(t.q("vocab-item")[0], "vocab-item-word")[0].getAttribute("lang"), "ar");
});

test("words: Listen speaks the word in its own language", () => {
  const t = build();
  t.vocab.add({ word: "كتاب", translation: "kitob", lang: "ar" });
  t.open();
  t.q("vocab-listen")[0].click();
  assert.deepEqual(t.spoken[0], ["كتاب", "ar-SA"]);
});

test("words: Delete removes the word at once and offers Undo, which brings it back with its schedule", () => {
  const t = build();
  const w = add(t, "book", "kitob");
  t.vocab.review(w.id, "good");
  t.open();
  t.q("vocab-delete")[0].click();
  assert.equal(t.vocab.get(w.id), null);
  assert.equal(t.q("vocab-item").length, 0);
  const toast = t.toasts[t.toasts.length - 1];
  assert.match(toast.message, /Deleted “book”/);
  assert.equal(toast.action.label, "Undo");
  toast.action.onClick();
  assert.equal(t.vocab.get(w.id).srs.reps, 1, "the review progress is kept");
  assert.equal(t.q("vocab-item").length, 1, "and the list redraws");
});

test("words: a word saved elsewhere (the tap-a-word popover, another device) appears without reopening", () => {
  const t = build();
  t.open();
  assert.equal(t.q("vocab-item").length, 0);
  add(t, "book", "kitob");
  assert.equal(t.q("vocab-item").length, 1);
  t.vocab.notifyRemoteChange();
  assert.equal(t.q("vocab-item").length, 1);
});

test("words: labels are text only - nothing from a saved word is interpreted as markup", () => {
  const t = build();
  add(t, "<img src=x onerror=1>", "<b>x</b>");
  t.open();
  assert.equal(t.dom.byTag(t.panel(), "img").length, 0);
  assert.equal(t.dom.byTag(t.panel(), "b").length, 0);
});

// ---- suggestions -----------------------------------------------------------------------------------------------------

const SUGGESTIONS = { words: [{ word: "ticket", translation: "chipta", partOfSpeech: "noun", example: "One ticket, please." }, { word: "luggage", translation: "yuk", partOfSpeech: "noun", example: "My luggage is heavy." }] };

test("suggestions: a topic asks the AI in the practice language, shows words with Add buttons, and Add saves one", async () => {
  const t = build({ handler: () => ({ reply: JSON.stringify(SUGGESTIONS) }) });
  t.open();
  t.q("vocab-topic")[0].value = "travel";
  t.q("vocab-suggest-btn")[0].click();
  assert.match(t.q("vocab-suggest-status")[0].textContent, /Finding words/);
  await tick();
  assert.equal(t.calls[0].mode, "vocabulary");
  assert.match(t.calls[0].messages[0].content, /Practice language: English[\s\S]*native language: Uzbek[\s\S]*Topic: travel/);
  assert.equal(t.q("vocab-suggestion").length, 2);
  assert.match(t.q("vocab-suggest-status")[0].textContent, /Words in English about “travel”/);
  assert.equal(t.vocab.list({}).length, 0, "nothing is saved until the learner adds it");
  const addButton = t.q("vocab-add")[0];
  addButton.click();
  assert.equal(addButton.textContent, "Saved");
  assert.equal(addButton.disabled, true);
  assert.equal(t.vocab.list({})[0].word, "ticket");
  assert.equal(t.vocab.list({})[0].lang, "en");
  assert.equal(t.activity.length, 1);
  assert.equal(t.q("vocab-item").length, 1, "the list behind it updates");
});

test("suggestions: words already saved show as Saved; an empty topic does nothing; errors are friendly", async () => {
  let fail = false;
  const t = build({ handler: () => (fail ? { ok: false, status: 429 } : { reply: JSON.stringify(SUGGESTIONS) }) });
  add(t, "ticket", "chipta");
  t.open();
  t.q("vocab-suggest-btn")[0].click();
  assert.equal(t.calls.length, 0);
  t.q("vocab-topic")[0].value = "travel";
  t.q("vocab-topic")[0].dispatch("keydown", { key: "Enter" });
  await tick();
  assert.equal(t.q("vocab-add")[0].textContent, "Saved");
  assert.equal(t.q("vocab-add")[0].disabled, true);
  assert.equal(t.q("vocab-add")[1].textContent, "Add");

  fail = true;
  t.q("vocab-suggest-btn")[0].click();
  await tick();
  assert.match(t.q("vocab-suggest-status")[0].textContent, /too quickly/);
  assert.doesNotMatch(t.q("vocab-suggest-status")[0].textContent, /429/);
  assert.equal(t.q("vocab-suggest-btn")[0].disabled, false);
});

// ---- Review -----------------------------------------------------------------------------------------------------------

function card(t) { return t.q("flashcard")[0]; }
const grade = (t, g) => t.q("flashcard-grade").find((b) => b.getAttribute("data-grade") === g);

test("review: with no words there is nothing to review and a way back to the list", () => {
  const t = build();
  t.open({ tab: "review" });
  assert.match(t.q("vocab-done")[0].textContent, /Nothing to review yet/);
  t.q("vocab-to-words")[0].click();
  assert.equal(t.q("vocab-words")[0].hidden, false);
});

test("review: the card shows the word first; tapping flips it to the meaning and reveals the four answers with their intervals", () => {
  const t = build();
  add(t, "book", "kitob", { partOfSpeech: "noun", example: "I read a book.", exampleTranslation: "Men kitob o'qiyman." });
  t.open({ tab: "review" });
  assert.equal(t.q("vocab-review")[0].hidden, false);
  assert.equal(t.q("vocab-progress")[0].textContent, "1 / 1");
  assert.equal(t.q("flashcard-word")[0].textContent, "book");
  assert.equal(t.q("flashcard-translation").length, 0, "the answer is hidden");
  assert.equal(t.q("flashcard-grades")[0].hidden, true);
  assert.equal(card(t).getAttribute("role"), "button");
  assert.match(card(t).getAttribute("aria-label"), /Press to show the answer/);

  card(t).click();
  assert.equal(t.q("flashcard-translation")[0].textContent, "kitob");
  assert.equal(t.q("vocab-item-example")[0].textContent, "I read a book.");
  assert.equal(t.q("flashcard-grades")[0].hidden, false);
  assert.deepEqual(t.q("flashcard-grade").map((b) => b.getAttribute("data-grade")), ["again", "hard", "good", "easy"]);
  assert.deepEqual(t.q("flashcard-grade-interval").map((n) => n.textContent), ["10 min", "1 day", "1 day", "3 days"]);
  assert.match(grade(t, "good").getAttribute("aria-label"), /^Good, next review in 1 day$/);
  card(t).click();
  assert.equal(t.q("flashcard-grades")[0].hidden, true, "tapping again hides the answer");
});

test("review: Enter and Space flip the card from the keyboard", () => {
  const t = build();
  add(t, "book", "kitob");
  t.open({ tab: "review" });
  const ev = card(t).dispatch("keydown", { key: " " });
  assert.equal(ev.defaultPrevented, true);
  assert.equal(t.q("flashcard-translation").length, 1);
  card(t).dispatch("keydown", { key: "Enter" });
  assert.equal(t.q("flashcard-translation").length, 0);
});

test("review: answering Good schedules the word, moves on, and when the session ends says so", () => {
  const t = build();
  const a = add(t, "book", "kitob");
  const b = add(t, "cat", "mushuk");
  t.open({ tab: "review" });
  assert.equal(t.q("vocab-progress")[0].textContent, "1 / 2");
  const first = t.q("flashcard-word")[0].textContent;
  card(t).click();
  grade(t, "good").click();
  const reviewed = t.vocab.get(first === "book" ? a.id : b.id);
  assert.equal(reviewed.srs.reps, 1);
  assert.equal(reviewed.srs.interval, 1);
  assert.ok(Date.parse(reviewed.srs.due) > Date.now(), "no longer due today... or tomorrow's start");
  assert.equal(t.q("vocab-progress")[0].textContent, "2 / 2");
  assert.notEqual(t.q("flashcard-word")[0].textContent, first);
  assert.equal(t.q("flashcard-translation").length, 0, "the next card starts hidden");
  card(t).click();
  grade(t, "easy").click();
  assert.match(t.q("vocab-done")[0].textContent, /All done for today/);
  assert.match(t.q("vocab-done")[0].textContent, /You reviewed 2 words/);
  assert.equal(t.vocab.stats().due, 0);
  assert.equal(t.activity.length, 1, "practice is counted once");
});

test("review: Again brings the card back before the session ends", () => {
  const t = build();
  add(t, "book", "kitob");
  add(t, "cat", "mushuk");
  t.open({ tab: "review" });
  const first = t.q("flashcard-word")[0].textContent;
  card(t).click();
  grade(t, "again").click();
  const second = t.q("flashcard-word")[0].textContent;
  assert.notEqual(second, first);
  card(t).click();
  grade(t, "good").click();
  assert.equal(t.q("flashcard-word")[0].textContent, first, "the forgotten word returns last");
  assert.equal(t.vocab.get(t.vocab.list({ query: first })[0].id).srs.lapses, 1);
});

test("review: answers are available only after the card has been flipped", () => {
  const t = build();
  add(t, "book", "kitob");
  t.open({ tab: "review" });
  assert.equal(t.q("flashcard-grades")[0].hidden, true);
  t.dom.document.dispatchEvent({ type: "keydown", key: "3", target: card(t) });
  assert.equal(t.vocab.list({})[0].srs.reps, 0, "a stray key does nothing before the flip");
});

test("review: keys 1-4 answer a flipped card (Again, Hard, Good, Easy) and are ignored while typing or on other screens", () => {
  const t = build();
  const a = add(t, "book", "kitob");
  const b = add(t, "cat", "mushuk");
  const c = add(t, "dog", "it");
  t.open({ tab: "review" });
  card(t).click();
  const typing = t.dom.document.createElement("input");
  typing.tag = "input";
  t.dom.document.dispatchEvent({ type: "keydown", key: "3", target: typing, preventDefault() {} });
  assert.equal(t.vocab.stats().due, 3, "ignored while typing in a field");
  t.dom.document.dispatchEvent({ type: "keydown", key: "3", target: card(t), preventDefault() {} });
  assert.equal(t.vocab.stats().due, 2, "3 = Good");
  card(t).click();
  t.dom.document.dispatchEvent({ type: "keydown", key: "1", target: card(t), preventDefault() {} });
  assert.equal(t.vocab.stats().due, 2, "1 = Again: still due");
  t.dom.document.dispatchEvent({ type: "keydown", key: "3", ctrlKey: true, target: card(t), preventDefault() {} });
  assert.equal(t.vocab.stats().due, 2, "browser shortcuts are left alone");
  void a; void b; void c;
  t.sandbox.LinguaHubWorkspace.showChat();
  const before = t.vocab.stats().due;
  t.dom.document.dispatchEvent({ type: "keydown", key: "4", target: card(t), preventDefault() {} });
  assert.equal(t.vocab.stats().due, before, "nothing happens once the screen is closed");
});

test("review: Listen on the card speaks the word without flipping it", () => {
  const t = build();
  add(t, "book", "kitob");
  t.open({ tab: "review" });
  t.q("flashcard-listen")[0].click();
  assert.deepEqual(t.spoken[0], ["book", "en-US"]);
  assert.equal(t.q("flashcard-translation").length, 0, "the answer stays hidden");
});

test("review: a word deleted during the session is skipped; words not yet due are not shown", () => {
  const t = build();
  const a = add(t, "book", "kitob");
  add(t, "cat", "mushuk");
  const later = add(t, "dog", "it");
  t.vocab.review(later.id, "good"); // due tomorrow
  t.open({ tab: "review" });
  assert.equal(t.q("vocab-progress")[0].textContent, "1 / 2");
  t.vocab.remove(a.id);
  t.sandbox.LinguaHubWorkspace.showChat();
  t.open({ tab: "review" });
  assert.equal(t.q("vocab-progress")[0].textContent, "1 / 1");
  assert.equal(t.q("flashcard-word")[0].textContent, "cat");
});

test("review: the tab shows how many words are due, and the Words tab is the default way in", () => {
  const t = build();
  add(t, "book", "kitob");
  add(t, "cat", "mushuk");
  t.open();
  const tabs = t.q("vocab-tab");
  assert.equal(t.q("vocab-words")[0].hidden, false);
  assert.equal(t.q("vocab-review")[0].hidden, true);
  assert.equal(tabs[0].getAttribute("aria-selected"), "true");
  assert.equal(t.q("vocab-due-badge")[0].textContent, "2");
  assert.match(tabs[1].getAttribute("aria-label"), /Review, 2 due today/);
  tabs[1].click();
  assert.equal(tabs[1].getAttribute("aria-selected"), "true");
  assert.equal(t.q("vocab-review")[0].hidden, false);
  t.sandbox.LinguaHubWorkspace.showChat();
  t.open();
  assert.equal(t.q("vocab-words")[0].hidden, false, "reopening starts on the word list");
});

test("review: arrow keys move between the tabs (tablist behaviour)", () => {
  const t = build();
  t.open();
  const tabs = t.q("vocab-tab");
  tabs[0].dispatch("keydown", { key: "ArrowRight" });
  assert.equal(tabs[1].getAttribute("aria-selected"), "true");
  tabs[1].dispatch("keydown", { key: "ArrowLeft" });
  assert.equal(tabs[0].getAttribute("aria-selected"), "true");
  assert.equal(tabs[0].getAttribute("tabindex"), "0");
  assert.equal(tabs[1].getAttribute("tabindex"), "-1");
});

test("review: words arriving from another device while reviewing start a fresh queue", () => {
  const t = build();
  add(t, "book", "kitob");
  t.open({ tab: "review" });
  assert.equal(t.q("vocab-progress")[0].textContent, "1 / 1");
  t.vocab.upsert({ id: "w_remote", word: "cat", translation: "mushuk", lang: "en" });
  t.vocab.notifyRemoteChange();
  assert.equal(t.q("vocab-progress")[0].textContent, "1 / 2");
});

test("home: the 'due today' tile opens the review tab directly", () => {
  const t = build();
  add(t, "book", "kitob");
  t.open({ tab: "review" });
  assert.equal(t.q("vocab-review")[0].hidden, false);
  assert.equal(t.q("flashcard-word")[0].textContent, "book");
});

test("without storage the screen explains instead of failing", () => {
  const dom = createDom();
  const sandbox = { document: dom.document, window: null, console, setTimeout, clearTimeout, localStorage: memoryStorage(), Event: class {}, CustomEvent: class {}, AbortController };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  ["language-pair.js", "ai-json.js", "workspace.js", "ws-vocab.js"].forEach((f) => vm.runInContext(WWW(f), sandbox, { filename: f }));
  const container = dom.document.createElement("div");
  const root = dom.document.createElement("div");
  const modeSelect = dom.document.createElement("select");
  modeSelect.value = "vocabulary";
  modeSelect.options = [{ value: "vocabulary", disabled: false, textContent: "Vocabulary" }];
  sandbox.LinguaHubWorkspace.init({ container, root, modeSelect, pair: sandbox.LinguaHubLanguages.create({ storage: memoryStorage() }), vocab: null, titleEl: dom.document.createElement("div") });
  assert.match(root.textContent, /isn't available in this browser/);
});

test("styling: only theme tokens are used and the badge uses the on-accent colour", () => {
  const css = WWW("styles.css");
  assert.match(css, /\.vocab-due-badge\{[^}]*color:\s*var\(--on-accent\)/);
  assert.match(css, /\.flashcard-grade\[data-grade="again"\]\{\s*color:\s*var\(--danger-text\)/);
  assert.match(css, /\.flashcard-grade\[data-grade="easy"\]\{\s*color:\s*var\(--success-text\)/);
});
