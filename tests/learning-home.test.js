"use strict";

// Phase 4, step 1: language pair, streak helpers, word of the day, the
// vocabulary store + spaced repetition, learning-memory activity, and the
// learning home screen.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const Languages = require("../www/language-pair.js");
const Stats = require("../www/learning-stats.js");
const WordOfDay = require("../www/word-of-day.js");
const Vocab = require("../www/vocab-store.js");

const WWW = (f) => fs.readFileSync(path.join(__dirname, "..", "www", f), "utf8");

function memoryStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _map: map
  };
}

// ---- language pair --------------------------------------------------------------------------------

test("pair: defaults to Uzbek -> English and is persisted", () => {
  const storage = memoryStorage();
  const pair = Languages.create({ storage });
  assert.deepEqual(pair.get(), { from: "uz", to: "en" });
  pair.set({ from: "ru", to: "tr" });
  assert.deepEqual(JSON.parse(storage.getItem(Languages.STORAGE_KEY)), { from: "ru", to: "tr" });
  assert.deepEqual(Languages.create({ storage }).get(), { from: "ru", to: "tr" }, "a fresh instance reads it back");
});

test("pair: corrupt or hostile stored values fall back to valid ones; the two languages are never the same", () => {
  assert.deepEqual(Languages.create({ storage: memoryStorage({ [Languages.STORAGE_KEY]: "{not json" }) }).get(), { from: "uz", to: "en" });
  assert.deepEqual(Languages.normalizePair({ from: "xx", to: "<script>" }), { from: "uz", to: "en" });
  const same = Languages.normalizePair({ from: "ar", to: "ar" });
  assert.equal(same.from, "ar");
  assert.notEqual(same.to, "ar");
  assert.deepEqual(Languages.normalizePair(null), { from: "uz", to: "en" });
});

test("pair: swap exchanges the languages; choosing the other side's language swaps instead of clashing", () => {
  const pair = Languages.create({ storage: memoryStorage() });
  pair.swap();
  assert.deepEqual(pair.get(), { from: "en", to: "uz" });
  pair.setFrom("uz");
  assert.deepEqual(pair.get(), { from: "uz", to: "en" }, "uz was the target, so the sides swapped");
  pair.setTo("ar");
  assert.deepEqual(pair.get(), { from: "uz", to: "ar" });
  pair.setTo("nonsense");
  assert.deepEqual(pair.get(), { from: "uz", to: "ar" });
});

test("pair: listeners hear real changes only, and can unsubscribe", () => {
  const pair = Languages.create({ storage: memoryStorage() });
  const seen = [];
  const off = pair.onChange((p) => seen.push(p.from + ">" + p.to));
  pair.set({ from: "uz", to: "en" }); // no change
  pair.swap();
  pair.setTo("ru");
  off();
  pair.swap();
  assert.deepEqual(seen, ["en>uz", "en>ru"]);
});

test("pair: every supported language has a name, a native name and a speech tag; Arabic is right-to-left", () => {
  assert.deepEqual(Languages.LANGUAGES.map((l) => l.code), ["en", "uz", "ar", "ru", "tr"]);
  Languages.LANGUAGES.forEach((l) => {
    assert.ok(l.name && l.native && /^[a-z]{2}-[A-Z]{2}$/.test(l.speech), l.code);
  });
  assert.equal(Languages.speechLang("ar"), "ar-SA");
  assert.equal(Languages.speechLang("zz"), "en-US");
  assert.equal(Languages.isRtl("ar"), true);
  assert.equal(Languages.isRtl("en"), false);
});

// ---- streak ---------------------------------------------------------------------------------------------

const D = (y, m, d) => new Date(y, m - 1, d, 12, 0, 0);

test("streak: consecutive days ending today (or yesterday) count; a skipped day breaks it", () => {
  const days = ["2026-06-10", "2026-06-11", "2026-06-12", "2026-06-13"];
  assert.equal(Stats.streak(days, D(2026, 6, 13)), 4, "practised today");
  assert.equal(Stats.streak(days, D(2026, 6, 14)), 4, "still alive the morning after");
  assert.equal(Stats.streak(days, D(2026, 6, 15)), 0, "a whole day skipped");
  assert.equal(Stats.streak([], D(2026, 6, 13)), 0);
  assert.equal(Stats.streak(["2026-06-13"], D(2026, 6, 13)), 1);
});

test("streak: only the latest unbroken run counts, and junk or duplicate entries are ignored", () => {
  assert.equal(Stats.streak(["2026-06-01", "2026-06-02", "2026-06-12", "2026-06-13"], D(2026, 6, 13)), 2);
  assert.equal(Stats.streak(["2026-06-13", "2026-06-13", "garbage", 5, null, "2026-6-12"], D(2026, 6, 13)), 1);
  assert.equal(Stats.streak(["2026-06-20"], D(2026, 6, 13)), 0, "a date in the future (clock skew) is not a streak");
});

test("streak: month and year boundaries and DST do not break a run", () => {
  assert.equal(Stats.streak(["2025-12-30", "2025-12-31", "2026-01-01"], D(2026, 1, 1)), 3);
  assert.equal(Stats.streak(["2026-03-28", "2026-03-29", "2026-03-30"], D(2026, 3, 30)), 3, "across a spring DST change");
  assert.equal(Stats.streak(["2026-10-24", "2026-10-25", "2026-10-26"], D(2026, 10, 26)), 3, "across an autumn DST change");
});

test("stats: dayKey formats local days; mergeDays unions and sorts two histories", () => {
  assert.equal(Stats.dayKey(D(2026, 1, 5)), "2026-01-05");
  assert.deepEqual(Stats.mergeDays(["2026-06-02", "2026-06-01"], ["2026-06-02", "2026-06-03", "x"]), ["2026-06-01", "2026-06-02", "2026-06-03"]);
  assert.equal(Stats.practisedToday(["2026-06-13"], D(2026, 6, 13)), true);
  assert.equal(Stats.practisedToday(["2026-06-12"], D(2026, 6, 13)), false);
});

// ---- word of the day ----------------------------------------------------------------------------------------

test("word of the day: the same word all day for everyone, a different one the next day", () => {
  const pair = { from: "uz", to: "en" };
  const morning = WordOfDay.pick(pair, new Date(2026, 5, 13, 6, 0));
  const night = WordOfDay.pick(pair, new Date(2026, 5, 13, 23, 30));
  assert.deepEqual(morning, night);
  const next = WordOfDay.pick(pair, new Date(2026, 5, 14, 6, 0));
  assert.notEqual(next.key, morning.key);
});

test("word of the day: the word is in the LEARNING language, with the native translation and both example sentences", () => {
  const date = new Date(2026, 5, 13);
  const uzEn = WordOfDay.pick({ from: "uz", to: "en" }, date);
  const enUz = WordOfDay.pick({ from: "en", to: "uz" }, date);
  assert.equal(uzEn.key, enUz.key, "the same concept for any pair on a given day");
  assert.equal(uzEn.word, enUz.translation);
  assert.equal(uzEn.translation, enUz.word);
  assert.equal(uzEn.wordLang, "en");
  assert.equal(uzEn.translationLang, "uz");
  assert.ok(uzEn.example && uzEn.exampleTranslation);
  assert.equal(WordOfDay.pick({ from: "uz", to: "zz" }, date), null);
  assert.equal(WordOfDay.pick(null, date), null);
});

test("word of the day: the dataset is complete - every word and example exists in all five languages", () => {
  assert.ok(WordOfDay.WORDS.length >= 30);
  const codes = ["en", "uz", "ar", "ru", "tr"];
  const seen = new Set();
  WordOfDay.WORDS.forEach((entry) => {
    codes.forEach((c) => {
      assert.ok(entry.w[c] && entry.w[c].trim(), "word " + entry.w.en + " / " + c);
      assert.ok(entry.ex[c] && entry.ex[c].trim().length > 5, "example " + entry.w.en + " / " + c);
    });
    assert.equal(seen.has(entry.w.en), false, "no duplicate concept: " + entry.w.en);
    seen.add(entry.w.en);
    assert.match(entry.ex.ar, /[؀-ۿ]/, "Arabic text is Arabic script");
    assert.match(entry.ex.ru, /[Ѐ-ӿ]/, "Russian text is Cyrillic");
  });
});

test("word of the day: cycles through the whole list and never goes out of range", () => {
  const n = WordOfDay.WORDS.length;
  const keys = new Set();
  for (let i = 0; i < n; i += 1) keys.add(WordOfDay.pick({ from: "uz", to: "en" }, new Date(2026, 0, 1 + i)).key);
  assert.equal(keys.size, n);
  assert.ok(WordOfDay.pick({ from: "uz", to: "en" }, new Date(1970, 0, 1)));
  assert.ok(WordOfDay.pick({ from: "uz", to: "en" }, new Date(2100, 11, 31)));
});

// ---- vocabulary store + SRS ---------------------------------------------------------------------------------

function makeVocab(startMs) {
  const clock = { now: startMs || new Date(2026, 5, 13, 10, 0).getTime() };
  const vocab = Vocab.create({ storage: memoryStorage(), now: () => clock.now });
  return { vocab, clock };
}

const entry = (word, extra) => Object.assign({ word, translation: "tr:" + word, lang: "en", example: "I like " + word + ".", partOfSpeech: "noun" }, extra || {});

test("vocab: add, list newest first, search both sides, filter by language, remove", () => {
  const { vocab, clock } = makeVocab();
  vocab.add(entry("apple"));
  clock.now += 1000; vocab.add(entry("banana"));
  clock.now += 1000; vocab.add({ word: "kitob", translation: "book", lang: "uz" });
  assert.deepEqual(vocab.list().map((w) => w.word), ["kitob", "banana", "apple"]);
  assert.deepEqual(vocab.list({ query: "BAN" }).map((w) => w.word), ["banana"]);
  assert.deepEqual(vocab.list({ query: "book" }).map((w) => w.word), ["kitob"], "searches the translation too");
  assert.deepEqual(vocab.list({ lang: "uz" }).map((w) => w.word), ["kitob"]);
  assert.deepEqual(vocab.list({ lang: "all" }).length, 3);
  assert.deepEqual(vocab.languages(), ["en", "uz"]);
  const id = vocab.list({ query: "apple" })[0].id;
  assert.equal(vocab.remove(id).ok, true);
  assert.equal(vocab.has("apple", "en"), false);
  assert.equal(vocab.remove(id).reason, "not-found");
});

test("vocab: the same word (any case, same language) is saved once; the same spelling in another language is a different word", () => {
  const { vocab } = makeVocab();
  const first = vocab.add(entry("Apple"));
  const again = vocab.add(entry("  apple "));
  assert.equal(again.duplicate, true);
  assert.equal(again.word.id, first.word.id);
  assert.equal(vocab.list().length, 1);
  assert.equal(vocab.add(entry("apple", { lang: "tr" })).duplicate, false);
  assert.equal(vocab.list().length, 2);
});

test("vocab: invalid input is rejected and stored text is cleaned and bounded (it is untrusted)", () => {
  const { vocab } = makeVocab();
  assert.equal(vocab.add({ word: "", translation: "x", lang: "en" }).ok, false);
  assert.equal(vocab.add({ word: "x", translation: "", lang: "en" }).ok, false);
  assert.equal(vocab.add({ word: "x", translation: "y" }).ok, false);
  assert.equal(vocab.add(null).ok, false);
  const long = vocab.add({ word: "w".repeat(500), translation: "t".repeat(900), lang: "EN", example: "e".repeat(2000) }).word;
  assert.equal(long.word.length, Vocab.LIMITS.word);
  assert.equal(long.translation.length, Vocab.LIMITS.translation);
  assert.equal(long.example.length, Vocab.LIMITS.example);
  assert.equal(long.lang, "en");
  const hostile = vocab.add({ word: "<img src=x onerror=1>", translation: "line1\n\n   line2", lang: "en" }).word;
  assert.equal(hostile.word, "<img src=x onerror=1>", "kept verbatim as text (rendered with textContent only)");
  assert.equal(hostile.translation, "line1 line2");
});

test("vocab: lists are per account - guest and signed-in words are kept apart", () => {
  const storage = memoryStorage();
  const vocab = Vocab.create({ storage });
  vocab.add(entry("guestword"));
  vocab.setUserId("u1");
  assert.equal(vocab.list().length, 0);
  vocab.add(entry("accountword"));
  vocab.setUserId(null);
  assert.deepEqual(vocab.list().map((w) => w.word), ["guestword"]);
  vocab.setUserId("u1");
  assert.deepEqual(vocab.list().map((w) => w.word), ["accountword"]);
});

test("vocab: corrupt storage reads as an empty list, never a crash", () => {
  const storage = memoryStorage({ "linguahub-ai:vocab:guest": "{{{" });
  assert.deepEqual(Vocab.create({ storage }).list(), []);
  const bad = memoryStorage({ "linguahub-ai:vocab:guest": JSON.stringify({ words: [null, 5, { word: "ok", translation: "fine", lang: "en" }, { word: "no-translation", lang: "en" }] }) });
  assert.deepEqual(Vocab.create({ storage: bad }).list().map((w) => w.word), ["ok"]);
});

test("srs: a new word is due immediately", () => {
  const { vocab, clock } = makeVocab();
  vocab.add(entry("apple"));
  assert.equal(vocab.due(clock.now).length, 1);
  assert.deepEqual(vocab.stats(clock.now), { total: 1, learned: 0, due: 1 });
});

test("srs: Good steps 1 day, then 6 days, then interval x ease; due moves to the start of that day", () => {
  const now = new Date(2026, 5, 13, 10, 0).getTime();
  let srs = Vocab.newSrs(now);
  srs = Vocab.schedule(srs, "good", now);
  assert.equal(srs.interval, 1);
  assert.equal(srs.reps, 1);
  assert.equal(new Date(srs.due).getTime(), new Date(2026, 5, 14).getTime(), "tomorrow at local midnight");
  srs = Vocab.schedule(srs, "good", now + 86400000);
  assert.equal(srs.interval, 6);
  srs = Vocab.schedule(srs, "good", now + 7 * 86400000);
  assert.equal(srs.interval, Math.round(6 * 2.5));
  assert.equal(srs.reps, 3);
});

test("srs: Again resets progress, lowers ease (never below 1.3), counts a lapse and returns in 10 minutes", () => {
  const now = new Date(2026, 5, 13, 10, 0).getTime();
  let srs = Vocab.schedule(Vocab.schedule(Vocab.newSrs(now), "good", now), "good", now);
  const again = Vocab.schedule(srs, "again", now);
  assert.equal(again.reps, 0);
  assert.equal(again.interval, 0);
  assert.equal(again.lapses, 1);
  assert.ok(again.ease < srs.ease);
  assert.equal(new Date(again.due).getTime(), now + 10 * 60 * 1000);
  let low = Vocab.newSrs(now);
  for (let i = 0; i < 30; i += 1) low = Vocab.schedule(low, "again", now);
  assert.equal(low.ease, 1.3);
});

test("srs: Easy grows faster than Good, Hard slower; ease rises with Easy and falls with Hard", () => {
  const now = new Date(2026, 5, 13, 10, 0).getTime();
  const base = Vocab.schedule(Vocab.schedule(Vocab.newSrs(now), "good", now), "good", now); // reps 2, interval 6
  const easy = Vocab.schedule(base, "easy", now);
  const good = Vocab.schedule(base, "good", now);
  const hard = Vocab.schedule(base, "hard", now);
  assert.ok(easy.interval > good.interval && good.interval > hard.interval, [hard.interval, good.interval, easy.interval].join("<"));
  assert.ok(easy.ease > good.ease || easy.ease > base.ease);
  assert.ok(hard.ease < base.ease);
  [hard, good, easy].forEach((s) => assert.ok(s.interval >= base.interval + 1, "never shrinks on a pass"));
});

test("srs: schedule never mutates its input, rejects unknown grades and tolerates garbage state", () => {
  const now = Date.now();
  const original = Vocab.newSrs(now);
  const copy = JSON.stringify(original);
  Vocab.schedule(original, "good", now);
  assert.equal(JSON.stringify(original), copy);
  assert.throws(() => Vocab.schedule(original, "perfect", now), /unknown grade/);
  const fixed = Vocab.schedule({ ease: "x", interval: -5, reps: NaN, due: "never" }, "good", now);
  assert.ok(fixed.ease >= 1.3 && fixed.interval >= 1 && Number.isFinite(Date.parse(fixed.due)));
});

test("srs: previewIntervals shows the next step for every button", () => {
  const now = Date.now();
  const preview = Vocab.previewIntervals(Vocab.newSrs(now), now);
  assert.equal(preview.again, 0);
  assert.equal(preview.hard, 1);
  assert.equal(preview.good, 1);
  assert.equal(preview.easy, 3);
});

test("srs: reviewing updates the stored word; it leaves 'due today' and counts as learned after two successes", () => {
  const { vocab, clock } = makeVocab();
  const id = vocab.add(entry("apple")).word.id;
  assert.equal(vocab.review(id, "good").ok, true);
  assert.equal(vocab.due(clock.now).length, 0, "no longer due today");
  assert.equal(vocab.stats(clock.now).learned, 0);
  clock.now += 86400000;
  assert.equal(vocab.due(clock.now).length, 1, "due again tomorrow");
  vocab.review(id, "good");
  assert.equal(vocab.stats(clock.now).learned, 1);
  assert.equal(vocab.review("missing", "good").reason, "not-found");
});

test("srs: 'due today' includes everything due by the end of today, oldest first; Again returns it today", () => {
  const { vocab, clock } = makeVocab();
  const a = vocab.add(entry("alpha")).word.id;
  const b = vocab.add(entry("beta")).word.id;
  vocab.review(a, "good");
  vocab.review(b, "again");
  const due = vocab.due(clock.now).map((w) => w.id);
  assert.deepEqual(due, [b], "Again comes back within the day; Good moved to tomorrow");
  assert.equal(vocab.due(clock.now + 86400000).length, 2);
});

test("vocab: subscribers hear changes and deletions; upsert / removeSilently (used by sync) stay quiet", () => {
  const { vocab } = makeVocab();
  const events = [];
  vocab.subscribe((e) => events.push(e.type));
  const w = vocab.add(entry("apple")).word;
  vocab.review(w.id, "good");
  vocab.remove(w.id);
  assert.deepEqual(events, ["changed", "changed", "deleted"]);
  events.length = 0;
  vocab.upsert({ id: "w_remote1", word: "remote", translation: "r", lang: "en", updatedAt: 5 });
  vocab.removeSilently("w_remote1");
  assert.deepEqual(events, []);
});

test("vocab: the word limit is enforced", () => {
  const { vocab } = makeVocab();
  const words = [];
  for (let i = 0; i < Vocab.LIMITS.maxWords; i += 1) words.push({ id: "w_" + i + "abc", word: "w" + i, translation: "t", lang: "en" });
  const storage = memoryStorage({ "linguahub-ai:vocab:guest": JSON.stringify({ words }) });
  const full = Vocab.create({ storage });
  assert.equal(full.add(entry("one more")).reason, "word-limit-reached");
  assert.ok(vocab);
});

// ---- learning memory activity -----------------------------------------------------------------------------------

function loadLearningMemory(storage) {
  const handlers = {};
  const sandbox = {
    localStorage: storage,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    document: {
      addEventListener: (t, h) => { (handlers[t] = handlers[t] || []).push(h); },
      dispatchEvent: (e) => { (handlers[e.type] || []).forEach((h) => h(e)); }
    },
    LinguaHubLearningStats: Stats
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(WWW("learning-memory.js"), sandbox);
  return { memory: sandbox.LinguaHubLearningMemory, sandbox, handlers };
}

test("learning memory: recordActivity stores today once, and the streak helper reads it", () => {
  const storage = memoryStorage();
  const { memory } = loadLearningMemory(storage);
  memory.recordActivity();
  memory.recordActivity();
  const days = memory.getActivityDates();
  assert.equal(days.length, 1);
  assert.equal(days[0], Stats.dayKey());
  assert.equal(Stats.streak(days), 1);
});

test("learning memory: a chat message and the activity event both count as practice", () => {
  const { memory, sandbox } = loadLearningMemory(memoryStorage());
  sandbox.document.dispatchEvent(new sandbox.CustomEvent("linguahub:activity"));
  assert.equal(memory.getActivityDates().length, 1);
  const second = loadLearningMemory(memoryStorage());
  second.sandbox.document.dispatchEvent(new second.sandbox.CustomEvent("linguahub:tutor-message", { detail: { mode: "general" } }));
  assert.equal(second.memory.getActivityDates().length, 1);
});

test("learning memory: stored activity days are validated, bounded and keep the other fields", () => {
  const { memory } = loadLearningMemory(memoryStorage());
  const many = [];
  for (let i = 0; i < 500; i += 1) many.push("2025-" + String(1 + (i % 12)).padStart(2, "0") + "-" + String(1 + (i % 28)).padStart(2, "0"));
  memory.save({ preferredLanguage: "uz", activityDates: ["junk", 5, "2026-06-01"].concat(many) });
  const stored = memory.get();
  assert.ok(stored.activityDates.length <= 400);
  assert.ok(stored.activityDates.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)));
  assert.equal(stored.preferredLanguage, "uz");
});

// ---- the home screen ----------------------------------------------------------------------------------------------

function fakeElement(tag) {
  const e = { tag, children: [], attrs: {}, className: "", hidden: false, disabled: false, value: "", _l: {}, options: [],
    setAttribute(k, v) { e.attrs[k] = String(v); }, getAttribute(k) { return e.attrs[k]; },
    appendChild(c) { e.children.push(c); return c; },
    addEventListener(t, h) { (e._l[t] = e._l[t] || []).push(h); },
    dispatchEvent(ev) { (e._l[ev.type] || []).forEach((h) => h(ev)); return true; },
    click() { (e._l.click || []).forEach((h) => h({})); },
    set textContent(v) { e._text = String(v); e.children = []; },
    get textContent() { return e.children.length ? e.children.map((c) => c.textContent).join("") : (e._text || ""); } };
  return e;
}

function buildHome({ modeValue = "general", options = ["general", "translate", "speak", "grammar", "vocabulary"] } = {}) {
  const docHandlers = {};
  const container = fakeElement("div");
  const hero = fakeElement("div");
  const modeSelect = fakeElement("select");
  modeSelect.value = modeValue;
  modeSelect.options = options.map((v) => ({ value: v, disabled: false }));
  const toasts = [];
  const spoken = [];
  const vocab = Vocab.create({ storage: memoryStorage() });
  const sandbox = {
    localStorage: memoryStorage(),
    document: {
      createElement: fakeElement,
      getElementById: (id) => (id === "hero-default" ? hero : null),
      addEventListener: (t, h) => { (docHandlers[t] = docHandlers[t] || []).push(h); },
      hidden: false
    },
    Event: class { constructor(type, init) { this.type = type; this.bubbles = init && init.bubbles; } },
    LinguaHubLearningStats: Stats,
    LinguaHubWordOfDay: WordOfDay,
    LinguaHubToast: { show: (o) => toasts.push(o) },
    LinguaHubVoice: { speakText: (text, lang) => spoken.push([text, lang]) },
    LinguaHubLearningMemory: { getActivityDates: () => [Stats.dayKey(new Date(Date.now() - 2 * 86400000)), Stats.dayKey(new Date(Date.now() - 86400000)), Stats.dayKey()] }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  // language-pair.js builds DOM, so it must run inside the same sandbox as the home screen
  vm.runInContext(WWW("language-pair.js"), sandbox);
  vm.runInContext(WWW("home-ui.js"), sandbox);
  const pair = sandbox.LinguaHubLanguages.create({ storage: memoryStorage() });
  const home = sandbox.LinguaHubHome.init({ container, modeSelect, pair, vocab, focusComposer: () => { sandbox.focused = true; } });
  const all = [];
  (function walk(n) { all.push(n); (n.children || []).forEach(walk); })(container);
  return { home, container, hero, modeSelect, pair, vocab, toasts, spoken, sandbox, docHandlers, all: () => { const out = []; (function walk(n) { out.push(n); (n.children || []).forEach(walk); })(container); return out; } };
}

test("home: shows the title, the pair selector, the word of the day, the progress row and five mode cards", () => {
  const h = buildHome();
  const nodes = h.all();
  assert.ok(nodes.some((n) => n.className === "home-title" && /What would you like to learn today/.test(n.textContent)));
  assert.ok(nodes.some((n) => n.className === "lang-pair-select"), "language pair selector");
  assert.ok(nodes.some((n) => n.className === "lang-pair-swap"), "swap button");
  assert.ok(nodes.some((n) => /wod-card/.test(n.className)));
  const cards = nodes.filter((n) => n.className === "mode-card");
  assert.deepEqual(cards.map((c) => c.attrs["data-mode"]), ["translate", "speak", "grammar", "vocabulary", "general"]);
  assert.equal(h.sandbox.LinguaHubHome.MODE_CARDS.map((c) => c.title).join(","), "Translate,Speak,Grammar,Vocabulary,Free chat");
  h.sandbox.LinguaHubHome.MODE_CARDS.forEach((c) => assert.ok(c.text && c.icon.length, c.id + " has an icon and a one-line description"));
});

test("home: the progress row shows the day streak, words learned and due-today from real data", () => {
  const h = buildHome();
  const id = h.vocab.add(entry("alpha")).word.id;
  h.vocab.review(id, "good");
  const clockless = h.vocab.stats();
  assert.equal(clockless.total, 1);
  const tiles = h.all().filter((n) => n.className === "home-stat");
  assert.equal(tiles.length, 3);
  const values = tiles.map((t) => t.children[0].children[0].textContent);
  assert.equal(values[0], "3", "streak from the activity days");
  assert.equal(tiles[2].children[0].children[1].textContent, "due today");
});

test("home: the word-of-the-day card follows the pair, speaks in the learning language and saves to vocabulary", () => {
  const h = buildHome();
  const expected = WordOfDay.pick({ from: "uz", to: "en" }, new Date());
  assert.ok(h.all().some((n) => n.className === "wod-word" && n.textContent === expected.word));
  const listen = h.all().find((n) => /wod-icon-btn/.test(n.className));
  listen.click();
  assert.deepEqual(h.spoken[0], [expected.word, "en-US"]);

  const save = h.all().find((n) => n.className === "wod-save");
  assert.equal(save.textContent, "Save to vocabulary");
  save.click();
  assert.equal(h.vocab.has(expected.word, "en"), true);
  assert.equal(h.vocab.list()[0].translation, expected.translation);
  assert.equal(h.all().find((n) => n.className === "wod-save").textContent, "Saved to vocabulary", "re-rendered as saved");
  assert.equal(h.all().find((n) => n.className === "wod-save").disabled, true);

  h.pair.set({ from: "en", to: "ar" });
  const arWord = WordOfDay.pick({ from: "en", to: "ar" }, new Date());
  assert.ok(h.all().some((n) => n.className === "wod-word" && n.textContent === arWord.word), "re-rendered for the new pair");
  const arListen = h.all().find((n) => /wod-icon-btn/.test(n.className));
  arListen.click();
  assert.deepEqual(h.spoken[1], [arWord.word, "ar-SA"]);
  const wordEl = h.all().find((n) => n.className === "wod-word");
  assert.equal(wordEl.attrs.dir, "auto", "Arabic text lays out right-to-left");
  assert.equal(wordEl.attrs.lang, "ar");
});

test("home: clicking a mode card selects that mode (and Free chat focuses the composer)", () => {
  const h = buildHome({ modeValue: "translate" });
  const events = [];
  h.modeSelect.addEventListener("change", () => events.push(h.modeSelect.value));
  h.all().find((n) => n.attrs["data-mode"] === "grammar").click();
  assert.equal(h.modeSelect.value, "grammar");
  h.all().find((n) => n.attrs["data-mode"] === "general").click();
  assert.deepEqual(events, ["grammar", "general"]);
  assert.equal(h.sandbox.focused, true);
});

test("home: a mode the backend did not list says so instead of failing silently", () => {
  const h = buildHome({ options: ["general"] });
  h.all().find((n) => n.attrs["data-mode"] === "speak").click();
  assert.equal(h.toasts.length, 1);
  assert.equal(h.modeSelect.value, "general");
});

test("home: visible for Free chat only - other modes keep the plain hero", () => {
  const h = buildHome({ modeValue: "general" });
  assert.equal(h.container.hidden, false);
  assert.equal(h.hero.hidden, true);
  h.modeSelect.value = "codex";
  h.modeSelect._l.change.forEach((fn) => fn({}));
  assert.equal(h.container.hidden, true);
  assert.equal(h.hero.hidden, false);
});

test("home: it re-renders when the vocabulary changes or learning activity is recorded", () => {
  const h = buildHome();
  const before = h.all().find((n) => n.className === "home-stat").children[0].children[1].textContent;
  assert.ok(before);
  h.vocab.add(entry("fresh"));
  const tiles = h.all().filter((n) => n.className === "home-stat");
  assert.equal(tiles[2].children[0].children[0].textContent, "1", "one word is now due");
  assert.equal(typeof h.docHandlers["linguahub:learning-updated"][0], "function");
});

test("home: index.html wires the scripts in dependency order and keeps the plain hero as the fallback", () => {
  const html = WWW("index.html");
  const order = ["learning-stats.js", "language-pair.js", "word-of-day.js", "vocab-store.js", "learning-memory.js", "home-ui.js", "app.js"].map((name) => html.indexOf('<script src="' + name + '"></script>'));
  assert.ok(order.every((n) => n > -1));
  assert.deepEqual(order.slice().sort((a, b) => a - b), order, "scripts load in dependency order");
  assert.match(html, /<div id="home-root" class="home-root"><\/div>/);
  assert.match(html, /<div id="hero-default" class="empty-state-default">/);
  assert.equal((html.match(/class="empty-state-title"/g) || []).length, 1, "the original hero title stays unique");
  const app = WWW("app.js");
  assert.match(app, /LinguaHubHome\.init\(/);
  assert.match(app, /linguahubVocab\.setUserId\(user && user\.uid \? user\.uid : null\)/);
});

test("voice: speakText exists for every Listen button and respects the 'Voice features' setting", () => {
  const voice = WWW("voice.js");
  assert.match(voice, /speakText: function \(text, lang\)/);
  assert.match(voice, /if \(!settings\.enabled \|\| !synth\) return Promise\.resolve\(false\);/);
  assert.match(voice, /var lang = opts\.lang \|\| detectSpeechLang/);
  assert.match(WWW("styles.css"), /:root\[data-voice-off\] \.voice-feature\{\s*display:\s*none/);
});
