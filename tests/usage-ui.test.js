"use strict";

// The daily free limit as the person sees it: counter, badge, paywall, Get Premium,
// "Remind me tomorrow", and the "Sign in to continue" dialog.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { createDom } = require("./helpers/miniDom.js");
const Usage = require("../www/usage.js");
const { isSafeExternalUrl } = require("../lib/electronSecurity.js");

const WWW = (f) => fs.readFileSync(path.join(__dirname, "..", "www", f), "utf8");
const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r)); };

function memoryStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)); }, removeItem: (k) => { map.delete(k); }, map };
}

function headersOf(obj) {
  const lower = {};
  Object.keys(obj).forEach((k) => { lower[k.toLowerCase()] = obj[k]; });
  return { get: (name) => (name.toLowerCase() in lower ? lower[name.toLowerCase()] : null) };
}

const FUTURE = "2099-01-01T00:00:00.000Z";

function setup(overrides) {
  const o = overrides || {};
  const dom = createDom();
  const doc = dom.document;
  const counterEl = doc.createElement("div");
  counterEl.hidden = true;
  const badge = doc.createElement("span");
  badge.hidden = true;
  const row = doc.createElement("div");
  row.hidden = true;
  const until = doc.createElement("span");
  [counterEl, badge, row, until].forEach((n) => doc.body.appendChild(n));
  const notes = [];
  const fetches = [];
  const state = { signedIn: o.signedIn !== false, available: o.available !== false, clock: o.clock || Date.parse("2026-03-10T10:00:00Z"), signedInCalls: 0 };
  const storage = o.storage || memoryStorage();
  const timers = [];
  const usage = Usage.create({
    document: doc, counterEl, premiumEls: { badge, row, until }, storage,
    apiUrl: (p) => "http://api.test" + p,
    getAuthHeaders: async () => (state.signedIn ? { Authorization: "Bearer tok" } : {}),
    fetch: async (url, init) => { fetches.push({ url, init }); return o.respond ? o.respond(url, init) : { ok: true, json: async () => ({ plan: "free", premium: false, limit: 10, used: 3, remaining: 7, resetAt: "2026-03-10T19:00:00.000Z", priceLabel: "Coming soon", contactUrl: "https://t.me/linguahub_support" }) }; },
    isSignedIn: () => state.signedIn,
    isSignInAvailable: () => state.available,
    signIn: () => { state.signInCalled = (state.signInCalled || 0) + 1; },
    notify: (message, type) => notes.push([message, type]),
    now: () => state.clock,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {}
  });
  const q = (cls) => dom.byClass(doc.body, cls);
  return { dom, doc, usage, counterEl, badge, row, until, notes, fetches, state, storage, timers, q };
}

// ---- the counter ----------------------------------------------------------------------------------------------------

test("counter: shows 'remaining / limit free today' for a free user, with a plain-language label", () => {
  const t = setup();
  assert.equal(t.counterEl.hidden, true, "nothing is shown until the numbers are known");
  t.usage.fromQuota({ plan: "free", premium: false, limit: 10, remaining: 7, resetAt: "2026-03-10T19:00:00.000Z" });
  assert.equal(t.counterEl.hidden, false);
  assert.equal(t.counterEl.textContent, "7 / 10 free today");
  assert.equal(t.counterEl.getAttribute("aria-label"), "7 of 10 free requests left today");
});

test("counter: turns to the warning colour at 2 or fewer left (and not before)", () => {
  const t = setup();
  const show = (remaining) => { t.usage.fromQuota({ plan: "free", premium: false, limit: 10, remaining }); return t.counterEl.classList.contains("is-warning"); };
  assert.equal(show(10), false);
  assert.equal(show(4), false);
  assert.equal(show(3), false);
  assert.equal(show(2), true);
  assert.equal(show(1), true);
  assert.equal(show(0), true);
  assert.equal(t.counterEl.classList.contains("is-empty"), true);
  assert.equal(show(5), false, "and back, e.g. after the day renews");
  assert.equal(t.counterEl.classList.contains("is-empty"), false);
});

test("counter: hidden for Premium (with the Premium badge instead) and when signed out", async () => {
  const t = setup();
  t.usage.fromQuota({ plan: "free", premium: false, limit: 10, remaining: 7 });
  t.usage.fromQuota({ plan: "premium", premium: true, limit: null, remaining: null });
  assert.equal(t.counterEl.hidden, true);
  assert.equal(t.badge.hidden, false);
  assert.equal(t.row.hidden, false);
  t.usage.fromQuota({ plan: "free", premium: false, limit: 10, remaining: 4 });
  assert.equal(t.badge.hidden, true, "no badge for free users");
  assert.equal(t.counterEl.hidden, false);
  t.usage.setUser(null);
  assert.equal(t.counterEl.hidden, true, "signing out hides it");
  assert.equal(t.usage.state().plan, null);
});

test("counter: follows the X-Usage-* headers of every reply; unlimited means premium; junk headers change nothing", () => {
  const t = setup();
  t.usage.fromHeaders(headersOf({ "X-Usage-Plan": "free", "X-Usage-Limit": "10", "X-Usage-Remaining": "6", "X-Usage-Reset": "2026-03-10T19:00:00.000Z" }));
  assert.equal(t.counterEl.textContent, "6 / 10 free today");
  assert.equal(t.usage.state().resetAt, "2026-03-10T19:00:00.000Z");
  t.usage.fromHeaders(headersOf({ "X-Usage-Plan": "free", "X-Usage-Limit": "10", "X-Usage-Remaining": "5" }));
  assert.equal(t.counterEl.textContent, "5 / 10 free today");
  t.usage.fromHeaders(headersOf({ "X-Usage-Plan": "premium", "X-Usage-Limit": "unlimited", "X-Usage-Remaining": "unlimited" }));
  assert.equal(t.counterEl.hidden, true);
  assert.equal(t.usage.state().premium, true);
  const before = t.usage.state();
  t.usage.fromHeaders(headersOf({}));
  t.usage.fromHeaders(headersOf({ "X-Usage-Plan": "hacker" }));
  t.usage.fromHeaders(null);
  t.usage.fromHeaders({});
  t.usage.fromQuota(null);
  t.usage.fromQuota("string");
  assert.deepEqual(t.usage.state(), before);
  const free = setup();
  free.usage.fromHeaders(headersOf({ "X-Usage-Plan": "free", "X-Usage-Limit": "10", "X-Usage-Remaining": "-4" }));
  assert.equal(free.counterEl.hidden, true, "a nonsense number is ignored");
});

test("refresh(): reads /api/usage with the user's token and shows plan and numbers; setUser does it on sign-in", async () => {
  const t = setup();
  t.usage.setUser({ uid: "u1" });
  await settle();
  assert.equal(t.fetches.length, 1);
  assert.equal(t.fetches[0].url, "http://api.test/api/usage");
  assert.equal(t.fetches[0].init.headers.Authorization, "Bearer tok");
  assert.equal(t.counterEl.textContent, "7 / 10 free today");
  assert.equal(t.usage.state().priceLabel, "Coming soon");
  assert.equal(t.usage.state().contactUrl, "https://t.me/linguahub_support");
});

test("refresh(): premium shows the badge with the end date; a failing request or a signed-out user changes nothing and never throws", async () => {
  const vip = setup({ respond: async () => ({ ok: true, json: async () => ({ plan: "premium", premium: true, premiumUntil: FUTURE, limit: null, remaining: null, resetAt: "2026-03-10T19:00:00.000Z" }) }) });
  await vip.usage.refresh();
  assert.equal(vip.badge.hidden, false);
  assert.match(vip.until.textContent, /^until /);
  assert.equal(vip.counterEl.hidden, true);

  for (const respond of [async () => ({ ok: false, status: 503 }), async () => { throw new Error("offline"); }, async () => ({ ok: true, json: async () => { throw new Error("bad json"); } })]) {
    const t = setup({ respond });
    assert.equal(await t.usage.refresh(), null);
    assert.equal(t.counterEl.hidden, true);
  }
  const out = setup({ signedIn: false });
  assert.equal(await out.usage.refresh(), null);
  assert.equal(out.fetches.length, 0, "no request without a sign-in");
});

test("the contact link must be https: anything else (javascript:, http:, junk) is dropped", () => {
  const t = setup();
  for (const bad of ["javascript:alert(1)", "http://t.me/x", "data:text/html,x", "t.me/x", "", null, 5]) {
    t.usage.fromQuota({ plan: "free", premium: false, limit: 10, remaining: 1, contactUrl: bad });
    assert.equal(t.usage.state().contactUrl, null, String(bad));
  }
  t.usage.fromQuota({ plan: "free", premium: false, limit: 10, remaining: 1, contactUrl: "https://t.me/ok" });
  assert.equal(t.usage.state().contactUrl, "https://t.me/ok");
});

// ---- when it renews ---------------------------------------------------------------------------------------------------

test("renewText: says 00:00, with the person's own clock when it differs from Tashkent", () => {
  assert.equal(Usage.renewText("x", () => "00:00"), "Free requests renew at 00:00.");
  assert.equal(Usage.renewText("x", () => "02:00"), "Free requests renew at 00:00 Tashkent time (02:00 your time).");
  assert.equal(Usage.renewText("x", () => ""), "Free requests renew at 00:00 (Tashkent time).");
  assert.equal(Usage.renewText("x"), "Free requests renew at 00:00 (Tashkent time).");
});

// ---- the paywall ----------------------------------------------------------------------------------------------------------

test("hitting the limit opens the paywall - not a raw error - comparing Free and Premium, with the price and the renew time", () => {
  const t = setup();
  t.usage.handleLimit({ code: "DAILY_LIMIT_REACHED", remaining: 0, limit: 10, resetAt: "2026-03-10T19:00:00.000Z", priceLabel: "$4.99 / month", contactUrl: "https://t.me/linguahub_support" });
  const dialog = t.q("paywall")[0];
  assert.ok(dialog);
  assert.equal(dialog.getAttribute("role"), "dialog");
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  assert.equal(t.dom.byTag(dialog, "h2")[0].textContent, "You've used today's free requests");
  assert.match(t.q("paywall-renew")[0].textContent, /^Free requests renew at 00:00/);
  const columns = t.q("plan-column");
  assert.equal(columns.length, 2);
  const free = t.dom.byTag(columns[0], "li").map((n) => n.textContent);
  const premium = t.dom.byTag(columns[1], "li").map((n) => n.textContent);
  assert.deepEqual(free, ["10 AI requests per day", "All learning modes", "Flashcards"]);
  assert.deepEqual(premium, ["Unlimited requests", "Unlimited Speak practice", "Image lessons", "Priority speed"]);
  assert.equal(t.q("plan-price")[0].textContent, "$4.99 / month");
  assert.match(t.q("paywall-note")[0].textContent, /Flashcards and your vocabulary keep working/);
  assert.equal(t.counterEl.textContent, "0 / 10 free today");
  assert.ok(t.counterEl.classList.contains("is-warning"));
});

test("the paywall uses the server's price text, with 'Coming soon' as the default", () => {
  const t = setup();
  t.usage.handleLimit({ limit: 10, resetAt: "2026-03-10T19:00:00.000Z" });
  assert.equal(t.q("plan-price")[0].textContent, "Coming soon");
});

test("Maybe later and Esc close the paywall and return focus to where the person was", () => {
  const t = setup();
  const composer = t.doc.createElement("textarea");
  t.doc.body.appendChild(composer);
  composer.focus();
  t.usage.handleLimit({ limit: 10 });
  assert.notEqual(t.doc.activeElement, composer, "focus moved into the dialog");
  t.doc.dispatchEvent({ type: "keydown", key: "Escape", preventDefault() {} });
  assert.equal(t.q("paywall").length, 0);
  assert.equal(t.doc.activeElement, composer);
  t.usage.handleLimit({ limit: 10 });
  t.dom.byClass(t.doc.body, "lh-btn").find((b) => b.textContent === "Maybe later").click();
  assert.equal(t.q("paywall").length, 0);
});

test("only one dialog at a time: Get Premium replaces the paywall; a second limit hit does not stack", () => {
  const t = setup();
  t.usage.handleLimit({ limit: 10 });
  t.usage.handleLimit({ limit: 10 });
  assert.equal(t.q("usage-dialog").length, 1);
  t.q("paywall-get")[0].click();
  assert.equal(t.q("paywall").length, 0);
  assert.equal(t.q("get-premium").length, 1);
});

// ---- Get Premium ------------------------------------------------------------------------------------------------------------------

test("Get Premium: shows the price, a safe contact link, 'Remind me tomorrow' and Close", () => {
  const t = setup();
  t.usage.fromQuota({ plan: "free", premium: false, limit: 10, remaining: 0, priceLabel: "Coming soon", contactUrl: "https://t.me/linguahub_support" });
  t.usage.showGetPremium();
  assert.equal(t.dom.byTag(t.q("get-premium")[0], "h2")[0].textContent, "Get Premium");
  assert.equal(t.q("get-premium-price")[0].textContent, "Price: Coming soon");
  const link = t.q("get-premium-contact")[0];
  assert.equal(link.tag, "a");
  assert.equal(link.getAttribute("href"), "https://t.me/linguahub_support");
  assert.equal(link.getAttribute("target"), "_blank");
  assert.equal(link.getAttribute("rel"), "noopener noreferrer");
  assert.ok(t.q("get-premium-remind")[0]);
  assert.ok(t.dom.byClass(t.doc.body, "lh-btn").some((b) => b.textContent === "Close"));
});

test("Get Premium: without a configured link it says so instead of a dead button", () => {
  const t = setup();
  t.usage.fromQuota({ plan: "free", premium: false, limit: 10, remaining: 0 });
  t.usage.showGetPremium();
  assert.equal(t.q("get-premium-contact").length, 0);
  assert.match(t.q("get-premium")[0].textContent, /contact link isn't set up yet/);
});

test("'Remind me tomorrow' remembers the moment the free requests renew, confirms, and closes", () => {
  const t = setup();
  t.usage.fromQuota({ plan: "free", premium: false, limit: 10, remaining: 0, resetAt: "2026-03-10T19:00:00.000Z" });
  t.usage.showGetPremium();
  t.q("get-premium-remind")[0].click();
  assert.equal(Number(t.storage.getItem(Usage.REMINDER_KEY)), Date.parse("2026-03-10T19:00:00.000Z"));
  assert.match(t.notes[0][0], /remind you/);
  assert.equal(t.q("get-premium").length, 0);
  assert.equal(t.timers.length, 1, "and a timer waits for that moment while the app stays open");
});

test("'Remind me tomorrow' without a known reset time reminds in a day", () => {
  const t = setup();
  t.usage.showGetPremium();
  t.q("get-premium-remind")[0].click();
  assert.equal(Number(t.storage.getItem(Usage.REMINDER_KEY)), t.state.clock + 24 * 3600 * 1000);
});

test("the reminder fires once when the time has come (at launch or by its timer), says the requests are back and refreshes the counter", async () => {
  const t = setup({ storage: memoryStorage({ [Usage.REMINDER_KEY]: String(Date.parse("2026-03-10T19:00:00Z")) }) });
  assert.equal(t.usage.checkReminder(), false, "too early");
  assert.equal(t.notes.length, 0);
  t.usage.scheduleReminder();
  assert.ok(t.timers.length >= 1, "a timer waits for that moment (checking early re-arms it)");
  t.state.clock = Date.parse("2026-03-10T19:00:01Z");
  t.timers[t.timers.length - 1].fn();
  await settle();
  assert.match(t.notes[0][0], /Your free requests are back/);
  assert.equal(t.storage.getItem(Usage.REMINDER_KEY), null, "only once");
  assert.equal(t.usage.checkReminder(), false);
  assert.equal(t.fetches.length, 1, "the counter is refreshed");
  const late = setup({ clock: Date.parse("2026-03-12T00:00:00Z"), storage: memoryStorage({ [Usage.REMINDER_KEY]: String(Date.parse("2026-03-10T19:00:00Z")) }) });
  assert.equal(late.usage.checkReminder(), true, "a reminder that came due while the app was closed shows at the next launch");
});

test("reminder: broken or blocked storage never throws", () => {
  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  const t = setup({ storage: broken });
  assert.doesNotThrow(() => { t.usage.showGetPremium(); t.q("get-premium-remind")[0].click(); t.usage.checkReminder(); t.usage.scheduleReminder(); });
  const junk = setup({ storage: memoryStorage({ [Usage.REMINDER_KEY]: "not a number" }) });
  assert.equal(junk.usage.checkReminder(), false);
});

// ---- signed out ---------------------------------------------------------------------------------------------------------------------

test("signed out: any AI feature shows the friendly 'Sign in to continue' dialog instead of failing", () => {
  const t = setup({ signedIn: false });
  assert.equal(t.usage.canUseAi(), false);
  const dialog = t.q("signin-required")[0];
  assert.ok(dialog);
  assert.equal(t.dom.byTag(dialog, "h2")[0].textContent, "Sign in to continue");
  assert.match(dialog.textContent, /It's free/);
  assert.ok(t.q("signin-go")[0]);
  t.q("signin-go")[0].click();
  assert.equal(t.state.signInCalled, 1, "continues into the normal Google sign-in");
  assert.equal(t.q("signin-required").length, 0);
});

test("signed in: nothing interrupts; and 'Not now' just closes the sign-in dialog", () => {
  const t = setup();
  assert.equal(t.usage.canUseAi(), true);
  assert.equal(t.q("usage-dialog").length, 0);
  const out = setup({ signedIn: false });
  out.usage.canUseAi();
  out.dom.byClass(out.doc.body, "lh-btn").find((b) => b.textContent === "Not now").click();
  assert.equal(out.q("usage-dialog").length, 0);
  assert.equal(out.state.signInCalled, undefined);
});

test("where signing in is not possible the dialog is honest about it and offers no dead button", () => {
  const t = setup({ signedIn: false, available: false });
  t.usage.canUseAi();
  assert.equal(t.q("signin-go").length, 0);
  assert.match(t.q("signin-required")[0].textContent, /isn't available in this version/);
});

test("dialogs are modal: Tab stays inside them", () => {
  const t = setup();
  t.usage.handleLimit({ limit: 10 });
  const buttons = t.dom.byTag(t.q("paywall")[0], "button");
  buttons[buttons.length - 1].focus();
  const ev = t.doc.dispatchEvent({ type: "keydown", key: "Tab", shiftKey: false, preventDefault() { this.defaultPrevented = true; } });
  void ev;
  assert.equal(t.doc.activeElement, buttons[0], "wraps to the first control");
});

// ---- the page's AI client reports to it ----------------------------------------------------------------------------------------------

function loadAi(usage, fetchImpl) {
  const dom = createDom();
  const sandbox = { window: {}, document: dom.document, console, setTimeout, clearTimeout, AbortController, navigator: { onLine: true }, LINGUAHUB_CONFIG: { apiUrl: (p) => p }, fetch: fetchImpl };
  sandbox.window = sandbox;
  if (usage) sandbox.linguahubUsage = usage;
  vm.createContext(sandbox);
  vm.runInContext(WWW("language-pair.js"), sandbox);
  vm.runInContext(WWW("ai-json.js"), sandbox);
  return sandbox.LinguaHubAI;
}

test("ai-json: signed out -> the sign-in dialog and a friendly error, and NO request is sent", async () => {
  let sent = 0;
  const usage = { canUseAi: () => false, fromHeaders() {}, fromQuota() {}, handleLimit() {}, limitMessage: () => "x" };
  const AI = loadAi(usage, async () => { sent += 1; return { ok: true, json: async () => ({ reply: "{}" }) }; });
  await assert.rejects(AI.request({ mode: "translate", messages: [{ role: "user", content: "x" }] }), (err) => err.code === "SIGN_IN_REQUIRED" && /Sign in to continue/.test(err.userMessage));
  assert.equal(sent, 0);
});

test("ai-json: the numbers of every reply (headers and quota) go to the counter", async () => {
  const seen = [];
  const usage = { canUseAi: () => true, fromHeaders: (h) => seen.push(["headers", h.marker]), fromQuota: (q) => seen.push(["quota", q.remaining]), handleLimit() {}, limitMessage: () => "x" };
  const AI = loadAi(usage, async () => ({ ok: true, status: 200, headers: { marker: "h1", get: () => null }, json: async () => ({ reply: "{\"detected\":\"en\",\"translation\":\"x\"}", quota: { remaining: 4 } }) }));
  await AI.request({ mode: "translate", messages: [{ role: "user", content: "x" }] });
  assert.deepEqual(seen, [["headers", "h1"], ["quota", 4]]);
});

test("ai-json: the daily limit (429 DAILY_LIMIT_REACHED) opens the paywall and becomes a clear message, never 'too quickly'", async () => {
  const handled = [];
  const usage = { canUseAi: () => true, fromHeaders() {}, fromQuota() {}, handleLimit: (b) => handled.push(b), limitMessage: () => "You've used all your free requests for today. Free requests renew at 00:00." };
  const AI = loadAi(usage, async () => ({ ok: false, status: 429, headers: { get: () => null }, json: async () => ({ code: "DAILY_LIMIT_REACHED", remaining: 0, limit: 10 }) }));
  await assert.rejects(AI.request({ mode: "grammar", messages: [{ role: "user", content: "x" }] }), (err) => err.code === "DAILY_LIMIT_REACHED" && err.status === 429 && /free requests for today/.test(err.userMessage) && !/too quickly/.test(err.userMessage));
  assert.equal(handled.length, 1);
  assert.equal(handled[0].limit, 10);
});

test("ai-json: an ordinary 429 (sending too fast) keeps its own message and does not open the paywall", async () => {
  const handled = [];
  const usage = { canUseAi: () => true, fromHeaders() {}, fromQuota() {}, handleLimit: (b) => handled.push(b), limitMessage: () => "x" };
  const AI = loadAi(usage, async () => ({ ok: false, status: 429, headers: { get: () => null }, json: async () => ({ reply: "❌ Too many requests." }) }));
  await assert.rejects(AI.request({ mode: "grammar", messages: [{ role: "user", content: "x" }] }), (err) => /too quickly/.test(err.userMessage) && err.code === undefined);
  assert.equal(handled.length, 0);
});

test("ai-json: without the usage module (tests, older pages) it behaves exactly as before", async () => {
  const AI = loadAi(null, async () => ({ ok: true, status: 200, json: async () => ({ reply: "{\"detected\":\"en\",\"translation\":\"x\"}" }) }));
  const result = await AI.request({ mode: "translate", messages: [{ role: "user", content: "x" }] });
  assert.equal(result.text.length > 0, true);
});

test("speech: recording needs a sign-in - signed out the microphone is never opened", async () => {
  const SI = require("../www/speech-input.js");
  let micRequests = 0;
  const events = [];
  const Recognition = SI.createCloudRecognition({
    mediaDevices: { getUserMedia: () => { micRequests += 1; return Promise.resolve({ getTracks: () => [] }); } },
    MediaRecorder: class { static isTypeSupported() { return true; } },
    fetch: async () => ({ ok: true, json: async () => ({ text: "x" }) }), apiUrl: (p) => p, canStart: () => false
  });
  const rec = new Recognition();
  rec.onerror = (e) => events.push(["error", e.error]);
  rec.onend = () => events.push(["end"]);
  rec.start();
  await settle();
  assert.deepEqual(events, [["error", "sign-in-required"], ["end"]]);
  assert.equal(micRequests, 0);
  assert.match(WWW("ws-speak.js"), /"sign-in-required": "Sign in to practise speaking/);
  assert.match(WWW("voice.js"), /case "sign-in-required":/);
});

// ---- the composer stays usable; wiring ------------------------------------------------------------------------------------------------

test("the limit never disables the composer or any non-AI feature: the dialog only appears when something AI is attempted", () => {
  const source = WWW("usage.js").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.doesNotMatch(source, /user-input|send-btn|\.disabled\s*=|attach-btn/, "usage.js never touches the composer");
  ["vocab-store.js", "home-ui.js", "word-of-day.js", "learning-stats.js"].forEach((f) => assert.doesNotMatch(WWW(f), /canUseAi|linguahubUsage/, f + " (flashcards, vocabulary, the home) is never gated"));
  const wsVocab = WWW("ws-vocab.js");
  const reviewPart = wsVocab.slice(wsVocab.indexOf("// ---- Review tab"));
  assert.doesNotMatch(reviewPart, /AI\.request/, "flashcard review makes no AI request");
});

test("app.js: sending and Retry need a sign-in; the 429 body opens the paywall; the chat error says why; numbers come from headers, the final event and the fallback", () => {
  const app = WWW("app.js");
  assert.doesNotMatch(app, /localStorage\./, "app.js never touches storage directly");
  assert.match(app, /if \(usage && !usage\.canUseAi\(\)\) return;/);
  assert.equal((app.match(/if \(usage && !usage\.canUseAi\(\)\) return;/g) || []).length, 2, "sendMessage and Retry/Regenerate");
  assert.match(app, /httpError\.code = "DAILY_LIMIT_REACHED";\s*if \(usage\) usage\.handleLimit\(limitBody\);/);
  assert.match(app, /if \(parsed\.type === "done" && usage\) usage\.fromQuota\(parsed\.quota\);/);
  assert.match(app, /fallbackError\.code = "DAILY_LIMIT_REACHED";/);
  assert.match(app, /if \(err && err\.code === "DAILY_LIMIT_REACHED"\) \{/);
  assert.match(app, /if \(usage\) usage\.setUser\(user\);/);
  assert.match(app, /window\.linguahubUsage = usage;\s*(\/\/[^\n]*\n)?if \(usage\) usage\.checkReminder\(\);/, "a due reminder is shown at launch");
  assert.match(app, /window\.linguahubUsage = usage;/);
  assert.match(app, /signIn: \(\) => \{ if \(!loginBtn\.hidden\) loginBtn\.click\(\); \}/, "the dialog's button is the normal sign-in");
});

test("index.html and styles: the counter, the Premium badge in the account menu, the script, tokens only", () => {
  const html = WWW("index.html");
  assert.match(html, /<div id="usage-counter" class="usage-counter" role="status" aria-live="polite" hidden><\/div>/);
  assert.match(html, /<span id="premium-badge" class="premium-badge" hidden>Premium<\/span>/);
  assert.match(html, /<div class="account-menu-plan" id="account-plan" hidden>/);
  assert.ok(html.indexOf("id=\"account-plan\"") > html.indexOf("id=\"account-menu-list\""), "the plan row is inside the account menu");
  assert.ok(html.indexOf('<script src="usage.js"></script>') > -1 && html.indexOf('<script src="usage.js"></script>') < html.indexOf('<script src="app.js"></script>'));
  const css = WWW("styles.css");
  assert.match(css, /\.usage-counter\.is-warning\{\s*color: var\(--warning\);/);
  assert.match(css, /\.premium-badge\{[^}]*background: var\(--accent-soft\);/);
  assert.match(css, /\.plan-compare\{\s*display: grid;/);
  assert.match(css, /@media \(max-width: 480px\)\{\s*\.plan-compare\{\s*grid-template-columns: minmax\(0, 1fr\);/);
});

test("the desktop app opens the Premium contact link in the system browser: https only, no credentials", () => {
  assert.equal(isSafeExternalUrl("https://t.me/linguahub_support"), true);
  for (const bad of ["http://t.me/x", "javascript:alert(1)", "file:///C:/x", "https://user:pass@evil.example/", "https://", "", null, undefined, 5, "ftp://x"]) assert.equal(isSafeExternalUrl(bad), false, String(bad));
  const main = WWW("../main.js");
  assert.match(main, /if \(isSafeExternalUrl\(url\)\) shell\.openExternal\(url\);/);
  assert.match(main, /const \{[^}]*shell[^}]*\} = require\("electron"\)/);
});
