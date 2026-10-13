"use strict";

// Phase 3, step 3: chat search (pure) and the Ctrl/Cmd+K palette (fake DOM).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const Search = require("../www/chat-search.js");

const msg = (id, role, content) => ({ id, role, content });
const conv = (id, title, messages, updatedAt, extra) => Object.assign({ id, title, messages: messages || [], updatedAt: updatedAt || "2026-06-01T10:00:00.000Z", pinned: false }, extra || {});

function sample() {
  return [
    conv("c1", "Past tense help", [msg("m1", "user", "What is the past tense of go?"), msg("m2", "assistant", "The past tense of go is went. For example: I went home.")], "2026-06-10T10:00:00.000Z"),
    conv("c2", "Weather talk", [msg("m3", "user", "Let us practice talking about the weather in English"), msg("m4", "assistant", "Sure! It is sunny today.")], "2026-06-12T10:00:00.000Z"),
    conv("c3", "Arabic practice", [msg("m5", "user", "كيف أقول مرحبا بالإنجليزية؟"), msg("m6", "assistant", "تقول Hello — كلمة مرحبا تعني hello")], "2026-06-11T10:00:00.000Z"),
    conv("c4", "Untitled", [msg("m7", "user", "Nothing relevant here")], "2026-06-13T10:00:00.000Z")
  ];
}

// ---- pure search -------------------------------------------------------------------------

test("search: matches titles and message content, case-insensitively", () => {
  const index = Search.createIndex(sample());
  assert.deepEqual(Search.query(index, "PAST").map((r) => r.id), ["c1"]);
  assert.deepEqual(Search.query(index, "weather").map((r) => r.id), ["c2"]);
  assert.deepEqual(Search.query(index, "sunny").map((r) => r.id), ["c2"], "message-only match");
  assert.deepEqual(Search.query(index, "zzz-nothing"), []);
});

test("search: every word must appear somewhere in the chat; a title hit outranks a message-only hit", () => {
  const index = Search.createIndex(sample());
  assert.deepEqual(Search.query(index, "past went").map((r) => r.id), ["c1"]);
  assert.deepEqual(Search.query(index, "past weather"), [], "words split across different chats do not match");
  const results = Search.query(index, "practice");
  assert.deepEqual(results.map((r) => r.id), ["c3", "c2"], "title 'Arabic practice' beats the message-only match in c2");
});

test("search: title ranges point at the matched text so the UI can highlight it", () => {
  const index = Search.createIndex(sample());
  const r = Search.query(index, "tense")[0];
  assert.deepEqual(r.titleRanges, [[5, 10]]);
  assert.equal(r.title.slice(r.titleRanges[0][0], r.titleRanges[0][1]).toLowerCase(), "tense");
});

test("search: the snippet is a short window around the first match with correct highlight ranges", () => {
  const long = "x ".repeat(80) + "the needle is here " + "y ".repeat(80);
  const index = Search.createIndex([conv("c", "Long", [msg("m", "user", long)])]);
  const r = Search.query(index, "needle")[0];
  assert.equal(r.messageId, "m");
  assert.ok(r.snippet.text.length < 190, "snippet is short, was " + r.snippet.text.length);
  assert.ok(r.snippet.text.startsWith("…") && r.snippet.text.endsWith("…"));
  r.snippet.ranges.forEach(([s, e]) => assert.equal(r.snippet.text.slice(s, e).toLowerCase(), "needle"));
  assert.equal(r.snippet.ranges.length, 1);
});

test("search: reports the message that matched the most words (newest on ties) so the chat can scroll to it", () => {
  const index = Search.createIndex([conv("c", "T", [msg("a", "user", "apples"), msg("b", "assistant", "apples and oranges"), msg("c", "user", "oranges")])]);
  assert.equal(Search.query(index, "apples oranges")[0].messageId, "b");
  assert.equal(Search.query(index, "oranges")[0].messageId, "c", "tie -> most recent message");
});

test("search: Arabic and mixed-script text matches and highlights", () => {
  const index = Search.createIndex(sample());
  const r = Search.query(index, "مرحبا")[0];
  assert.equal(r.id, "c3");
  assert.equal(r.snippet.ranges.length >= 1, true);
  r.snippet.ranges.forEach(([s, e]) => assert.equal(r.snippet.text.slice(s, e), "مرحبا"));
});

test("search: lower-casing never shifts positions (characters like 'İ' keep their length)", () => {
  assert.equal(Search.fold("İSTANBUL Ab").length, "İSTANBUL Ab".length);
  const index = Search.createIndex([conv("c", "İstanbul trip", [msg("m", "user", "İstanbul is lovely")])]);
  const r = Search.query(index, "lovely")[0];
  r.snippet.ranges.forEach(([s, e]) => assert.equal(r.snippet.text.slice(s, e).toLowerCase(), "lovely"));
});

test("search: empty / whitespace query returns nothing; recent() lists the newest chats first", () => {
  const index = Search.createIndex(sample());
  assert.deepEqual(Search.query(index, "   "), []);
  assert.deepEqual(Search.recent(index, 2).map((r) => r.id), ["c4", "c2"]);
});

test("search: overlapping words merge into one highlight range", () => {
  assert.deepEqual(Search.rangesIn("tense tenses", ["tense", "tens"]), [[0, 5], [6, 11]]);
});

test("search: stays fast on a few hundred chats (index once, then each query is quick)", () => {
  const many = [];
  for (let i = 0; i < 300; i += 1) {
    const messages = [];
    for (let j = 0; j < 40; j += 1) messages.push(msg("m" + i + "-" + j, j % 2 ? "assistant" : "user", "filler text number " + j + " about grammar and vocabulary " + i));
    many.push(conv("c" + i, "Chat " + i, messages));
  }
  const t0 = Date.now();
  const index = Search.createIndex(many);
  const built = Date.now() - t0;
  const t1 = Date.now();
  const results = Search.query(index, "vocabulary 299");
  const queried = Date.now() - t1;
  assert.ok(results.some((r) => r.id === "c299"));
  assert.ok(built < 1500, "index build took " + built + "ms");
  assert.ok(queried < 400, "query took " + queried + "ms");
});

// ---- palette (fake DOM) ----------------------------------------------------------------------

function makePalette(conversations) {
  const listeners = { document: {} };
  function el(tag) {
    const e = { tag, children: [], attrs: {}, className: "", _l: {}, hidden: false, value: "", id: "", parentNode: null, style: {},
      setAttribute(k, v) { e.attrs[k] = String(v); }, removeAttribute(k) { delete e.attrs[k]; },
      appendChild(c) { c.parentNode = e; e.children.push(c); return c; },
      removeChild(c) { e.children = e.children.filter((x) => x !== c); c.parentNode = null; },
      addEventListener(t, h) { (e._l[t] = e._l[t] || []).push(h); },
      dispatch(t, ev) { (e._l[t] || []).forEach((h) => h(ev || {})); },
      click() { e.dispatch("click", {}); },
      focus() { doc.activeElement = e; },
      scrollIntoView() {},
      set textContent(v) { e._text = String(v); e.children = []; },
      get textContent() { return e._text !== undefined && !e.children.length ? e._text : e.children.map((c) => c.textContent).join(""); } };
    return e;
  }
  const body = el("body");
  const doc = {
    body, activeElement: el("prev"),
    createElement: el,
    createTextNode: (t) => ({ textContent: t, tag: "#text", children: [] }),
    querySelector: () => null,
    addEventListener(t, h, capture) { (listeners.document[t] = listeners.document[t] || []).push({ h, capture }); },
    removeEventListener(t, h) { listeners.document[t] = (listeners.document[t] || []).filter((x) => x.h !== h); }
  };
  const sandbox = { document: doc, setTimeout, clearTimeout, LinguaHubChatSearch: Search };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "www", "search-palette.js"), "utf8"), sandbox);
  const opened = [];
  sandbox.LinguaHubSearchPalette.init({ getConversations: () => conversations, openConversation: (id, messageId, q) => opened.push({ id, messageId, q }) });
  const fire = (type, ev) => { (listeners.document[type] || []).slice().forEach(({ h }) => h(ev)); };
  const key = (k, extra) => Object.assign({ key: k, preventDefault() {}, stopPropagation() {} }, extra || {});
  const backdrop = () => body.children.find((c) => c.className === "lh-palette-backdrop");
  const find = (cls) => { let hit = null; (function walk(n) { (n.children || []).forEach((c) => { if (c.className === cls) hit = hit || c; walk(c); }); })(body); return hit; };
  const items = () => { const list = find("lh-palette-list"); return list ? list.children : []; };
  return { sandbox, doc, fire, key, backdrop, find, items, opened, input: () => find("lh-palette-input") };
}

test("palette: Ctrl+K opens it with the input focused and recent chats listed; Ctrl+K again closes it", () => {
  const p = makePalette(sample());
  p.fire("keydown", p.key("k", { ctrlKey: true }));
  assert.ok(p.backdrop(), "palette is open");
  assert.equal(p.doc.activeElement, p.input());
  assert.equal(p.items().length, 4, "recent chats are shown before typing");
  assert.equal(p.items()[0].attrs["aria-selected"], "true");
  p.fire("keydown", p.key("k", { ctrlKey: true }));
  assert.equal(p.backdrop(), undefined);
});

test("palette: Cmd+K works too, and other key combinations do nothing", () => {
  const p = makePalette(sample());
  p.fire("keydown", p.key("k", { metaKey: true }));
  assert.ok(p.backdrop());
  p.fire("keydown", p.key("Escape"));
  p.fire("keydown", p.key("k", { ctrlKey: true, shiftKey: true }));
  p.fire("keydown", p.key("k"));
  assert.equal(p.backdrop(), undefined);
});

test("palette: typing filters (debounced), highlights with <mark>, and shows a snippet", async () => {
  const p = makePalette(sample());
  p.fire("keydown", p.key("k", { ctrlKey: true }));
  p.input().value = "went";
  p.input().dispatch("input", {});
  await new Promise((r) => setTimeout(r, 200));
  const items = p.items();
  assert.equal(items.length, 1);
  const flat = [];
  (function walk(n) { (n.children || []).forEach((c) => { flat.push(c); walk(c); }); })(items[0]);
  assert.ok(flat.some((n) => n.tag === "mark" && n.textContent.toLowerCase() === "went"), "the match is wrapped in <mark>");
  assert.ok(flat.some((n) => n.className === "lh-palette-item-snippet"));
});

test("palette: arrows move the selection (wrapping), Enter opens the selected chat with its matched message", async () => {
  const p = makePalette(sample());
  p.fire("keydown", p.key("k", { ctrlKey: true }));
  p.input().value = "practice";
  p.input().dispatch("input", {});
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(p.items().length, 2);
  assert.equal(p.items()[0].attrs["aria-selected"], "true");
  p.fire("keydown", p.key("ArrowDown"));
  assert.equal(p.items()[1].attrs["aria-selected"], "true");
  p.fire("keydown", p.key("ArrowDown"));
  assert.equal(p.items()[0].attrs["aria-selected"], "true", "wraps around");
  p.fire("keydown", p.key("ArrowUp"));
  assert.equal(p.items()[1].attrs["aria-selected"], "true");
  p.fire("keydown", p.key("Enter"));
  assert.equal(p.opened.length, 1);
  assert.equal(p.opened[0].id, "c2");
  assert.equal(p.opened[0].messageId, "m3");
  assert.equal(p.backdrop(), undefined, "closes after opening");
});

test("palette: Enter right after typing (before the debounce fires) still opens the right result", () => {
  const p = makePalette(sample());
  p.fire("keydown", p.key("k", { ctrlKey: true }));
  p.input().value = "sunny";
  p.input().dispatch("input", {});
  p.fire("keydown", p.key("Enter"));
  assert.equal(p.opened[0].id, "c2");
});

test("palette: no matches shows 'No results'; Esc closes and restores focus", async () => {
  const p = makePalette(sample());
  const before = p.doc.activeElement;
  p.fire("keydown", p.key("k", { ctrlKey: true }));
  p.input().value = "qqqqqq";
  p.input().dispatch("input", {});
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(p.items().length, 0);
  assert.equal(p.find("lh-palette-empty").hidden, false);
  assert.equal(p.find("lh-palette-empty").textContent, "No results");
  p.fire("keydown", p.key("Enter"));
  assert.equal(p.opened.length, 0, "Enter with no result does nothing");
  p.fire("keydown", p.key("Escape"));
  assert.equal(p.backdrop(), undefined);
  assert.equal(p.doc.activeElement, before);
});

test("palette: clicking a result opens it; it does not open over an existing dialog", () => {
  const p = makePalette(sample());
  p.fire("keydown", p.key("k", { ctrlKey: true }));
  p.items()[1].click();
  assert.equal(p.opened.length, 1);

  const q = makePalette(sample());
  q.doc.querySelector = (sel) => (sel === ".lh-dialog-backdrop" ? {} : null);
  q.fire("keydown", q.key("k", { ctrlKey: true }));
  assert.equal(q.backdrop(), undefined);
});

test("palette: it is wired in index.html and app.js, and the old sidebar Ctrl+K focus handler is gone", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "www", "index.html"), "utf8");
  assert.ok(html.indexOf("chat-search.js") < html.indexOf("search-palette.js"));
  assert.ok(html.indexOf("search-palette.js") < html.indexOf('src="app.js"'));
  const app = fs.readFileSync(path.join(__dirname, "..", "www", "app.js"), "utf8");
  assert.match(app, /LinguaHubSearchPalette\.init\(/);
  assert.match(app, /target\.classList\.add\("is-search-hit"\)/);
  const history = fs.readFileSync(path.join(__dirname, "..", "www", "history-ui.js"), "utf8");
  assert.doesNotMatch(history, /event\.key === "k"/);
});
