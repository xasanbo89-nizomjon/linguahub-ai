"use strict";

// Optional sign-in (REQUIRE_SIGN_IN=false, the default): guests use the app with their own daily
// allowance, counted per hashed IP address in Firestore, with a global safety cap.

const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const OpenAI = require("openai");
const usage = require("../lib/usage.js");
const { validateEnv } = require("../lib/env.js");
const { createFakeFirestore, installFirebaseAdmin, uninstallFirebaseAdmin } = require("./helpers/aiAuth.js");

afterEach(() => uninstallFirebaseAdmin());

const NOW = new Date("2026-03-10T10:00:00Z");
const hash = (n) => crypto.createHash("sha256").update("guest-" + n).digest("hex");
const base = (extra) => Object.assign({ limit: 10, imageLimit: 2, globalCap: 2000, images: 0, now: NOW }, extra || {});

// ---- what identifies a guest ------------------------------------------------------------------------------------------

test("guestKey: a SHA-256 of salt + address; the raw address is not in it; the salt changes it; the fallback salt is a constant", () => {
  const key = usage.guestKey("203.0.113.7", "secret-salt");
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(key, crypto.createHash("sha256").update("secret-salt:203.0.113.7").digest("hex"));
  assert.ok(!key.includes("203"), "no trace of the address");
  assert.notEqual(key, usage.guestKey("203.0.113.7", "another-salt"));
  assert.notEqual(key, usage.guestKey("203.0.113.8", "secret-salt"));
  assert.equal(usage.guestKey("203.0.113.7"), crypto.createHash("sha256").update(usage.DEFAULT_SALT + ":203.0.113.7").digest("hex"), "no salt configured: a built-in constant");
  assert.equal(usage.guestKey("203.0.113.7", ""), usage.guestKey("203.0.113.7"));
});

test("normalizeIp: IPv4 as is; IPv4-mapped IPv6 is the IPv4 address; IPv6 counts as its /64 network (the same in any notation); unknown is one bucket", () => {
  assert.equal(usage.normalizeIp("203.0.113.7"), "203.0.113.7");
  assert.equal(usage.normalizeIp("::ffff:203.0.113.7"), "203.0.113.7");
  const a = usage.normalizeIp("2001:db8:abcd:12::1");
  assert.equal(a, usage.normalizeIp("2001:0db8:abcd:0012:0000:0000:0000:0001"));
  assert.equal(a, usage.normalizeIp("2001:db8:abcd:12:ffff:eeee:dddd:cccc"), "another address in the same /64 is the same guest");
  assert.notEqual(a, usage.normalizeIp("2001:db8:abcd:13::1"), "another /64 is another guest");
  assert.equal(usage.normalizeIp("fe80::1%eth0"), usage.normalizeIp("fe80::2"));
  for (const empty of ["", "  ", null, undefined]) assert.equal(usage.normalizeIp(empty), "unknown");
  assert.equal(usage.normalizeIp("::1"), usage.normalizeIp("0:0:0:0:0:0:0:1"));
});

// ---- counting guests ----------------------------------------------------------------------------------------------------

test("consumeGuest: counts requests per guest, tells what is left, refuses the (limit+1)th with reason 'limit'", async () => {
  const db = createFakeFirestore();
  const key = hash(1);
  const remaining = [];
  for (let i = 0; i < 10; i += 1) remaining.push((await usage.consumeGuest(Object.assign(base(), { db, ipHash: key }))).remaining);
  assert.deepEqual(remaining, [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
  const denied = await usage.consumeGuest(Object.assign(base(), { db, ipHash: key }));
  assert.deepEqual([denied.allowed, denied.reason, denied.remaining, denied.guest, denied.plan], [false, "limit", 0, true, "free"]);
  assert.equal(db.records.get("guestUsage/" + key).data.usageCount, 10);
  assert.equal((await usage.consumeGuest(Object.assign(base(), { db, ipHash: hash(2) }))).allowed, true, "another guest is unaffected");
});

test("consumeGuest: pictures - 2 picture messages a day, the third refused with reason 'images', plain text still fine", async () => {
  const db = createFakeFirestore();
  const key = hash(1);
  const go = (images) => usage.consumeGuest(Object.assign(base({ images }), { db, ipHash: key }));
  assert.equal((await go(1)).allowed, true);
  assert.equal((await go(3)).allowed, true, "a message with three pictures is one picture message");
  const third = await go(1);
  assert.deepEqual([third.allowed, third.reason, third.imagesRemaining], [false, "images", 0]);
  assert.equal((await go(0)).allowed, true, "text is still allowed");
  assert.equal(db.records.get("guestUsage/" + key).data.usageCount, 3, "pictures count as requests too; the refused one counted nothing");
  assert.equal(db.records.get("guestUsage/" + key).data.imageCount, 2);
});

test("consumeGuest: the guest's own limit is reported before the picture limit and the global cap", async () => {
  const db = createFakeFirestore({ ["guestUsage/" + hash(1)]: { usageDate: "2026-03-10", usageCount: 10, imageCount: 2 }, "guestUsage/global-2026-03-10": { date: "2026-03-10", count: 5000 } });
  const r = await usage.consumeGuest(Object.assign(base({ images: 1 }), { db, ipHash: hash(1) }));
  assert.equal(r.reason, "limit");
});

test("consumeGuest: the day ends at Tashkent midnight for guests too", async () => {
  const db = createFakeFirestore();
  const key = hash(1);
  for (let i = 0; i < 10; i += 1) await usage.consumeGuest(Object.assign(base({ now: new Date("2026-03-10T18:59:00Z") }), { db, ipHash: key }));
  assert.equal((await usage.consumeGuest(Object.assign(base({ now: new Date("2026-03-10T18:59:59Z") }), { db, ipHash: key }))).allowed, false);
  const after = await usage.consumeGuest(Object.assign(base({ now: new Date("2026-03-10T19:00:00Z") }), { db, ipHash: key }));
  assert.equal(after.allowed, true);
  assert.equal(after.remaining, 9);
  assert.equal(db.records.get("guestUsage/" + key).data.imageCount, 0, "the picture count renews too");
});

// ---- the global safety cap -------------------------------------------------------------------------------------------------

test("global cap: once all guests together have used the day's cap, new requests are refused with reason 'cap' - and it renews the next day", async () => {
  const db = createFakeFirestore();
  for (let i = 0; i < 5; i += 1) assert.equal((await usage.consumeGuest(Object.assign(base({ globalCap: 5 }), { db, ipHash: hash(i) }))).allowed, true);
  const refused = await usage.consumeGuest(Object.assign(base({ globalCap: 5 }), { db, ipHash: hash(99) }));
  assert.deepEqual([refused.allowed, refused.reason], [false, "cap"]);
  assert.equal(db.records.get("guestUsage/global-2026-03-10").data.count, 5, "a refused request is not counted");
  const tomorrow = await usage.consumeGuest(Object.assign(base({ globalCap: 5, now: new Date("2026-03-10T19:30:00Z") }), { db, ipHash: hash(99) }));
  assert.equal(tomorrow.allowed, true);
  assert.equal(db.records.get("guestUsage/global-2026-03-11").data.count, 1);
});

test("global cap under pressure: 30 different guests at once against a cap of 7 -> exactly 7 are let in", async () => {
  const db = createFakeFirestore();
  const results = await Promise.all(Array.from({ length: 30 }, (_, i) => usage.consumeGuest(Object.assign(base({ globalCap: 7 }), { db, ipHash: hash(i) }))));
  assert.equal(results.filter((r) => r.allowed).length, 7);
  assert.equal(results.filter((r) => r.reason === "cap").length, 23);
  assert.equal(db.records.get("guestUsage/global-2026-03-10").data.count, 7);
});

test("concurrent requests from ONE guest never exceed their limit (and the global count matches what was allowed)", async () => {
  const db = createFakeFirestore();
  const results = await Promise.all(Array.from({ length: 40 }, () => usage.consumeGuest(Object.assign(base({ limit: 10 }), { db, ipHash: hash(1) }))));
  assert.equal(results.filter((r) => r.allowed).length, 10);
  assert.equal(db.records.get("guestUsage/" + hash(1)).data.usageCount, 10);
  assert.equal(db.records.get("guestUsage/global-2026-03-10").data.count, 10);
});

// ---- refunds and reading -----------------------------------------------------------------------------------------------------

test("releaseGuest: gives back the request, the picture and the global slot - same day only, never below zero", async () => {
  const db = createFakeFirestore();
  const key = hash(1);
  await usage.consumeGuest(Object.assign(base({ images: 1 }), { db, ipHash: key }));
  assert.equal(await usage.releaseGuest({ db, ipHash: key, dateKey: "2026-03-10", images: 1 }), true);
  const doc = db.records.get("guestUsage/" + key).data;
  assert.deepEqual([doc.usageCount, doc.imageCount], [0, 0]);
  assert.equal(db.records.get("guestUsage/global-2026-03-10").data.count, 0);
  assert.equal(await usage.releaseGuest({ db, ipHash: key, dateKey: "2026-03-10", images: 0 }), false, "already zero");
  await usage.consumeGuest(Object.assign(base(), { db, ipHash: key }));
  assert.equal(await usage.releaseGuest({ db, ipHash: key, dateKey: "2026-03-09", images: 0 }), false, "yesterday's request cannot refund today");
});

test("peekGuest: shows today's numbers and whether the global cap is reached, and writes nothing", async () => {
  const db = createFakeFirestore({ ["guestUsage/" + hash(1)]: { usageDate: "2026-03-10", usageCount: 3, imageCount: 1 }, "guestUsage/global-2026-03-10": { date: "2026-03-10", count: 5 } });
  const writes = db.log.writes;
  const snap = await usage.peekGuest(Object.assign(base({ globalCap: 5 }), { db, ipHash: hash(1) }));
  assert.deepEqual([snap.guest, snap.limit, snap.used, snap.remaining, snap.imageLimit, snap.imagesRemaining, snap.capReached], [true, 10, 3, 7, 2, 1, true]);
  assert.equal(snap.resetAt, "2026-03-10T19:00:00.000Z");
  const fresh = await usage.peekGuest(Object.assign(base(), { db, ipHash: hash(7) }));
  assert.deepEqual([fresh.used, fresh.remaining, fresh.capReached], [0, 10, false]);
  assert.equal(db.log.writes, writes);
  assert.equal(db.records.has("guestUsage/" + hash(7)), false);
});

// ---- through the real routes ---------------------------------------------------------------------------------------------------

const OK = { model: "m", choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
const USERS = { "tok-alice": { uid: "alice" } };

function patchProvider() {
  const original = OpenAI.Chat.Completions.prototype.create;
  const originalAudio = OpenAI.Audio.Transcriptions.prototype.create;
  const calls = { chat: 0, transcribe: 0 };
  OpenAI.Chat.Completions.prototype.create = async function (body) { calls.chat += 1; return body.stream ? (async function* () { yield { model: "m", choices: [{ delta: { content: "x" } }] }; })() : OK; };
  OpenAI.Audio.Transcriptions.prototype.create = async function () { calls.transcribe += 1; return { text: "hello" }; };
  return { calls, restore() { OpenAI.Chat.Completions.prototype.create = original; OpenAI.Audio.Transcriptions.prototype.create = originalAudio; } };
}

async function withServer(fn, options) {
  const o = options || {};
  const saved = {};
  const env = Object.assign({ REQUIRE_SIGN_IN: "false" }, o.env || {});
  Object.keys(env).forEach((k) => { saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; });
  const admin = installFirebaseAdmin({ db: createFakeFirestore(o.documents), users: USERS });
  const provider = patchProvider();
  const app = require("../server.js");
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try { await fn("http://127.0.0.1:" + server.address().port, { db: admin.db, provider }); }
  finally {
    await new Promise((r) => { server.close(r); server.closeAllConnections && server.closeAllConnections(); });
    provider.restore();
    Object.keys(saved).forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
  }
}

const post = (base, route, body, headers) => fetch(base + route, { method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, headers || {}), body: JSON.stringify(body || { messages: [{ role: "user", content: "hello" }] }) });
const chat = (mode, content) => ({ mode: mode || "general", messages: [{ role: "user", content: content || "hello" }] });
const PNG = "data:image/png;base64," + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(200, 1)]).toString("base64");

test("sign-in is optional by default: a guest chats with no token on every chat route, and sees what is left", async () => {
  await withServer(async (base, ctx) => {
    const first = await post(base, "/api/chat", chat());
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("x-usage-plan"), "free");
    assert.equal(first.headers.get("x-usage-limit"), "5");
    assert.equal(first.headers.get("x-usage-remaining"), "4");
    const json = await first.json();
    assert.deepEqual([json.quota.remaining, json.quota.limit, json.quota.guest], [4, 5, true]);
    assert.equal((await post(base, "/chat", chat())).status, 200);
    const stream = await post(base, "/api/chat/stream", chat());
    assert.equal(stream.status, 200);
    const text = await stream.text();
    assert.match(text, /"quota":\{[^}]*"guest":true/);
    assert.equal(ctx.provider.calls.chat, 3);
  }, { env: { GUEST_DAILY_LIMIT: "5" } });
});

test("a guest gets GUEST_DAILY_LIMIT requests, then 429 DAILY_LIMIT_REACHED (flagged as a guest, with the price text) and the AI is not called", async () => {
  await withServer(async (base, ctx) => {
    for (let i = 0; i < 3; i += 1) assert.equal((await post(base, "/api/chat", chat())).status, 200);
    const denied = await post(base, "/api/chat", chat());
    assert.equal(denied.status, 429);
    const body = await denied.json();
    assert.deepEqual([body.code, body.remaining, body.limit, body.guest], ["DAILY_LIMIT_REACHED", 0, 3, true]);
    assert.equal(new Date(body.resetAt).getUTCHours(), 19);
    assert.equal(body.priceLabel, "Coming soon");
    assert.ok(Number(denied.headers.get("retry-after")) > 0);
    assert.equal(ctx.provider.calls.chat, 3);
  }, { env: { GUEST_DAILY_LIMIT: "3", RATE_LIMIT_MAX_REQUESTS: "100" } });
});

test("the default guest limits are 10 requests and 2 picture messages a day", async () => {
  const env = validateEnv({});
  assert.deepEqual([env.requireSignIn, env.guestDailyLimit, env.guestImageDailyLimit, env.guestGlobalDailyCap, env.guestSalt], [false, 10, 2, 2000, ""]);
  await withServer(async (base) => {
    for (let i = 0; i < 10; i += 1) assert.equal((await post(base, "/api/chat", chat())).status, 200, "request " + (i + 1));
    assert.equal((await post(base, "/api/chat", chat())).status, 429);
  }, { env: { RATE_LIMIT_MAX_REQUESTS: "100" } });
});

test("guests are told apart by IP address (behind a trusted proxy): different addresses have separate allowances", async () => {
  await withServer(async (base) => {
    const as = (ip) => post(base, "/api/chat", chat(), { "X-Forwarded-For": ip });
    assert.equal((await as("198.51.100.1")).status, 200);
    assert.equal((await as("198.51.100.1")).status, 429, "same address: used up");
    assert.equal((await as("198.51.100.2")).status, 200, "another address: its own allowance");
  }, { env: { TRUST_PROXY: "1", GUEST_DAILY_LIMIT: "1" } });
});

test("raw IP addresses are never stored: only salted SHA-256 hashes appear in Firestore", async () => {
  await withServer(async (base, ctx) => {
    await post(base, "/api/chat", chat(), { "X-Forwarded-For": "198.51.100.23" });
    const keys = Array.from(ctx.db.records.keys());
    const guestDocs = keys.filter((k) => k.startsWith("guestUsage/"));
    assert.equal(guestDocs.length, 2, "the guest's document and the day's global counter");
    const stored = JSON.stringify(Array.from(ctx.db.records.entries()));
    assert.ok(!stored.includes("198.51.100.23"), "the address is nowhere in the stored data");
    const hashed = guestDocs.find((k) => !k.includes("global-"));
    assert.equal(hashed, "guestUsage/" + crypto.createHash("sha256").update("pepper:198.51.100.23").digest("hex"), "SHA-256(GUEST_SALT:address)");
    assert.ok(guestDocs.some((k) => k.startsWith("guestUsage/global-")));
  }, { env: { TRUST_PROXY: "1", GUEST_SALT: "pepper" } });
});

test("without GUEST_SALT the hash still works (a built-in constant); with another salt it is a different key", async () => {
  await withServer(async (base, ctx) => {
    await post(base, "/api/chat", chat(), { "X-Forwarded-For": "198.51.100.23" });
    assert.ok(ctx.db.records.has("guestUsage/" + usage.guestKey("198.51.100.23")));
  }, { env: { TRUST_PROXY: "1", GUEST_SALT: undefined } });
});

test("pictures: a guest may send 2 picture messages a day; the third is refused with GUEST_IMAGE_LIMIT_REACHED, plain text keeps working", async () => {
  await withServer(async (base, ctx) => {
    const withPicture = () => post(base, "/api/chat", { mode: "general", messages: [{ role: "user", content: "", images: [PNG] }] });
    assert.equal((await withPicture()).status, 200);
    assert.equal((await withPicture()).status, 200);
    const third = await withPicture();
    assert.equal(third.status, 429);
    assert.equal((await third.json()).code, "GUEST_IMAGE_LIMIT_REACHED");
    assert.equal((await post(base, "/api/chat", chat())).status, 200);
    assert.equal(ctx.provider.calls.chat, 3);
  }, { env: { RATE_LIMIT_MAX_REQUESTS: "100" } });
});

test("global cap: when all guests together reach the cap, a new guest gets GUEST_CAP_REACHED (the sign-in prompt) - signed-in users are unaffected", async () => {
  await withServer(async (base, ctx) => {
    assert.equal((await post(base, "/api/chat", chat(), { "X-Forwarded-For": "198.51.100.1" })).status, 200);
    assert.equal((await post(base, "/api/chat", chat(), { "X-Forwarded-For": "198.51.100.2" })).status, 200);
    const blocked = await post(base, "/api/chat", chat(), { "X-Forwarded-For": "198.51.100.3" });
    assert.equal(blocked.status, 429);
    const body = await blocked.json();
    assert.equal(body.code, "GUEST_CAP_REACHED");
    assert.match(body.reply, /Sign in/);
    const member = await post(base, "/api/chat", chat(), { Authorization: "Bearer tok-alice", "X-Forwarded-For": "198.51.100.3" });
    assert.equal(member.status, 200, "a signed-in user is not a guest");
    assert.equal(ctx.provider.calls.chat, 3);
  }, { env: { TRUST_PROXY: "1", GUEST_GLOBAL_DAILY_CAP: "2" } });
});

test("signed-in users keep their plan limits (not the guest ones), and a valid token is used even when sign-in is optional", async () => {
  await withServer(async (base, ctx) => {
    for (let i = 0; i < 3; i += 1) assert.equal((await post(base, "/api/chat", chat(), { Authorization: "Bearer tok-alice" })).status, 200);
    const denied = await post(base, "/api/chat", chat(), { Authorization: "Bearer tok-alice" });
    assert.equal(denied.status, 429);
    assert.equal((await denied.json()).guest, undefined, "a member's limit message is not the guest one");
    assert.equal(ctx.db.read("alice").usageCount, 3);
    assert.equal(ctx.db.records.has("guestUsage/global-" + usage.dayKey(new Date())), false, "members are not counted as guests");
  }, { env: { FREE_DAILY_LIMIT: "3", GUEST_DAILY_LIMIT: "50", RATE_LIMIT_MAX_REQUESTS: "100" } });
});

test("a bad or expired token is treated as a guest - never as an error and never as more than a guest", async () => {
  await withServer(async (base, ctx) => {
    const r = await post(base, "/api/chat", chat(), { Authorization: "Bearer not-a-real-token" });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).quota.guest, true);
    assert.equal((await post(base, "/api/chat", chat(), { Authorization: "Bearer not-a-real-token" })).status, 429, "it shares the guest allowance");
    assert.equal(ctx.db.read("alice"), undefined);
  }, { env: { GUEST_DAILY_LIMIT: "1" } });
});

test("tap-a-word lookups and transcription are not counted for guests either", async () => {
  await withServer(async (base, ctx) => {
    for (let i = 0; i < 4; i += 1) assert.equal((await post(base, "/api/chat", chat("word-lookup", "Word: cat"))).status, 200);
    const t = await fetch(base + "/api/transcribe", { method: "POST", headers: { "Content-Type": "audio/webm" }, body: Buffer.alloc(4000, 1) });
    assert.equal(t.status, 200);
    assert.equal(ctx.db.records.size, 0, "nothing was counted, nothing stored");
    assert.equal((await post(base, "/api/chat", chat())).status, 200);
  }, { env: { GUEST_DAILY_LIMIT: "1", RATE_LIMIT_MAX_REQUESTS: "100" } });
});

test("invalid guest requests and AI failures give the request back", async () => {
  await withServer(async (base, ctx) => {
    for (const body of [{ mode: "general", messages: [] }, { mode: "nope", messages: [{ role: "user", content: "x" }] }, { mode: "grammar", messages: [{ role: "user", content: "x", images: [PNG] }] }]) {
      assert.ok((await post(base, "/api/chat", body)).status >= 400);
    }
    const doc = Array.from(ctx.db.records.entries()).find(([k]) => k.startsWith("guestUsage/") && !k.includes("global-"));
    assert.equal(doc[1].data.usageCount, 0);
    assert.equal(doc[1].data.imageCount, 0, "a refused picture request does not use up a picture slot");
    assert.equal((await post(base, "/api/chat", chat())).status, 200);
  }, { env: { GUEST_DAILY_LIMIT: "1", RATE_LIMIT_MAX_REQUESTS: "100" } });
});

test("if the guest counter cannot be read the request is refused (503), never let through unmetered", async () => {
  await withServer(async (base, ctx) => {
    ctx.db.failNext = new Error("firestore down");
    const r = await post(base, "/api/chat", chat());
    assert.equal(r.status, 503);
    assert.equal((await r.json()).code, "USAGE_UNAVAILABLE");
    assert.equal(ctx.provider.calls.chat, 0);
  });
});

test("GET /api/usage works for guests - this is how the page learns the flag and the numbers", async () => {
  await withServer(async (base) => {
    await post(base, "/api/chat", chat());
    const r = await fetch(base + "/api/usage");
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual([body.requireSignIn, body.guest, body.plan, body.limit, body.used, body.remaining, body.imageLimit, body.imagesRemaining, body.capReached], [false, true, "free", 5, 1, 4, 2, 2, false]);
    assert.ok(body.resetAt && body.priceLabel);
    const member = await (await fetch(base + "/api/usage", { headers: { Authorization: "Bearer tok-alice" } })).json();
    assert.deepEqual([member.guest, member.requireSignIn, member.imageLimit], [false, false, null]);
  }, { env: { GUEST_DAILY_LIMIT: "5" } });
});

test("REQUIRE_SIGN_IN=true: everything is as before - no token is 401 (also for /api/usage, which tells the page the flag), guests are never counted", async () => {
  await withServer(async (base, ctx) => {
    for (const route of ["/api/chat", "/api/chat/stream", "/chat"]) assert.equal((await post(base, route, chat())).status, 401, route);
    const usageResponse = await fetch(base + "/api/usage");
    assert.equal(usageResponse.status, 401);
    const body = await usageResponse.json();
    assert.deepEqual([body.code, body.requireSignIn], ["AUTH_REQUIRED", true]);
    assert.equal((await post(base, "/api/chat", chat(), { Authorization: "Bearer tok-alice" })).status, 200);
    assert.equal(ctx.provider.calls.chat, 1);
    assert.ok(!Array.from(ctx.db.records.keys()).some((k) => k.startsWith("guestUsage/")), "no guest data in strict mode");
  }, { env: { REQUIRE_SIGN_IN: "true" } });
});

// ---- configuration --------------------------------------------------------------------------------------------------------------

test("env: REQUIRE_SIGN_IN is 'true' or 'false' (any case, default false); the guest numbers are positive integers", () => {
  assert.equal(validateEnv({}).requireSignIn, false);
  assert.equal(validateEnv({ REQUIRE_SIGN_IN: "true" }).requireSignIn, true);
  assert.equal(validateEnv({ REQUIRE_SIGN_IN: " TRUE " }).requireSignIn, true);
  assert.equal(validateEnv({ REQUIRE_SIGN_IN: "false" }).requireSignIn, false);
  for (const bad of ["yes", "1", "on", "tru"]) {
    const r = validateEnv({ REQUIRE_SIGN_IN: bad });
    assert.equal(r.ok, false, bad);
    assert.match(r.errors.join(" "), /REQUIRE_SIGN_IN/);
  }
  assert.deepEqual([validateEnv({ GUEST_DAILY_LIMIT: "20" }).guestDailyLimit, validateEnv({ GUEST_IMAGE_DAILY_LIMIT: "5" }).guestImageDailyLimit, validateEnv({ GUEST_GLOBAL_DAILY_CAP: "500" }).guestGlobalDailyCap], [20, 5, 500]);
  for (const key of ["GUEST_DAILY_LIMIT", "GUEST_IMAGE_DAILY_LIMIT", "GUEST_GLOBAL_DAILY_CAP"]) {
    for (const bad of ["0", "-1", "abc", "2.5"]) assert.equal(validateEnv({ [key]: bad }).ok, false, key + "=" + bad);
  }
  assert.equal(validateEnv({ GUEST_SALT: "s3cret" }).guestSalt, "s3cret");
  assert.ok(validateEnv({ NODE_ENV: "production" }).warnings.some((w) => /GUEST_SALT/.test(w)), "production without a salt is flagged");
  assert.ok(!validateEnv({ NODE_ENV: "production", GUEST_SALT: "x" }).warnings.some((w) => /GUEST_SALT/.test(w)));
  assert.ok(!validateEnv({ NODE_ENV: "production", REQUIRE_SIGN_IN: "true" }).warnings.some((w) => /GUEST_SALT/.test(w)), "no salt needed in strict mode");
});
