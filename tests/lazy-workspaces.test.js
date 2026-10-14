"use strict";

// Phase 5, step 5: the mode screens load on first use, and nothing heavy runs at startup.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const { createDom } = require("./helpers/miniDom.js");

const WWW = (f) => fs.readFileSync(path.join(__dirname, "..", "www", f), "utf8");
const tick = (ms) => new Promise((r) => setTimeout(r, ms === undefined ? 10 : ms));

function build() {
  const dom = createDom();
  const toasts = [];
  const sandbox = {
    document: dom.document,
    console, setTimeout, clearTimeout,
    Event: class { constructor(type, init) { this.type = type; this.bubbles = init && init.bubbles; } },
    LinguaHubToast: { show: (o) => toasts.push(o) }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(WWW("workspace.js"), sandbox);

  const container = dom.document.createElement("div");
  const root = dom.document.createElement("div");
  root.hidden = true;
  const titleEl = dom.document.createElement("div");
  titleEl.textContent = "Chat title";
  const modeSelect = dom.document.createElement("select");
  modeSelect.value = "general";
  modeSelect.options = ["general", "translate", "speak", "grammar", "vocabulary"].map((v) => ({ value: v, disabled: false, textContent: v }));
  sandbox.LinguaHubWorkspace.init({ container, root, modeSelect, pair: {}, vocab: null, titleEl, focusComposer() {} });

  const scripts = [];
  const origAppend = dom.document.body.appendChild.bind(dom.document.body);
  dom.document.body.appendChild = (node) => { if (node.tag === "script") scripts.push(node); return origAppend(node); };

  const log = [];
  const factoryFor = (id) => ({ panel }) => {
    const mark = dom.document.createElement("div");
    mark.className = "screen-" + id;
    panel.appendChild(mark);
    log.push(["built", id]);
    return { activate: (options) => log.push(["activate", id, options && options.tab]), deactivate: () => log.push(["deactivate", id]) };
  };
  // what a loaded script does: registers itself
  const run = (script) => { const id = Object.keys({ "ws-translate.js": 1 }).length && ({ "ws-translate.js": "translate", "ws-speak.js": "speak", "ws-grammar.js": "grammar", "ws-vocab.js": "vocabulary" })[script.src]; if (id) sandbox.LinguaHubWorkspace.register(id, factoryFor(id)); script.onload(); };
  const select = (mode) => { modeSelect.value = mode; modeSelect.dispatchEvent(new sandbox.Event("change", { bubbles: true })); };
  return { dom, sandbox, container, root, titleEl, modeSelect, scripts, log, run, select, toasts, loading: () => dom.byClass(root, "workspace-loading")[0] };
}

test("choosing a screen for the first time shows the frame at once and fetches its script; nothing is built yet", () => {
  const t = build();
  t.select("translate");
  assert.equal(t.container.getAttribute("data-workspace"), "translate");
  assert.equal(t.root.hidden, false);
  assert.equal(t.titleEl.textContent, "translate");
  assert.equal(t.scripts.length, 1);
  assert.equal(t.scripts[0].src, "ws-translate.js");
  assert.equal(t.loading().hidden, false);
  assert.equal(t.loading().getAttribute("role"), "status");
  assert.deepEqual(t.log, []);
});

test("when the script arrives the screen is built once, activated, and the loading note goes away", async () => {
  const t = build();
  t.select("translate");
  t.run(t.scripts[0]);
  await tick();
  assert.deepEqual(t.log, [["built", "translate"], ["activate", "translate", undefined]]);
  assert.equal(t.loading().hidden, true);
  assert.ok(t.dom.byClass(t.root, "screen-translate")[0]);
});

test("the second visit does not fetch again, and switching back keeps the screen", async () => {
  const t = build();
  t.select("translate");
  t.run(t.scripts[0]);
  await tick();
  t.select("general");
  t.select("translate");
  await tick();
  assert.equal(t.scripts.length, 1, "one request in total");
  assert.equal(t.log.filter((e) => e[0] === "built").length, 1);
});

test("a script is requested only once even if the mode is chosen again while it is still loading", async () => {
  const t = build();
  t.select("speak");
  t.select("general");
  t.select("speak");
  assert.equal(t.scripts.length, 1);
  t.run(t.scripts[0]);
  await tick();
  assert.equal(t.log.filter((e) => e[0] === "built").length, 1);
});

test("Grammar loads its diff helper first, then the screen", async () => {
  const t = build();
  t.select("grammar");
  assert.deepEqual(t.scripts.map((s) => s.src), ["grammar-diff.js"]);
  t.scripts[0].onload();
  await tick();
  assert.deepEqual(t.scripts.map((s) => s.src), ["grammar-diff.js", "ws-grammar.js"]);
  t.run(t.scripts[1]);
  await tick();
  assert.deepEqual(t.log, [["built", "grammar"], ["activate", "grammar", undefined]]);
});

test("options for the screen (the 'due today' tile opens Review) survive the load", async () => {
  const t = build();
  t.sandbox.LinguaHubWorkspace.open("vocabulary", { tab: "review" });
  assert.deepEqual(t.log, []);
  t.run(t.scripts[0]);
  await tick();
  assert.deepEqual(t.log, [["built", "vocabulary"], ["activate", "vocabulary", "review"]]);
});

test("moving on while a screen loads: it never pops up afterwards, the chat stays", async () => {
  const t = build();
  t.select("speak");
  t.select("general");
  assert.equal(t.container.getAttribute("data-workspace"), null);
  assert.equal(t.root.hidden, true);
  t.run(t.scripts[0]);
  await tick();
  assert.equal(t.container.getAttribute("data-workspace"), null, "still the chat");
  assert.equal(t.root.hidden, true);
  assert.deepEqual(t.log, []);
  assert.equal(t.titleEl.textContent, "Chat title");
});

test("switching to another screen while one loads shows only the latest", async () => {
  const t = build();
  t.select("speak");
  t.select("vocabulary");
  t.run(t.scripts[0]);
  await tick();
  assert.deepEqual(t.log, [], "the speak screen is not built for a mode nobody is on");
  t.run(t.scripts[1]);
  await tick();
  assert.deepEqual(t.log, [["built", "vocabulary"], ["activate", "vocabulary", undefined]]);
  assert.equal(t.container.getAttribute("data-workspace"), "vocabulary");
});

test("a script that cannot be loaded gives a friendly message, returns to the chat, and can be retried", async () => {
  const t = build();
  t.select("translate");
  t.scripts[0].onerror();
  await tick();
  assert.match(t.toasts[0].message, /Couldn't load this screen/);
  assert.equal(t.modeSelect.value, "general");
  assert.equal(t.container.getAttribute("data-workspace"), null);
  assert.equal(t.loading().hidden, true);
  t.select("translate");
  assert.equal(t.scripts.length, 2, "a failed load is requested again");
  t.run(t.scripts[1]);
  await tick();
  assert.deepEqual(t.log, [["built", "translate"], ["activate", "translate", undefined]]);
});

test("a script that loads but registers nothing is treated as a failure", async () => {
  const t = build();
  t.select("speak");
  t.scripts[0].onload(); // loaded, but nobody called register("speak", ...)
  await tick();
  assert.match(t.toasts[0].message, /Couldn't load this screen/);
  assert.equal(t.modeSelect.value, "general");
});

test("a screen whose script was already on the page (tests, older pages) builds immediately, with no fetch", () => {
  const t = build();
  t.sandbox.LinguaHubWorkspace.register("translate", ({ panel }) => { const d = t.dom.document.createElement("div"); panel.appendChild(d); t.log.push(["built", "translate"]); return { activate() { t.log.push(["activate", "translate"]); } }; });
  t.select("translate");
  assert.equal(t.scripts.length, 0);
  assert.deepEqual(t.log, [["built", "translate"], ["activate", "translate"]]);
});

test("modes without a screen (Free chat, Codex...) never load anything", () => {
  const t = build();
  t.select("general");
  assert.equal(t.scripts.length, 0);
});

// ---- startup ----------------------------------------------------------------------------------------------------------------

test("startup page: the four screens and the grammar diff are not in index.html; every lazy file exists and registers its own mode", () => {
  const html = WWW("index.html");
  const src = WWW("workspace.js");
  const lazy = {};
  const block = src.slice(src.indexOf("var LAZY_SCRIPTS = {"), src.indexOf("};", src.indexOf("var LAZY_SCRIPTS = {")));
  block.replace(/(\w+): \[([^\]]+)\]/g, (m, id, list) => { lazy[id] = list.split(",").map((s) => s.trim().replace(/"/g, "")); return m; });
  assert.deepEqual(Object.keys(lazy).sort(), ["grammar", "speak", "translate", "vocabulary"]);
  Object.keys(lazy).forEach((id) => lazy[id].forEach((file) => {
    assert.ok(fs.existsSync(path.join(__dirname, "..", "www", file)), file + " exists");
    assert.equal(html.includes('<script src="' + file + '"></script>'), false, file + " is not loaded at startup");
  }));
  const screens = { translate: "ws-translate.js", speak: "ws-speak.js", grammar: "ws-grammar.js", vocabulary: "ws-vocab.js" };
  Object.keys(screens).forEach((id) => {
    assert.match(WWW(screens[id]), new RegExp('LinguaHubWorkspace\\.register\\("' + id + '"'), screens[id] + " registers " + id);
    assert.ok(lazy[id].includes(screens[id]));
  });
  assert.deepEqual(lazy.grammar, ["grammar-diff.js", "ws-grammar.js"], "dependency first");
});

test("startup page: the screens' code is a real saving (well over 50 KB of script is no longer parsed at launch)", () => {
  const saved = ["ws-translate.js", "ws-speak.js", "ws-grammar.js", "ws-vocab.js", "grammar-diff.js"].reduce((n, f) => n + fs.statSync(path.join(__dirname, "..", "www", f)).size, 0);
  assert.ok(saved > 50 * 1024, "saved " + saved + " bytes");
});

test("startup page: no microphone, no network and no timers are started by the speech modules just by loading them", () => {
  const count = (source, needle) => source.split(needle).length - 1;
  const speechInput = WWW("speech-input.js");
  assert.equal(count(speechInput, "getUserMedia("), 1, "only inside start()");
  assert.ok(speechInput.indexOf("getUserMedia(") > speechInput.indexOf("CloudRecognition.prototype.start"));
  assert.equal(count(WWW("voice.js"), "getUserMedia"), 0);
  assert.equal(count(speechInput, "new MediaRecorder"), 0, "no recorder is created until recording starts");
});

test("startup page: the auto-updater waits until the window has been up for a while and never runs in development", () => {
  const updater = fs.readFileSync(path.join(__dirname, "..", "lib", "updater.js"), "utf8");
  assert.match(updater, /START_DELAY_MS = \d{5,}/);
  assert.match(updater, /if \(!isPackaged\)/);
});
