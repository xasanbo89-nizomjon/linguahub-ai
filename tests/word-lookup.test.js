"use strict";

// Phase 4, step 3: tap a word in an AI message -> popover with the meaning.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const { createDom } = require("./helpers/miniDom.js");
const WL = require("../www/word-lookup.js");

const WWW = (f) => fs.readFileSync(path.join(__dirname, "..", "www", f), "utf8");
const tick = (ms) => new Promise((r) => setTimeout(r, ms === undefined ? 15 : ms));

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)); }, removeItem: (k) => { map.delete(k); }, map };
}

const LOOKUP = { language: "en", translation: "kitob", partOfSpeech: "noun", example: "I read a book.", exampleTranslation: "Men kitob o'qiyman." };

function build({ handler } = {}) {
  const dom = createDom();
  const storage = memoryStorage();
  const calls = [];
  const spoken = [];
  const toasts = [];
  const sandbox = {
    document: dom.document, localStorage: storage, setTimeout, clearTimeout, AbortController, console,
    navigator: { onLine: true },
    LinguaHubToast: { show: (o) => toasts.push(o) },
    LinguaHubVoice: { speakText: (t, l) => { spoken.push([t, l]); return Promise.resolve(); }, stopSpeaking() {} },
    LINGUAHUB_CONFIG: { apiUrl: (p) => "http://api.test" + p },
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ body, signal: init.signal });
      const r = await (handler ? handler(body, calls.length - 1) : { reply: JSON.stringify(LOOKUP) });
      return { ok: r.ok !== false, status: r.status || 200, json: async () => ({ reply: r.reply }) };
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  ["language-pair.js", "ai-json.js", "vocab-store.js", "word-lookup.js"].forEach((f) => vm.runInContext(WWW(f), sandbox, { filename: f }));
  const pair = sandbox.LinguaHubLanguages.create({ storage });
  pair.set({ from: "uz", to: "en" });
  const vocab = sandbox.LinguaHubVocab.create({ storage });

  const chatBox = dom.document.createElement("div");
  const message = dom.document.createElement("div");
  message.className = "message ai";
  const content = dom.document.createElement("div");
  content.className = "message-content";
  message.appendChild(content);
  chatBox.appendChild(message);
  dom.document.body.appendChild(chatBox);

  let found = { word: "book", sentence: "I read a book." };
  const lookup = sandbox.LinguaHubWordLookup.init({ chatBox, pair, vocab, storage, wordFromPoint: () => found });
  return { dom, sandbox, storage, calls, spoken, toasts, pair, vocab, chatBox, message, content, lookup, setFound: (f) => { found = f; }, pop: lookup._popover, click: (target) => target.dispatch("click", { clientX: 40, clientY: 50 }) };
}

// ---- finding the word -----------------------------------------------------------------------------------

test("wordAt: finds the word under the pointer, including apostrophes and hyphens, and ignores spaces and punctuation", () => {
  const text = "Hello, world! It's a well-known fact.";
  assert.equal(WL.wordAt(text, 1), "Hello");
  assert.equal(WL.wordAt(text, 5), "Hello", "the end edge of a word still counts");
  assert.equal(WL.wordAt(text, 14), "It's");
  assert.equal(WL.wordAt(text, 24), "well-known");
  assert.equal(WL.wordAt(text, 6), "", "a comma followed by a space is not a word");
  assert.equal(WL.wordAt("", 0), "");
  assert.equal(WL.wordAt("12345", 2), "", "numbers alone are not words");
  assert.equal(WL.wordAt("'quoted'", 3), "quoted", "edge quotes are trimmed");
  assert.equal(WL.wordAt("a".repeat(100), 10), "", "absurdly long strings are not words");
});

test("wordAt: works for Arabic, Cyrillic, Turkish and Uzbek letters, with diacritics", () => {
  assert.equal(WL.wordAt("مرحبا بالعالم", 2), "مرحبا");
  assert.equal(WL.wordAt("مرحبا بالعالم", 9), "بالعالم");
  assert.equal(WL.wordAt("كَتَبَ الولد", 3), "كَتَبَ", "diacritics stay with the word");
  assert.equal(WL.wordAt("Привет, мир", 2), "Привет");
  assert.equal(WL.wordAt("Günaydın dünya", 3), "Günaydın");
  assert.equal(WL.wordAt("Oʻzbekiston go‘zal", 4), "Oʻzbekiston");
});

test("sentenceAt: returns the sentence around the word, bounded, with Arabic question marks as breaks", () => {
  const text = "First one. The cat sat down! Another?";
  assert.equal(WL.sentenceAt(text, 15), "The cat sat down!");
  assert.equal(WL.sentenceAt("هل أنت بخير؟ نعم", 4), "هل أنت بخير؟");
  const long = "word ".repeat(200);
  assert.ok(WL.sentenceAt(long, 300).length <= 230);
});

test("wordFromPoint: reads the text node under the pointer (both browser APIs); ignores non-text targets", () => {
  const node = { nodeType: 3, textContent: "Hello big world" };
  const viaRange = WL.wordFromPoint({ caretRangeFromPoint: () => ({ startContainer: node, startOffset: 7 }) }, 1, 1);
  assert.equal(viaRange.word, "big");
  const viaPosition = WL.wordFromPoint({ caretPositionFromPoint: () => ({ offsetNode: node, offset: 1 }) }, 1, 1);
  assert.equal(viaPosition.word, "Hello");
  assert.equal(WL.wordFromPoint({ caretRangeFromPoint: () => ({ startContainer: { nodeType: 1 }, startOffset: 0 }) }, 1, 1), null);
  assert.equal(WL.wordFromPoint({}, 1, 1), null);
  assert.equal(WL.wordFromPoint({ caretRangeFromPoint: () => null }, 1, 1), null);
});

// ---- cache --------------------------------------------------------------------------------------------------

test("cache: keyed by language pair and lower-cased word, persisted, bounded, and tolerant of broken storage", () => {
  const storage = memoryStorage();
  const cache = WL.createCache(storage);
  const key = cache.key({ from: "uz", to: "en" }, "Book");
  assert.equal(key, "uz>en:book");
  assert.notEqual(key, cache.key({ from: "ru", to: "en" }, "book"));
  cache.set(key, { translation: "kitob" });
  assert.equal(WL.createCache(storage).get(key).translation, "kitob", "survives a restart");
  for (let i = 0; i < 260; i += 1) cache.set("k" + i, { translation: "t" + i });
  assert.ok(cache.size() <= 200);
  assert.equal(cache.get("k0"), null, "oldest entries are dropped first");
  assert.equal(cache.get("k259").translation, "t259");

  const broken = memoryStorage();
  broken.setItem(WL.CACHE_KEY, "{not json");
  assert.equal(WL.createCache(broken).size(), 0);
  const hostile = memoryStorage();
  hostile.setItem(WL.CACHE_KEY, JSON.stringify([["ok", { translation: "x" }], ["bad", 5], 7, null]));
  assert.equal(WL.createCache(hostile).size(), 1);
  const throwing = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  const safe = WL.createCache(throwing);
  safe.set("a", { translation: "b" });
  assert.equal(safe.get("a").translation, "b", "still works from memory");
});

// ---- the popover --------------------------------------------------------------------------------------------

test("popover: tapping a word in an AI message looks it up and shows translation, part of speech and an example", async () => {
  const t = build();
  assert.equal(t.pop.hidden, true);
  t.click(t.content);
  assert.equal(t.pop.hidden, false);
  assert.match(t.pop.textContent, /Looking it up/);
  await tick();
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].body.mode, "word-lookup");
  assert.match(t.calls[0].body.messages[0].content, /Word: book\nSentence it appeared in: I read a book\./);
  assert.equal(t.dom.byClass(t.pop, "word-pop-word")[0].textContent, "book");
  assert.equal(t.dom.byClass(t.pop, "word-pop-translation")[0].textContent, "kitob");
  assert.equal(t.dom.byClass(t.pop, "word-pop-pos")[0].textContent, "noun");
  assert.equal(t.dom.byClass(t.pop, "word-pop-example")[0].textContent, "I read a book.");
  assert.equal(t.dom.byClass(t.pop, "word-pop-example-tr")[0].textContent, "Men kitob o'qiyman.");
  assert.equal(t.pop.getAttribute("role"), "dialog");
  assert.equal(t.dom.byClass(t.pop, "word-pop-translation")[0].getAttribute("dir"), "auto");
});

test("popover: a second tap on the same word comes from the cache - no new request, also after a restart", async () => {
  const t = build();
  t.click(t.content);
  await tick();
  t.lookup.close();
  t.setFound({ word: "Book", sentence: "A different sentence about a Book." });
  t.click(t.content);
  assert.equal(t.calls.length, 1, "case-insensitive cache hit");
  assert.equal(t.dom.byClass(t.pop, "word-pop-translation")[0].textContent, "kitob", "shown immediately");
  t.setFound({ word: "chair", sentence: "chair" });
  t.click(t.content);
  await tick();
  assert.equal(t.calls.length, 2, "a different word is a new lookup");
});

test("popover: Listen speaks the word in the language it is written in", async () => {
  const t = build();
  t.click(t.content);
  await tick();
  t.dom.byClass(t.pop, "word-pop-listen")[0].click();
  assert.deepEqual(t.spoken[0], ["book", "en-US"]);
});

test("popover: Save to vocabulary stores the word once and then shows it as saved", async () => {
  const t = build();
  t.click(t.content);
  await tick();
  const save = t.dom.byClass(t.pop, "word-pop-save")[0];
  assert.equal(save.textContent, "Save to vocabulary");
  save.click();
  assert.equal(save.textContent, "Saved to vocabulary");
  assert.equal(save.disabled, true);
  assert.equal(t.vocab.list({}).length, 1);
  const saved = t.vocab.list({})[0];
  assert.equal(saved.word, "book");
  assert.equal(saved.translation, "kitob");
  assert.equal(saved.lang, "en");
  assert.equal(saved.example, "I read a book.");
  assert.match(t.toasts[0].message, /Saved “book”/);

  t.lookup.close();
  t.click(t.content);
  const again = t.dom.byClass(t.pop, "word-pop-save")[0];
  assert.equal(again.textContent, "Saved to vocabulary", "already saved words are marked");
  assert.equal(again.disabled, true);
});

test("popover: a full vocabulary or a failed save tells the learner instead of failing silently", async () => {
  const t = build();
  t.click(t.content);
  await tick();
  t.vocab.add = () => ({ ok: false, reason: "word-limit-reached" });
  t.dom.byClass(t.pop, "word-pop-save")[0].click();
  assert.match(t.toasts[0].message, /vocabulary is full/);
});

test("popover: Arabic words work end to end and the popover text direction follows the content", async () => {
  const t = build({ handler: () => ({ reply: JSON.stringify({ language: "ar", translation: "kitob", partOfSpeech: "noun", example: "هذا كتاب", exampleTranslation: "Bu kitob" }) }) });
  t.setFound({ word: "كتاب", sentence: "هذا كتاب جميل" });
  t.click(t.content);
  await tick();
  assert.equal(t.dom.byClass(t.pop, "word-pop-word")[0].getAttribute("dir"), "auto");
  assert.equal(t.dom.byClass(t.pop, "word-pop-example")[0].getAttribute("dir"), "auto");
  t.dom.byClass(t.pop, "word-pop-listen")[0].click();
  assert.deepEqual(t.spoken[0], ["كتاب", "ar-SA"]);
  t.dom.byClass(t.pop, "word-pop-save")[0].click();
  assert.equal(t.vocab.list({})[0].lang, "ar");
});

test("popover: errors are friendly, have Retry, and a retry can succeed", async () => {
  let fail = true;
  const t = build({ handler: () => (fail ? { ok: false, status: 429 } : { reply: JSON.stringify(LOOKUP) }) });
  t.click(t.content);
  await tick();
  assert.match(t.pop.textContent, /too quickly/);
  assert.doesNotMatch(t.pop.textContent, /429/);
  fail = false;
  t.dom.byClass(t.pop, "lh-btn")[0].click();
  await tick();
  assert.equal(t.dom.byClass(t.pop, "word-pop-translation")[0].textContent, "kitob");
});

test("popover: an unreadable reply is an error, and failures are not cached", async () => {
  let reply = "no json here";
  const t = build({ handler: () => ({ reply }) });
  t.click(t.content);
  await tick();
  assert.match(t.pop.textContent, /AI service ran into a problem/);
  reply = JSON.stringify(LOOKUP);
  t.dom.byClass(t.pop, "lh-btn")[0].click();
  await tick();
  assert.equal(t.calls.length, 2);
  assert.equal(t.dom.byClass(t.pop, "word-pop-translation")[0].textContent, "kitob");
});

test("popover: closing cancels the request and a late answer never reopens or fills it", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const t = build({ handler: async () => { await gate; return { reply: JSON.stringify(LOOKUP) }; } });
  t.click(t.content);
  await tick(5);
  t.lookup.close();
  assert.equal(t.calls[0].signal.aborted, true);
  release();
  await tick();
  assert.equal(t.pop.hidden, true);
  assert.equal(t.pop.textContent, "");
});

test("popover: a newer tap replaces the older lookup", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const t = build({ handler: async (body, i) => { if (i === 0) await gate; return { reply: JSON.stringify(Object.assign({}, LOOKUP, { translation: "T" + i })) }; } });
  t.click(t.content);
  t.setFound({ word: "chair", sentence: "chair" });
  t.click(t.content);
  await tick();
  release();
  await tick();
  assert.equal(t.dom.byClass(t.pop, "word-pop-word")[0].textContent, "chair");
  assert.equal(t.dom.byClass(t.pop, "word-pop-translation")[0].textContent, "T1");
});

test("popover: closes on Escape, on the close button and on a click elsewhere; stays open for clicks inside it", async () => {
  const t = build();
  t.click(t.content);
  await tick();
  t.pop.dispatch("click");
  assert.equal(t.pop.hidden, false, "a click inside keeps it open");
  t.dom.document.dispatchEvent({ type: "keydown", key: "Escape" });
  assert.equal(t.pop.hidden, true);

  t.click(t.content);
  await tick();
  t.dom.byClass(t.pop, "word-pop-close")[0].click();
  assert.equal(t.pop.hidden, true);

  t.click(t.content);
  await tick();
  const elsewhere = t.dom.document.createElement("div");
  t.dom.document.body.appendChild(elsewhere);
  elsewhere.dispatch("click");
  assert.equal(t.pop.hidden, true);
});

test("popover: only AI message text opens it - not the user's messages, links, code, buttons or text selection", async () => {
  const t = build();
  const userMsg = t.dom.document.createElement("div");
  userMsg.className = "message user";
  const userContent = t.dom.document.createElement("div");
  userContent.className = "message-content";
  userMsg.appendChild(userContent);
  t.chatBox.appendChild(userMsg);
  t.click(userContent);
  assert.equal(t.pop.hidden, true, "the user's own message");

  for (const tag of ["a", "pre", "code", "button"]) {
    const inner = t.dom.document.createElement(tag);
    t.content.appendChild(inner);
    t.click(inner);
    assert.equal(t.pop.hidden, true, tag);
  }
  const actions = t.dom.document.createElement("div");
  actions.className = "message-actions";
  t.message.appendChild(actions);
  t.click(actions);
  assert.equal(t.pop.hidden, true, "the action row");

  t.sandbox.getSelection = () => ({ isCollapsed: false, toString: () => "some selected text" });
  t.click(t.content);
  assert.equal(t.pop.hidden, true, "selecting text is not tapping");
  t.sandbox.getSelection = () => ({ isCollapsed: true, toString: () => "" });
  t.click(t.content);
  assert.equal(t.pop.hidden, false);
});

test("popover: tapping spaces or punctuation does nothing", () => {
  const t = build();
  t.setFound(null);
  t.click(t.content);
  assert.equal(t.pop.hidden, true);
  assert.equal(t.calls.length, 0);
});

test("popover: text from the model is only shown as text", async () => {
  const t = build({ handler: () => ({ reply: JSON.stringify({ language: "en", translation: "<img src=x onerror=1>", partOfSpeech: "<b>n</b>", example: "<script>1</script>" }) }) });
  t.click(t.content);
  await tick();
  assert.equal(t.dom.byTag(t.pop, "img").length, 0);
  assert.equal(t.dom.byTag(t.pop, "script").length, 0);
  assert.equal(t.dom.byClass(t.pop, "word-pop-translation")[0].textContent, "<img src=x onerror=1>");
});

// ---- wiring -------------------------------------------------------------------------------------------------

test("wiring: the script is loaded after the AI layer and before app.js, started with the chat box, and styled with tokens", () => {
  const html = WWW("index.html");
  const at = (n) => html.indexOf('<script src="' + n + '"></script>');
  assert.ok(at("ai-json.js") > -1 && at("ai-json.js") < at("word-lookup.js"));
  assert.ok(at("vocab-store.js") < at("word-lookup.js"));
  assert.ok(at("word-lookup.js") < at("app.js"));
  assert.match(WWW("app.js"), /LinguaHubWordLookup\.init\(\{ chatBox: chatBox,/);
  assert.match(WWW("styles.css"), /\.word-pop\{[^}]*z-index:\s*var\(--z-dialog\)/);
  assert.doesNotMatch(WWW("app.js"), /word-lookup-cache/);
});
