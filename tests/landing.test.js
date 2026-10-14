"use strict";

// The first screen for new visitors: typing headline, looping demo, one free real
// correction, Start free / Sign in with Google, reduced motion.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { createDom } = require("./helpers/miniDom.js");
const Landing = require("../www/landing.js");
const Diff = require("../www/grammar-diff.js");

const WWW = (f) => fs.readFileSync(path.join(__dirname, "..", "www", f), "utf8");
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 10; i += 1) await tick(); };

function fakeClock() {
  let time = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout(fn, ms) { const id = nextId++; timers.set(id, { fn, at: time + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    pending: () => timers.size,
    advance(ms) {
      const end = time + ms;
      for (;;) {
        let best = null;
        let bestId = null;
        timers.forEach((t, id) => { if (t.at <= end && (!best || t.at < best.at)) { best = t; bestId = id; } });
        if (!best) break;
        time = best.at;
        timers.delete(bestId);
        best.fn();
      }
      time = end;
    }
  };
}

function memoryStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)); }, removeItem: (k) => { map.delete(k); }, map };
}

function fakeAuth(options) {
  const o = options || {};
  const listeners = [];
  const auth = {
    listeners,
    isAvailable: () => o.available !== false,
    getCurrentUser: () => o.user || null,
    onAuthStateChanged(cb) {
      listeners.push(cb);
      if (o.immediate !== false) Promise.resolve().then(() => cb(o.user || null));
      return () => { const i = listeners.indexOf(cb); if (i !== -1) listeners.splice(i, 1); };
    },
    emit(user) { listeners.slice().forEach((cb) => cb(user)); }
  };
  return auth;
}

function setup(options) {
  const o = options || {};
  const dom = createDom();
  const clock = fakeClock();
  const storage = o.storage || memoryStorage();
  const shell = dom.document.createElement("div");
  dom.document.body.appendChild(shell);
  const done = [];
  const calls = [];
  const win = { LinguaHubGrammarDiff: o.noDiff ? undefined : Diff, LINGUAHUB_CONFIG: { apiUrl: (p) => "http://api.test" + p } };
  const respond = o.respond || (async () => ({ ok: true, status: 200, json: async () => ({ result: { language: "en", corrected: "She goes to school on Monday.", edits: [{ original: "go", correction: "goes", explanation: "After she, add -s." }, { original: "in", correction: "on", explanation: "Use on with days." }] } }) }));
  const promise = Landing.init({
    window: win, document: dom.document, storage, auth: o.auth === undefined ? fakeAuth() : o.auth, shell,
    reducedMotion: o.reducedMotion === true, hasExistingData: o.hasExistingData,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    fetch: async (url, init) => { calls.push({ url, init }); return respond(url, init); },
    onDone: (r) => done.push(r)
  });
  const q = (cls) => dom.byClass(dom.document.body, cls);
  return { dom, clock, storage, shell, done, calls, win, promise, q };
}

const shownUp = async (o) => { const t = setup(o); const outcome = await t.promise; return Object.assign(t, { outcome }); };

// ---- when it shows --------------------------------------------------------------------------------------------------

test("a brand-new signed-out visitor sees it, once; the visit is remembered", async () => {
  const t = await shownUp();
  assert.equal(t.outcome.shown, true);
  assert.equal(t.q("landing").length, 1);
  assert.ok(t.storage.getItem(Landing.STORAGE_KEY), "marked as seen the moment it appears");
  const second = await shownUp({ storage: t.storage });
  assert.equal(second.outcome.shown, false);
  assert.equal(second.outcome.reason, "returning");
  assert.equal(second.q("landing").length, 0);
});

test("a signed-in person goes straight to the home, and is never shown it later either", async () => {
  const storage = memoryStorage();
  const t = await shownUp({ storage, auth: fakeAuth({ user: { uid: "u1" } }) });
  assert.deepEqual([t.outcome.shown, t.outcome.reason], [false, "signed-in"]);
  assert.equal(t.q("landing").length, 0);
  const later = await shownUp({ storage });
  assert.equal(later.outcome.shown, false, "signing out later does not bring it back");
});

test("someone who already uses LinguaHub on this device is not treated as new (onboarding done, language chosen, chats saved)", async () => {
  for (const options of [
    { storage: memoryStorage({ "linguahub-ai:onboarding": "{\"done\":true}" }) },
    { storage: memoryStorage({ "linguahub-ai:language-pair": "{\"from\":\"uz\",\"to\":\"en\"}" }) },
    { hasExistingData: () => true }
  ]) {
    const t = await shownUp(options);
    assert.deepEqual([t.outcome.shown, t.outcome.reason], [false, "existing-data"]);
  }
});

test("it waits for the sign-in state before deciding, so a restored session never flashes the welcome screen", async () => {
  const auth = fakeAuth({ immediate: false, user: { uid: "u1" } });
  const t = setup({ auth });
  await settle();
  assert.equal(t.q("landing").length, 0, "nothing yet");
  auth.emit({ uid: "u1" });
  const outcome = await t.promise;
  assert.equal(outcome.shown, false);
  assert.equal(auth.listeners.length, 0, "the one-time listener is gone");
});

test("if the sign-in state never arrives it still decides after 4 seconds; no auth module at all decides at once", async () => {
  const auth = fakeAuth({ immediate: false });
  const t = setup({ auth });
  t.clock.advance(3900);
  await settle();
  assert.equal(t.q("landing").length, 0);
  t.clock.advance(200);
  const outcome = await t.promise;
  assert.equal(outcome.shown, true);
  const none = await shownUp({ auth: null });
  assert.equal(none.outcome.shown, true);
});

test("a private window (storage that throws) still works: it shows, and never crashes", async () => {
  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  const t = await shownUp({ storage: broken });
  assert.equal(t.outcome.shown, true);
});

// ---- what is on it ------------------------------------------------------------------------------------------------------

test("content: logo + name, the headline, the subtitle, the demo, the input, both buttons and three feature cards", async () => {
  const t = await shownUp();
  assert.equal(t.q("landing-brand")[0].textContent, "LinguaHub");
  assert.equal(t.q("landing-sub")[0].textContent, "Write, speak and get corrected instantly by your AI tutor.");
  assert.equal(t.q("landing-headline")[0].tag, "h1");
  assert.match(t.dom.byClass(t.q("landing-headline")[0], "sr-only")[0].textContent, /Learn English, Arabic, Russian or Uzbek/);
  assert.equal(t.q("landing-typed")[0].getAttribute("aria-hidden"), "true", "the typing is decoration for assistive technology");
  const input = t.q("landing-try-input")[0];
  assert.equal(input.getAttribute("placeholder"), "Write any sentence, in any language");
  assert.equal(input.getAttribute("dir"), "auto");
  assert.equal(t.dom.byTag(t.q("landing")[0], "label")[0].getAttribute("for"), "landing-try-input");
  assert.equal(t.q("landing-try-btn")[0].textContent, "Check");
  assert.equal(t.q("landing-start")[0].textContent, "Start free");
  assert.equal(t.q("landing-google")[0].textContent, "Sign in with Google");
  assert.deepEqual(t.q("landing-card-title").map((n) => n.textContent), ["Speak", "Grammar fixes", "Flashcards"]);
  assert.equal(t.q("landing")[0].getAttribute("role"), "region");
});

test("Sign in with Google is left out where sign-in is not configured", async () => {
  const t = await shownUp({ auth: fakeAuth({ available: false }) });
  assert.equal(t.q("landing-google")[0].hidden, true);
  assert.equal(t.q("landing-start")[0].hidden, false);
});

test("the app behind it is switched off (inert, hidden from screen readers) until it is dismissed", async () => {
  const t = await shownUp();
  assert.equal(t.shell.inert, true);
  assert.equal(t.shell.getAttribute("aria-hidden"), "true");
  t.q("landing-start")[0].click();
  assert.equal(t.shell.inert, false);
  assert.equal(t.shell.getAttribute("aria-hidden"), null);
});

// ---- the typing headline -----------------------------------------------------------------------------------------------------

test("typer: types a phrase one character at a time, holds it, deletes it and moves on - Arabic is right-to-left", () => {
  const clock = fakeClock();
  const frames = [];
  const typer = Landing.createTyper({ phrases: Landing.PHRASES, schedule: clock.setTimeout, cancel: clock.clearTimeout, onFrame: (text, phrase) => frames.push([text, phrase.lang, phrase.dir]) });
  typer.start();
  clock.advance(1200);
  assert.ok(frames.length > 5);
  assert.equal(frames[0][0], "", "starts empty");
  assert.equal(frames[1][0], "L");
  assert.equal(frames[2][0], "Le");
  const full = frames.find((f) => f[0] === "Learn English");
  assert.ok(full, "the whole first phrase appears");
  clock.advance(12000);
  const langs = [];
  frames.forEach((f) => { if (langs[langs.length - 1] !== f[1] && f[0]) langs.push(f[1]); });
  assert.deepEqual(langs.slice(0, 4), ["en", "ar", "ru", "uz"], "cycles through the four languages in order");
  const arabic = frames.find((f) => f[1] === "ar" && f[0].length > 3);
  assert.equal(arabic[2], "rtl");
  assert.ok(frames.some((f) => f[1] === "ru" && f[0] === "Изучай русский"));
  assert.ok(frames.some((f) => f[1] === "uz" && f[0] === "O'zbek tilini o'rgan"));
  clock.advance(30000);
  assert.ok(frames.filter((f) => f[0] === "Learn English").length >= 2, "and starts over");
});

test("typer: never splits a letter from its diacritic (Arabic shadda), stops cleanly, and keeps no timers once stopped", () => {
  const clock = fakeClock();
  const frames = [];
  const typer = Landing.createTyper({ phrases: [Landing.PHRASES[1]], schedule: clock.setTimeout, cancel: clock.clearTimeout, onFrame: (text) => frames.push(text) });
  typer.start();
  clock.advance(5000);
  assert.ok(frames.includes("تعلّم العربية"));
  frames.forEach((f) => assert.doesNotMatch(f, /^[ً-ٟ]/, "a frame never starts with a lone mark"));
  typer.stop();
  assert.equal(clock.pending(), 0);
  const count = frames.length;
  clock.advance(10000);
  assert.equal(frames.length, count, "nothing more after stop");
  typer.start();
  typer.start();
  assert.equal(clock.pending(), 1, "starting twice does not double the timers");
});

test("graphemes: whole characters, including emoji and combining marks", () => {
  assert.deepEqual(Landing.graphemes("abc"), ["a", "b", "c"]);
  assert.equal(Landing.graphemes("تعلّم").length, 4);
  assert.equal(Landing.graphemes("a😀b").length, 3);
  assert.deepEqual(Landing.graphemes(""), []);
});

test("the headline's language and direction follow the phrase on screen", async () => {
  const t = await shownUp();
  t.clock.advance(1700);
  const typed = t.q("landing-typed")[0];
  assert.equal(typed.getAttribute("lang"), "en");
  assert.equal(typed.getAttribute("dir"), "ltr");
  t.clock.advance(5000);
  assert.ok(["en", "ar", "ru", "uz"].includes(typed.getAttribute("lang")));
  let sawArabic = false;
  for (let i = 0; i < 400 && !sawArabic; i += 1) {
    t.clock.advance(60);
    if (typed.getAttribute("lang") === "ar" && typed.textContent.length > 2) { sawArabic = true; assert.equal(typed.getAttribute("dir"), "rtl"); }
  }
  assert.ok(sawArabic);
});

// ---- the demo -----------------------------------------------------------------------------------------------------------------

test("demo: the loop runs about every 7 seconds in the order go->goes, in->on, explanation, Uzbek", async () => {
  const t = await shownUp();
  const [first, second] = t.q("demo-fix");
  const note = t.q("demo-note")[0];
  const translation = t.q("demo-translation")[0];
  const state = () => [first, second, note, translation].map((n) => n.classList.contains("is-on"));
  assert.deepEqual(state(), [false, false, false, false]);
  t.clock.advance(950);
  assert.deepEqual(state(), [true, false, false, false], "\"go\" is struck through and \"goes\" appears");
  t.clock.advance(1300);
  assert.deepEqual(state(), [true, true, false, false], "\"in\" -> \"on\"");
  t.clock.advance(1300);
  assert.deepEqual(state(), [true, true, true, false], "the explanation fades in");
  t.clock.advance(1300);
  assert.deepEqual(state(), [true, true, true, true], "then the Uzbek translation");
  t.clock.advance(2300);
  assert.deepEqual(state(), [false, false, false, false], "and it starts over");
  t.clock.advance(950);
  assert.deepEqual(state(), [true, false, false, false], "second lap");
  const total = Landing.DEMO_STEPS.reduce((a, b) => a + b, 0);
  assert.ok(total >= 6500 && total <= 7500, "a lap is about 7 seconds (" + total + " ms)");
});

test("demo: the sentence, the correction words, the explanation and the Uzbek translation are exactly as specified", async () => {
  const t = await shownUp();
  assert.equal(t.q("demo-sentence")[0].textContent.replace(/\s+/g, " ").replace(/goesgo|goes/g, "").length > 0, true);
  const dels = t.q("demo-del").map((n) => n.textContent);
  const inss = t.q("demo-ins").map((n) => n.textContent);
  assert.deepEqual(dels, ["go", "in"]);
  assert.deepEqual(inss, ["goes", "on"]);
  assert.equal(t.q("demo-translation-text")[0].textContent, "U dushanba kuni maktabga boradi.");
  assert.match(t.q("demo-note")[0].textContent, /“she”.*-s.*“on”/);
  const label = t.q("landing-demo")[0].getAttribute("aria-label");
  assert.match(label, /She go to school in Monday\./);
  assert.match(label, /She goes to school on Monday\./);
  assert.match(label, /U dushanba kuni maktabga boradi\./);
  assert.equal(t.q("landing-demo-visual")[0].getAttribute("aria-hidden"), "true", "the animated copy is hidden; the label carries the meaning");
  assert.equal(Landing.DEMO.translation, "U dushanba kuni maktabga boradi.");
});

test("demo loop: stop() cancels the timers; showFinal() jumps to the finished state", () => {
  const clock = fakeClock();
  const steps = [];
  const loop = Landing.createDemoLoop({ schedule: clock.setTimeout, cancel: clock.clearTimeout, apply: (n) => steps.push(n) });
  loop.start();
  loop.start();
  assert.equal(clock.pending(), 1);
  clock.advance(8000);
  assert.deepEqual(steps.slice(0, 6), [0, 1, 2, 3, 4, 0]);
  loop.stop();
  assert.equal(clock.pending(), 0);
  loop.showFinal();
  assert.equal(steps[steps.length - 1], 4);
  assert.equal(loop.step(), 4);
});

// ---- reduced motion -------------------------------------------------------------------------------------------------------------

test("prefers-reduced-motion: no timers, a still headline, and the demo shows its finished state", async () => {
  const t = await shownUp({ reducedMotion: true });
  assert.equal(t.clock.pending(), 0, "nothing is animated");
  assert.equal(t.q("landing-typed")[0].textContent, "Learn English");
  assert.equal(t.q("landing")[0].getAttribute("data-motion"), "reduced");
  [0, 1].forEach((i) => assert.ok(t.q("demo-fix")[i].classList.contains("is-on")));
  assert.ok(t.q("demo-note")[0].classList.contains("is-on"));
  assert.ok(t.q("demo-translation")[0].classList.contains("is-on"));
  t.clock.advance(60000);
  assert.equal(t.q("landing-typed")[0].textContent, "Learn English");
});

test("dismissing it stops every timer (no animation keeps running behind the app)", async () => {
  const t = await shownUp();
  assert.ok(t.clock.pending() > 0);
  t.q("landing-start")[0].click();
  assert.equal(t.clock.pending(), 0);
});

// ---- the free try --------------------------------------------------------------------------------------------------------------------

async function submit(t, text) {
  t.q("landing-try-input")[0].value = text;
  t.dom.byTag(t.q("landing")[0], "form")[0].dispatch("submit");
  await settle();
}

test("try: sends the sentence (no sign-in, no credentials) and shows each mistake struck through with its correction and why", async () => {
  const t = await shownUp();
  await submit(t, "She go to school in Monday.");
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].url, "http://api.test/api/try-correct");
  assert.equal(t.calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(t.calls[0].init.body), { text: "She go to school in Monday." });
  assert.equal(t.calls[0].init.headers.Authorization, undefined);
  assert.equal(t.q("landing-result-title")[0].textContent, "2 corrections");
  assert.deepEqual(t.dom.byClass(t.q("landing-corrected")[0], "landing-del").map((n) => n.textContent), ["go", "in"]);
  assert.deepEqual(t.dom.byClass(t.q("landing-corrected")[0], "landing-ins").map((n) => n.textContent), ["goes", "on"]);
  assert.match(t.q("landing-explain")[0].textContent, /After she, add -s\./);
  assert.match(t.q("landing-explain")[0].textContent, /Use on with days\./);
});

test("try: afterwards a friendly sign-up prompt appears, with Start free and Google, and the button is usable again", async () => {
  const t = await shownUp();
  await submit(t, "She go to school in Monday.");
  assert.match(t.q("landing-signup-title")[0].textContent, /Keep going for free/);
  assert.ok(t.q("landing-signup-start")[0]);
  assert.ok(t.q("landing-signup-google")[0]);
  assert.equal(t.q("landing-try-btn")[0].disabled, false);
  assert.equal(t.q("landing-try-btn")[0].textContent, "Check");
  assert.equal(t.storage.getItem(Landing.TRY_KEY), "1");
  t.q("landing-signup-start")[0].click();
  assert.deepEqual(t.done, [{ reason: "start" }]);
});

test("try: only ONE real correction - the second attempt makes no request and asks them to sign up", async () => {
  const t = await shownUp();
  await submit(t, "She go to school in Monday.");
  await submit(t, "Another sentence here.");
  assert.equal(t.calls.length, 1);
  assert.match(t.q("landing-signup-title")[0].textContent, /used today's free try/);
  assert.equal(t.q("landing-corrected").length, 0, "the old result is cleared");
  assert.equal(t.q("landing-signup").length, 1, "one prompt, not stacked");
});

test("try: the free try is remembered across visits (the landing never shows twice, but the flag is also respected)", async () => {
  const t = await shownUp({ storage: memoryStorage({ [Landing.TRY_KEY]: "1" }) });
  await submit(t, "Any sentence");
  assert.equal(t.calls.length, 0);
  assert.match(t.q("landing-signup-title")[0].textContent, /used today's free try/);
});

test("try: when the server says the daily limit for this IP is reached (429) the try counts as used and the sign-up prompt shows", async () => {
  const t = await shownUp({ respond: async () => ({ ok: false, status: 429, json: async () => ({}) }) });
  await submit(t, "Hello world");
  assert.match(t.q("landing-signup-title")[0].textContent, /used today's free try/);
  assert.equal(t.storage.getItem(Landing.TRY_KEY), "1");
});

test("try: errors (server problem, offline, unreadable answer) are friendly, show no codes, and do NOT use up the free try", async () => {
  const cases = [
    async () => ({ ok: false, status: 502, json: async () => ({}) }),
    async () => { throw new TypeError("Failed to fetch"); },
    async () => ({ ok: true, status: 200, json: async () => ({ unexpected: true }) }),
    async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } })
  ];
  for (const respond of cases) {
    const t = await shownUp({ respond });
    await submit(t, "Hello world");
    assert.match(t.q("landing-error")[0].textContent, /Couldn't check that right now/);
    assert.doesNotMatch(t.q("landing-error")[0].textContent, /\b(502|TypeError|fetch)\b/);
    assert.equal(t.storage.getItem(Landing.TRY_KEY), null, "can try again");
    assert.equal(t.q("landing-try-btn")[0].disabled, false);
  }
  const bad = await shownUp({ respond: async () => ({ ok: false, status: 400, json: async () => ({}) }) });
  await submit(bad, "x");
  assert.match(bad.q("landing-error")[0].textContent, /up to 300 characters/);
});

test("try: an empty box does nothing; two quick submits send one request; no mistakes is celebrated", async () => {
  const t = await shownUp({ respond: async () => { await new Promise((r) => setImmediate(r)); return { ok: true, status: 200, json: async () => ({ result: { language: "en", corrected: "All good.", edits: [] } }) }; } });
  await submit(t, "   ");
  assert.equal(t.calls.length, 0);
  assert.equal(t.dom.document.activeElement, t.q("landing-try-input")[0]);
  const input = t.q("landing-try-input")[0];
  input.value = "All good.";
  const form = t.dom.byTag(t.q("landing")[0], "form")[0];
  form.dispatch("submit");
  form.dispatch("submit");
  await settle();
  assert.equal(t.calls.length, 1);
  assert.match(t.q("landing-result-title")[0].textContent, /No mistakes found/);
});

test("try: text from the server is shown as text only", async () => {
  const t = await shownUp({ respond: async () => ({ ok: true, status: 200, json: async () => ({ result: { language: "en", corrected: "x", edits: [{ original: "go", correction: "<img src=x onerror=1>", explanation: "<script>1</script>" }] } }) }) });
  await submit(t, "I go home");
  assert.equal(t.dom.byTag(t.q("landing")[0], "img").length, 0);
  assert.equal(t.dom.byTag(t.q("landing")[0], "script").length, 0);
  assert.equal(t.dom.byClass(t.q("landing-corrected")[0], "landing-ins")[0].textContent, "<img src=x onerror=1>");
});

test("try: the correction helper is loaded on demand when the page does not have it yet", async () => {
  const t = await shownUp({ noDiff: true });
  t.q("landing-try-input")[0].value = "She go home";
  t.dom.byTag(t.q("landing")[0], "form")[0].dispatch("submit");
  await settle();
  const script = t.dom.all(t.dom.document.body).find((n) => n.tag === "script");
  assert.ok(script, "a script element was added");
  assert.equal(script.src, "grammar-diff.js");
  t.win.LinguaHubGrammarDiff = Diff;
  script.onload();
  await settle();
  assert.equal(t.q("landing-result-title")[0].textContent, "2 corrections");
});

// ---- the two buttons ---------------------------------------------------------------------------------------------------------------------

test("Start free closes the screen and hands over to onboarding; Sign in with Google hands over to the normal sign-in", async () => {
  const a = await shownUp();
  a.q("landing-start")[0].click();
  assert.deepEqual(a.done, [{ reason: "start" }]);
  assert.equal(a.q("landing").length, 0);
  const b = await shownUp();
  b.q("landing-google")[0].click();
  assert.deepEqual(b.done, [{ reason: "google" }]);
  assert.equal(b.q("landing").length, 0);
});

test("a second click or a late sign-in cannot close it twice", async () => {
  const t = await shownUp();
  t.q("landing-start")[0].click();
  t.q("landing-start")[0] && t.q("landing-start")[0].click();
  assert.equal(t.done.length, 1);
});

test("if the person signs in while it is open (popup finished, session restored) it steps aside by itself", async () => {
  const auth = fakeAuth();
  const t = await shownUp({ auth });
  auth.emit({ uid: "u1" });
  assert.deepEqual(t.done, [{ reason: "signed-in" }]);
  assert.equal(t.q("landing").length, 0);
  assert.equal(auth.listeners.length, 0, "the listener is removed");
});

// ---- wiring --------------------------------------------------------------------------------------------------------------------------------

test("app.js: starts the welcome screen before onboarding, onboarding follows 'Start free' (or immediately for everyone else)", () => {
  const app = WWW("app.js");
  assert.doesNotMatch(app, /localStorage\./, "app.js never touches storage directly");
  assert.match(app, /function startOnboarding\(\) \{/);
  assert.match(app, /window\.LinguaHubLanding\.init\(\{[\s\S]*shell: document\.getElementById\("app-shell"\)/);
  assert.match(app, /if \(reason === "google" && loginBtn && !loginBtn\.hidden\) loginBtn\.click\(\);/);
  assert.match(app, /if \(reason !== "signed-in"\) startOnboarding\(\);/);
  assert.match(app, /\.then\(\(outcome\) => \{\s*if \(!outcome\.shown\) startOnboarding\(\);/);
  assert.match(app, /hasExistingData: \(\) => historyUI\.store\.listGuestConversations\(\)\.length > 0/);
  const html = WWW("index.html");
  const at = (n) => html.indexOf('<script src="' + n + '"></script>');
  assert.ok(at("landing.js") > -1 && at("landing.js") < at("app.js"));
});

test("styling: Fraunces headline, theme tokens only, 375 px mobile layout, reduced motion", () => {
  const css = WWW("styles.css");
  assert.match(css, /\.landing-headline\{[^}]*font-family: var\(--font-family-heading\);/);
  assert.match(css, /\.landing-typed::after\{[^}]*background: var\(--accent\);/, "the cursor is typed::after, so it follows right-to-left text");
  assert.match(css, /\.demo-fix\.is-on \.demo-del\{\s*color: var\(--danger-text\);/);
  assert.match(css, /\.demo-ins\{[^}]*color: var\(--success-text\);/);
  assert.match(css, /@media \(max-width: 720px\)\{\s*\.landing-features\{\s*grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(css, /\.landing\{\s*position: fixed;\s*inset: var\(--titlebar-height\) 0 0 0;/);
  const reduced = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce){"));
  assert.match(reduced, /\.demo-ins,[\s\S]*transition: none !important;/);
  assert.match(reduced, /\.landing-typed::after\{\s*animation: none !important;/);
  const section = css.slice(css.indexOf("/* First screen for new visitors"));
  assert.doesNotMatch(section, /#[0-9a-fA-F]{3,8}\b/, "no hard-coded colours");
  assert.doesNotMatch(section, /font-size:\s*[0-9.]+(px|rem)/, "no hard-coded font sizes");
});
