"use strict";

// Optional sign-in, as the person sees it: guests chat normally with a "7 / 10 free today" counter,
// the limit shows the pricing modal with a "Sign in for more" note, and the forced "Sign in to
// continue" dialog only appears when the server requires a sign-in.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { createDom } = require("./helpers/miniDom.js");
const Usage = require("../www/usage.js");

const WWW = (f) => fs.readFileSync(path.join(__dirname, "..", "www", f), "utf8");
const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r)); };

const GUEST_USAGE = { requireSignIn: false, guest: true, plan: "free", premium: false, limit: 10, used: 3, remaining: 7, resetAt: "2026-03-10T19:00:00.000Z", priceLabel: "Coming soon", contactUrl: "https://t.me/linguahub_support" };
const MEMBER_USAGE = { requireSignIn: false, guest: false, plan: "free", premium: false, limit: 10, used: 1, remaining: 9, resetAt: "2026-03-10T19:00:00.000Z", priceLabel: "Coming soon", contactUrl: null };

function setup(options) {
  const o = options || {};
  const dom = createDom();
  const doc = dom.document;
  const counterEl = doc.createElement("div");
  counterEl.hidden = true;
  doc.body.appendChild(counterEl);
  const fetches = [];
  const state = { signedIn: Boolean(o.signedIn), available: o.available !== false };
  const usage = Usage.create({
    document: doc, counterEl, premiumEls: {}, storage: null,
    apiUrl: (p) => "http://api.test" + p,
    getAuthHeaders: async () => (state.signedIn ? { Authorization: "Bearer tok" } : {}),
    fetch: async (url, init) => { fetches.push({ url, init }); return o.respond ? o.respond(url, init) : { ok: true, status: 200, json: async () => (state.signedIn ? MEMBER_USAGE : GUEST_USAGE) }; },
    isSignedIn: () => state.signedIn,
    isSignInAvailable: () => state.available,
    signIn: () => { state.signInCalls = (state.signInCalls || 0) + 1; },
    notify() {},
    now: () => Date.parse("2026-03-10T10:00:00Z")
  });
  const q = (cls) => dom.byClass(doc.body, cls);
  return { dom, doc, usage, counterEl, fetches, state, q };
}

// ---- guests simply use the app ------------------------------------------------------------------------------------------

test("a guest is never interrupted: AI features are allowed with no sign-in and no dialog", () => {
  const t = setup();
  assert.equal(t.usage.state().requireSignIn, false);
  assert.equal(t.usage.canUseAi(), true);
  assert.equal(t.q("usage-dialog").length, 0);
  assert.equal(t.usage.canUseAi(), true, "every time");
});

test("a guest sees '7 / 10 free today' (the counter comes from GET /api/usage, sent without any token)", async () => {
  const t = setup();
  await t.usage.refresh();
  assert.equal(t.fetches.length, 1);
  assert.equal(t.fetches[0].url, "http://api.test/api/usage");
  assert.equal(t.fetches[0].init.headers.Authorization, undefined);
  assert.equal(t.counterEl.hidden, false);
  assert.equal(t.counterEl.textContent, "7 / 10 free today");
  assert.deepEqual([t.usage.state().guest, t.usage.state().requireSignIn], [true, false]);
});

test("the guest counter follows every reply and turns to the warning colour at 2 left, like a member's", () => {
  const t = setup();
  t.usage.fromQuota({ plan: "free", premium: false, guest: true, limit: 10, remaining: 2 });
  assert.equal(t.counterEl.textContent, "2 / 10 free today");
  assert.ok(t.counterEl.classList.contains("is-warning"));
  t.usage.fromHeaders({ get: (n) => ({ "x-usage-plan": "free", "x-usage-limit": "10", "x-usage-remaining": "1" })[n.toLowerCase()] || null });
  assert.equal(t.counterEl.textContent, "1 / 10 free today");
  assert.equal(t.usage.state().guest, true, "the headers do not forget this is a guest");
});

test("on load and on sign-out the guest's numbers are read; on sign-in the account's own take over", async () => {
  const t = setup();
  t.usage.setUser(null);
  await settle();
  assert.equal(t.fetches.length, 1, "signed out: the guest's numbers");
  assert.equal(t.usage.state().guest, true);
  t.state.signedIn = true;
  t.usage.setUser({ uid: "u1" });
  await settle();
  assert.equal(t.fetches[1].init.headers.Authorization, "Bearer tok");
  assert.deepEqual([t.usage.state().guest, t.counterEl.textContent], [false, "9 / 10 free today"]);
  t.state.signedIn = false;
  t.usage.setUser(null);
  await settle();
  assert.equal(t.counterEl.textContent, "7 / 10 free today", "signing out shows the guest allowance again");
});

test("a failed numbers request leaves the counter hidden, never an error", async () => {
  for (const respond of [async () => ({ ok: false, status: 503, json: async () => ({}) }), async () => { throw new Error("offline"); }]) {
    const t = setup({ respond });
    assert.equal(await t.usage.refresh(), null);
    assert.equal(t.counterEl.hidden, true);
  }
});

// ---- the limit ------------------------------------------------------------------------------------------------------------------

test("at the limit a guest gets the pricing modal with a 'Sign in for more' note and button", () => {
  const t = setup();
  t.usage.handleLimit({ code: "DAILY_LIMIT_REACHED", remaining: 0, limit: 10, guest: true, resetAt: "2026-03-10T19:00:00.000Z", priceLabel: "$4.99 / month" });
  const dialog = t.q("paywall")[0];
  assert.ok(dialog);
  assert.equal(t.dom.byTag(dialog, "h2")[0].textContent, "You've used today's free requests");
  assert.equal(t.q("plan-column").length, 2, "the Free / Premium comparison is there");
  assert.equal(t.q("plan-price")[0].textContent, "$4.99 / month");
  assert.match(t.q("paywall-signin")[0].textContent, /Sign in for more/);
  const button = t.q("paywall-signin-btn")[0];
  assert.equal(button.textContent, "Sign in for more");
  assert.ok(t.q("paywall-get")[0], "Get Premium is still offered");
  button.click();
  assert.equal(t.state.signInCalls, 1, "it starts the normal Google sign-in");
  assert.equal(t.q("paywall").length, 0, "and the modal closes");
  assert.equal(t.counterEl.textContent, "0 / 10 free today");
});

test("a signed-in member at the limit sees the same modal WITHOUT the guest note", () => {
  const t = setup({ signedIn: true });
  t.usage.fromQuota({ guest: false, plan: "free", premium: false, limit: 10, remaining: 3 });
  t.usage.handleLimit({ code: "DAILY_LIMIT_REACHED", remaining: 0, limit: 10, resetAt: "2026-03-10T19:00:00.000Z" });
  assert.ok(t.q("paywall")[0]);
  assert.equal(t.q("paywall-signin").length, 0);
  assert.equal(t.q("paywall-signin-btn").length, 0);
});

test("where signing in is impossible the guest modal still shows the note's text but no dead button", () => {
  const t = setup({ available: false });
  t.usage.handleLimit({ code: "DAILY_LIMIT_REACHED", remaining: 0, limit: 10, guest: true });
  assert.equal(t.q("paywall-signin-btn").length, 0);
  assert.ok(t.q("paywall-get")[0]);
});

test("the limit sentence for a guest ends with 'Sign in for more.'", () => {
  const t = setup();
  t.usage.fromQuota({ guest: true, plan: "free", premium: false, limit: 10, remaining: 0, resetAt: "2026-03-10T19:00:00.000Z" });
  assert.match(t.usage.limitMessage(), /You've used all your free requests for today\. Free requests renew at 00:00.*Sign in for more\.$/);
  const member = setup({ signedIn: true });
  member.usage.fromQuota({ guest: false, plan: "free", premium: false, limit: 10, remaining: 0 });
  assert.doesNotMatch(member.usage.limitMessage(), /Sign in for more/);
});

// ---- when a sign-in IS asked for ------------------------------------------------------------------------------------------------

test("the guests' global cap shows the sign-in dialog (not the pricing modal) with its own explanation", () => {
  const t = setup();
  t.usage.handleLimit({ code: "GUEST_CAP_REACHED", guest: true, remaining: 0, limit: 10 });
  assert.equal(t.q("paywall").length, 0);
  const dialog = t.q("signin-required")[0];
  assert.ok(dialog);
  assert.match(dialog.textContent, /Free use without an account is busy right now\. Sign in to continue/);
  assert.ok(t.q("signin-go")[0]);
  assert.equal(t.counterEl.hidden, true, "the numbers did not change");
});

test("the guests' picture limit asks for a sign-in to send more pictures", () => {
  const t = setup();
  t.usage.handleLimit({ code: "GUEST_IMAGE_LIMIT_REACHED", guest: true });
  assert.match(t.q("signin-required")[0].textContent, /used today's free pictures\. Sign in to send more/);
  t.q("signin-go")[0].click();
  assert.equal(t.state.signInCalls, 1);
});

test("handleErrorBody: the one place failed AI responses go - limits and required sign-in are shown and described, everything else is left alone", () => {
  const t = setup();
  const daily = t.usage.handleErrorBody(429, { code: "DAILY_LIMIT_REACHED", guest: true, limit: 10, remaining: 0 });
  assert.equal(daily.code, "DAILY_LIMIT_REACHED");
  assert.match(daily.message, /Sign in for more\.$/);
  assert.equal(t.q("paywall").length, 1);
  const cap = t.usage.handleErrorBody(429, { code: "GUEST_CAP_REACHED" });
  assert.equal(cap.code, "GUEST_CAP_REACHED");
  assert.equal(t.q("signin-required").length, 1);
  assert.equal(t.q("usage-dialog").length, 1, "one dialog at a time");
  const pics = t.usage.handleErrorBody(429, { code: "GUEST_IMAGE_LIMIT_REACHED" });
  assert.match(pics.message, /pictures/);
  for (const [status, body] of [[429, { reply: "too fast" }], [429, {}], [500, { code: "DAILY_LIMIT_REACHED" }], [429, null], [401, { code: "OTHER" }], [200, { code: "AUTH_REQUIRED" }], [429, "text"]]) {
    assert.equal(t.usage.handleErrorBody(status, body), null, status + " " + JSON.stringify(body));
  }
});

test("a server that requires sign-in (401 AUTH_REQUIRED) switches the page to the strict behaviour: dialog now, and before every AI feature from then on", () => {
  const t = setup();
  assert.equal(t.usage.canUseAi(), true);
  const handled = t.usage.handleErrorBody(401, { code: "AUTH_REQUIRED" });
  assert.deepEqual([handled.code, handled.message], ["AUTH_REQUIRED", "Sign in to continue - it's free."]);
  assert.equal(t.q("signin-required").length, 1);
  t.usage.closeDialog();
  assert.equal(t.usage.canUseAi(), false);
  assert.equal(t.q("signin-required").length, 1);
});

test("the page learns the mode from GET /api/usage: requireSignIn true in its answer, or a 401 with that flag", async () => {
  const strictOk = setup({ signedIn: true, respond: async () => ({ ok: true, status: 200, json: async () => Object.assign({}, MEMBER_USAGE, { requireSignIn: true }) }) });
  await strictOk.usage.refresh();
  assert.equal(strictOk.usage.state().requireSignIn, true);
  strictOk.state.signedIn = false;
  assert.equal(strictOk.usage.canUseAi(), false, "signed out in strict mode: the dialog");
  const flagged401 = setup({ respond: async () => ({ ok: false, status: 401, json: async () => ({ code: "AUTH_REQUIRED", requireSignIn: true }) }) });
  await flagged401.usage.refresh();
  assert.equal(flagged401.usage.canUseAi(), false);
  const plain401 = setup({ signedIn: true, respond: async () => ({ ok: false, status: 401, json: async () => ({ reply: "expired" }) }) });
  await plain401.usage.refresh();
  assert.equal(plain401.usage.state().requireSignIn, false, "a 401 without the flag (e.g. an expired token) does not switch modes");
});

// ---- wiring ----------------------------------------------------------------------------------------------------------------------------

test("app.js: the guest counter is read at start when there is no sign-in system; sign-in code, CSP and redirect handling are all still there", () => {
  const app = WWW("app.js");
  assert.doesNotMatch(app, /localStorage\./, "app.js never touches storage directly");
  assert.match(app, /if \(usage && !\(window\.LinguaHubAuth && LinguaHubAuth\.isAvailable\(\)\)\) usage\.refresh\(\);/);
  assert.match(app, /if \(usage\) usage\.setUser\(user\);/);
  assert.match(app, /loginBtn\.addEventListener\("click", handleLogin\);/, "sign-in stays available as an option");
  assert.match(app, /completeRedirectSignIn/);
  const auth = WWW("auth.js");
  assert.match(auth, /function isInstalledWebApp\(\)/);
  assert.match(auth, /function resolveAuthDomain\(/);
  assert.ok(fs.readFileSync(path.join(__dirname, "..", "lib", "csp.js"), "utf8").includes("https://apis.google.com"));
  assert.ok(JSON.parse(fs.readFileSync(path.join(__dirname, "..", "vercel.json"), "utf8")).rewrites.some((r) => r.source === "/__/auth/:path*"));
});

test("the sign-in prompt for a required sign-in is gone from ordinary guest use: the guards only block when the flag says so", () => {
  const usageSource = WWW("usage.js");
  assert.match(usageSource, /if \(!state\.requireSignIn\) return true;/);
  const speech = WWW("speech-input.js");
  assert.match(speech, /win\.linguahubUsage\.canUseAi\(\)/, "recording asks the same gate");
  const t = setup();
  assert.equal(t.usage.canUseAi(), true, "so recording and every other feature start for a guest");
});
