"use strict";

// Phase 5, step 4: first-launch onboarding (native language, language to learn, level).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { createDom } = require("./helpers/miniDom.js");
const Onboarding = require("../www/onboarding.js");

const WWW = (f) => fs.readFileSync(path.join(__dirname, "..", "www", f), "utf8");

function memoryStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)); }, removeItem: (k) => { map.delete(k); }, map };
}

function setup({ stored, pairStart, memoryData, force } = {}) {
  const dom = createDom();
  const storage = memoryStorage(stored);
  const sandbox = { window: {}, document: dom.document, localStorage: storage };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(WWW("language-pair.js"), sandbox);
  const Lang = sandbox.LinguaHubLanguages;
  const pair = Lang.create({ storage });
  if (pairStart) pair.set(pairStart);
  const saved = [];
  const memory = { get: () => Object.assign({ preferredLanguage: "uz" }, memoryData || {}), save: (v) => { saved.push(v); return Promise.resolve(v); } };
  const done = [];
  const result = Onboarding.init({ document: dom.document, storage, pair, memory, languages: Lang, onDone: (r) => done.push(r), force });
  const q = (cls) => dom.byClass(dom.document.body, cls);
  const radios = () => q("onboarding-radio");
  const pick = (value) => {
    const r = radios().find((x) => x.value === value);
    assert.ok(r, "option " + value + " is on screen");
    radios().forEach((x) => { x.checked = false; });
    r.checked = true;
    r.dispatch("change");
  };
  const next = () => q("onboarding-next")[0].click();
  const title = () => dom.byClass(dom.document.body, "onboarding-title")[0].textContent;
  return { dom, storage, pair, saved, done, result, q, radios, pick, next, title, Lang };
}

test("first launch: three short screens, starting with the native language", () => {
  const t = setup();
  assert.equal(t.result.shown, true);
  assert.equal(t.title(), "What is your native language?");
  assert.equal(t.q("onboarding-progress")[0].textContent, "Step 1 of 3");
  assert.equal(t.q("onboarding-dot").length, 3);
  const dialog = t.q("onboarding")[0];
  assert.equal(dialog.getAttribute("role"), "dialog");
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  assert.equal(dialog.getAttribute("aria-labelledby"), "onboarding-title");
  assert.deepEqual(t.radios().map((r) => r.value), ["en", "uz", "ar", "ru", "tr"]);
  assert.equal(t.q("onboarding-skip").length, 1, "Skip is there from the first screen");
  assert.equal(t.q("onboarding-back").length, 0, "no Back on the first screen");
  assert.equal(t.q("onboarding-next")[0].textContent, "Next");
  assert.equal(t.dom.document.activeElement.tag, "input", "focus lands on the selected option");
});

test("the language shown as already chosen is the current pair, so skipping nothing changes", () => {
  const t = setup({ pairStart: { from: "ru", to: "tr" } });
  assert.equal(t.radios().find((r) => r.checked).value, "ru");
});

test("native language, then the language to learn (never the same one), then the level", () => {
  const t = setup();
  t.pick("uz");
  t.next();
  assert.equal(t.title(), "Which language do you want to learn?");
  assert.equal(t.q("onboarding-progress")[0].textContent, "Step 2 of 3");
  assert.deepEqual(t.radios().map((r) => r.value), ["en", "ar", "ru", "tr"], "the native language is not offered again");
  t.pick("ar");
  t.next();
  assert.equal(t.title(), "What is your level in Arabic?");
  assert.deepEqual(t.radios().map((r) => r.value), ["beginner", "intermediate", "advanced"]);
  assert.equal(t.radios().find((r) => r.checked).value, "beginner", "a sensible default");
  assert.equal(t.q("onboarding-next")[0].textContent, "Get started");
  t.pick("advanced");
  t.next();
  assert.equal(JSON.stringify(t.pair.get()), '{"from":"uz","to":"ar"}', "saved into the language pair");
  assert.equal(t.saved.length, 1);
  assert.equal(t.saved[0].level, "advanced", "and into the learning settings");
  assert.equal(t.saved[0].preferredLanguage, "uz", "other learning settings are kept");
  assert.deepEqual(t.done[0], { skipped: false, answers: { from: "uz", to: "ar", level: "advanced" } });
  assert.equal(t.q("onboarding").length, 0, "the dialog is gone");
  assert.deepEqual(JSON.parse(t.storage.getItem(Onboarding.STORAGE_KEY)).done, true);
});

test("choosing the learning language's current partner as native language moves the other one out of the way", () => {
  const t = setup({ pairStart: { from: "uz", to: "en" } });
  t.pick("en"); // native = English, which was the language being learned
  t.next();
  assert.ok(!t.radios().some((r) => r.value === "en"));
  assert.notEqual(t.radios().find((r) => r.checked).value, "en");
  t.next();
  t.next();
  const pair = t.pair.get();
  assert.equal(pair.from, "en");
  assert.notEqual(pair.to, "en");
});

test("Back keeps the earlier answers", () => {
  const t = setup();
  t.pick("tr");
  t.next();
  t.pick("ru");
  t.q("onboarding-back")[0].click();
  assert.equal(t.title(), "What is your native language?");
  assert.equal(t.radios().find((r) => r.checked).value, "tr");
  t.next();
  assert.equal(t.radios().find((r) => r.checked).value, "ru");
});

test("Skip on any screen closes it without changing anything, and it is never shown again", () => {
  for (const screens of [0, 1, 2]) {
    const t = setup({ pairStart: { from: "uz", to: "en" } });
    for (let i = 0; i < screens; i += 1) { t.pick(t.radios()[0].value === "en" || i === 0 ? t.radios().find((r) => r.value !== "uz").value : t.radios()[0].value); t.next(); }
    t.q("onboarding-skip")[0].click();
    assert.equal(JSON.stringify(t.pair.get()), '{"from":"uz","to":"en"}', "screen " + (screens + 1) + ": the pair is untouched");
    assert.equal(t.saved.length, 0);
    assert.deepEqual(t.done[0], { skipped: true, answers: null });
    assert.equal(JSON.parse(t.storage.getItem(Onboarding.STORAGE_KEY)).skipped, true);
    assert.equal(t.q("onboarding").length, 0);
  }
});

test("Esc skips", () => {
  const t = setup();
  const e = t.dom.document.dispatchEvent({ type: "keydown", key: "Escape", preventDefault() { this.defaultPrevented = true; } });
  assert.equal(t.done.length, 1);
  assert.equal(t.done[0].skipped, true);
  assert.equal(t.q("onboarding").length, 0);
  void e;
});

test("never shown again after finishing or skipping, on later launches", () => {
  const finished = setup();
  finished.pick("uz"); finished.next(); finished.pick("en"); finished.next(); finished.next();
  const again = Onboarding.init({ document: finished.dom.document, storage: finished.storage, pair: finished.pair, memory: null, languages: finished.Lang });
  assert.equal(again.shown, false);

  const skipped = setup();
  skipped.q("onboarding-skip")[0].click();
  assert.equal(Onboarding.init({ document: skipped.dom.document, storage: skipped.storage, pair: skipped.pair, memory: null, languages: skipped.Lang }).shown, false);

  const returning = setup({ stored: { [Onboarding.STORAGE_KEY]: JSON.stringify({ done: true }) } });
  assert.equal(returning.result.shown, false);
  assert.equal(returning.q("onboarding").length, 0);
});

test("an unreadable stored value counts as done (no nagging); a missing one does not", () => {
  assert.equal(Onboarding.isDone(memoryStorage({ [Onboarding.STORAGE_KEY]: "garbage{" })), true);
  assert.equal(Onboarding.isDone(memoryStorage()), false);
  assert.equal(Onboarding.isDone({ getItem() { throw new Error("blocked"); } }), false);
});

test("without storage or a language pair it does nothing (and never throws)", () => {
  const dom = createDom();
  assert.equal(Onboarding.init({ document: dom.document, storage: null, pair: {}, languages: {} }).shown, false);
  assert.equal(Onboarding.init({ document: dom.document, storage: memoryStorage(), pair: null, languages: {} }).shown, false);
});

test("a failing save of the level never blocks finishing", () => {
  const t = setup();
  const failing = { get: () => ({}), save: () => { throw new Error("quota"); } };
  const dom = createDom();
  const storage = memoryStorage();
  const lang = t.Lang;
  const pair = lang.create({ storage });
  const done = [];
  Onboarding.init({ document: dom.document, storage, pair, memory: failing, languages: lang, onDone: (r) => done.push(r) });
  dom.byClass(dom.document.body, "onboarding-next")[0].click();
  dom.byClass(dom.document.body, "onboarding-next")[0].click();
  dom.byClass(dom.document.body, "onboarding-next")[0].click();
  assert.equal(done.length, 1);
  assert.equal(Onboarding.isDone(storage), true);
});

test("focus is restored and the dialog is modal (Tab wraps)", () => {
  const dom = createDom();
  const opener = dom.document.createElement("button");
  dom.document.body.appendChild(opener);
  opener.focus();
  const storage = memoryStorage();
  const sandbox = { window: {}, document: dom.document, localStorage: storage };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(WWW("language-pair.js"), sandbox);
  const lang = sandbox.LinguaHubLanguages;
  Onboarding.init({ document: dom.document, storage, pair: lang.create({ storage }), memory: null, languages: lang });
  const buttons = dom.all(dom.document.body).filter((n) => n.tag === "button" && n !== opener);
  const inputs = dom.all(dom.document.body).filter((n) => n.tag === "input");
  const lastButton = buttons[buttons.length - 1];
  lastButton.focus();
  const tab = dom.document.dispatchEvent({ type: "keydown", key: "Tab", shiftKey: false, preventDefault() { this.defaultPrevented = true; } });
  void tab;
  assert.equal(dom.document.activeElement, inputs[0], "Tab from the last control goes to the first");
  dom.byClass(dom.document.body, "onboarding-skip")[0].click();
  assert.equal(dom.document.activeElement, opener);
});

test("the level reaches the AI: ai-json adds it to the Speak, Grammar and Vocabulary prompts only when known", () => {
  const load = (level) => {
    const sandbox = { window: {}, document: createDom().document, console, setTimeout, clearTimeout, AbortController, fetch: async () => ({}) };
    sandbox.window = sandbox;
    if (level !== undefined) sandbox.LinguaHubLearningMemory = { get: () => ({ level }) };
    vm.createContext(sandbox);
    vm.runInContext(WWW("language-pair.js"), sandbox);
    vm.runInContext(WWW("ai-json.js"), sandbox);
    return sandbox.LinguaHubAI.prompts;
  };
  const pair = { from: "uz", to: "en" };
  assert.equal(load().speak(pair, "hi"), "[Practice language: English | Native language: Uzbek]\nhi", "unchanged without a level");
  const p = load("beginner");
  assert.equal(p.speak(pair, "hi"), "[Practice language: English | Native language: Uzbek | Level: beginner]\nhi");
  assert.match(p.grammar(pair, "x"), /Learner level: beginner\n\nText:\nx$/);
  assert.match(p.vocabulary(pair, "food"), /Learner level: beginner\nTopic: food$/);
  assert.equal(load("expert").speak(pair, "hi"), "[Practice language: English | Native language: Uzbek]\nhi", "unknown levels are ignored");
  assert.doesNotMatch(p.translate("auto", "en", "x"), /level/i);
});

test("the learning settings keep the level (and nothing else new), and the server prompts mention it", () => {
  const store = {};
  const sandbox = {
    window: {}, document: { addEventListener() {}, dispatchEvent() {} }, CustomEvent: class {}, localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(WWW("learning-memory.js"), sandbox);
  const mem = sandbox.LinguaHubLearningMemory;
  mem.save({ level: "advanced", secret: "x" });
  assert.equal(mem.get().level, "advanced");
  assert.equal("secret" in mem.get(), false);
  mem.save({ level: "godlike" });
  assert.equal(mem.get().level, null);
  const modes = require("../lib/aiModes.js");
  ["speak", "grammar", "vocabulary"].forEach((id) => assert.match(modes.getModeConfig(id).systemPrompt, /learner level \(beginner, intermediate or advanced\)/, id));
});

test("wiring: the script is loaded before app.js, which starts onboarding with the shared pair; styled with tokens", () => {
  const html = WWW("index.html");
  assert.ok(html.indexOf('<script src="onboarding.js"></script>') > -1);
  assert.ok(html.indexOf('<script src="onboarding.js"></script>') < html.indexOf('<script src="app.js"></script>'));
  assert.match(WWW("app.js"), /LinguaHubOnboarding\.init\(\{ pair: window\.linguahubPair \}\)/);
  assert.match(WWW("styles.css"), /\.onboarding-dot\.is-active\{\s*width: var\(--space-5\);\s*background: var\(--accent\);/);
});
