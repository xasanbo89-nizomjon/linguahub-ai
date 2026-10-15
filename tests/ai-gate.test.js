"use strict";

// The ONE gate in front of every AI endpoint: verified sign-in, the daily free limit,
// premium, what counts, what does not, and what the responses carry.

const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const express = require("express");
const OpenAI = require("openai");
const { createFakeFirestore, installFirebaseAdmin, uninstallFirebaseAdmin } = require("./helpers/aiAuth.js");
const { createAiGate } = require("../lib/aiGate.js");
const usage = require("../lib/usage.js");
const { validateEnv } = require("../lib/env.js");

const OK_REPLY = { model: "m", choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
const USERS = { "tok-alice": { uid: "alice", email: "alice@example.com" }, "tok-bob": { uid: "bob", email: "bob@example.com" }, "tok-vip": { uid: "vip" }, "tok-lapsed": { uid: "lapsed" } };
const FUTURE = { seconds: Math.floor(Date.now() / 1000) + 30 * 86400, nanoseconds: 0 };
const PAST = { seconds: Math.floor(Date.now() / 1000) - 60, nanoseconds: 0 };

afterEach(() => uninstallFirebaseAdmin());

function patchProvider(handlers) {
  const originals = { chat: OpenAI.Chat.Completions.prototype.create, transcribe: OpenAI.Audio.Transcriptions.prototype.create };
  const calls = { chat: 0, transcribe: 0 };
  OpenAI.Chat.Completions.prototype.create = async function (body, options) {
    calls.chat += 1;
    if (handlers && handlers.chat) return handlers.chat(body, options);
    if (body.stream) return (async function* () { yield { model: "m", choices: [{ delta: { content: "Hello" } }], usage: null }; })();
    return OK_REPLY;
  };
  OpenAI.Audio.Transcriptions.prototype.create = async function () { calls.transcribe += 1; return { text: "hello there" }; };
  return { calls, restore() { OpenAI.Chat.Completions.prototype.create = originals.chat; OpenAI.Audio.Transcriptions.prototype.create = originals.transcribe; } };
}

async function withServer(fn, options) {
  const o = options || {};
  const saved = {};
  Object.keys(o.env || {}).forEach((k) => { saved[k] = process.env[k]; process.env[k] = o.env[k]; });
  const admin = installFirebaseAdmin({ db: o.db || createFakeFirestore(o.documents), users: USERS, configured: o.configured });
  const provider = patchProvider(o.provider);
  const app = require("../server.js");
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try { await fn("http://127.0.0.1:" + server.address().port, { db: admin.db, provider }); }
  finally {
    await new Promise((r) => { server.close(r); server.closeAllConnections && server.closeAllConnections(); });
    provider.restore();
    Object.keys(saved).forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
  }
}

const post = (base, route, token, body, extra) => fetch(base + route, {
  method: "POST",
  headers: Object.assign({ "Content-Type": "application/json" }, token ? { Authorization: "Bearer " + token } : {}, extra || {}),
  body: JSON.stringify(body || { messages: [{ role: "user", content: "hello" }] })
});
const chat = (mode, content) => ({ mode: mode || "general", messages: [{ role: "user", content: content || "hello" }] });

// ---- a verified Firebase token is required -------------------------------------------------------------------------------

test("no token -> 401 on every AI endpoint, and the provider is never called", async () => {
  await withServer(async (base, ctx) => {
    for (const route of ["/api/chat", "/api/chat/stream", "/chat"]) {
      const r = await post(base, route, null);
      assert.equal(r.status, 401, route);
      assert.match((await r.json()).reply, /Authentication required/);
    }
    const t = await fetch(base + "/api/transcribe", { method: "POST", headers: { "Content-Type": "audio/webm" }, body: Buffer.alloc(4000, 1) });
    assert.equal(t.status, 401);
    assert.equal(ctx.provider.calls.chat + ctx.provider.calls.transcribe, 0);
    assert.equal(ctx.db.log.transactions, 0, "nothing was counted for anonymous callers");
  });
});

test("an invalid, expired or malformed token -> 401; a lookalike header is not a token", async () => {
  await withServer(async (base, ctx) => {
    for (const token of ["nope", "tok-alice-but-edited", "", "undefined"]) {
      const r = await post(base, "/api/chat", token || null);
      assert.equal(r.status, 401, JSON.stringify(token));
    }
    const basic = await fetch(base + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Basic dG9rLWFsaWNl" }, body: JSON.stringify(chat()) });
    assert.equal(basic.status, 401);
    const claimed = await post(base, "/api/chat", null, chat(), { "X-User-Id": "alice", "X-Uid": "alice" });
    assert.equal(claimed.status, 401, "a claimed identity is worth nothing");
    assert.equal(ctx.provider.calls.chat, 0);
  });
});

test("the user id in the body or query is ignored: the count always follows the verified token", async () => {
  await withServer(async (base, ctx) => {
    const r = await post(base, "/api/chat?uid=bob", "tok-alice", Object.assign(chat(), { uid: "bob", userId: "bob" }));
    assert.equal(r.status, 200, "extra fields are not an identity; they are simply ignored");
    assert.equal(ctx.db.read("alice").usageCount, 1);
    assert.equal(ctx.db.read("bob"), undefined, "bob was never touched");
  });
});

test("when Firebase Admin is not configured the AI routes answer 503 instead of letting anyone in", async () => {
  await withServer(async (base, ctx) => {
    const r = await post(base, "/api/chat", "tok-alice");
    assert.equal(r.status, 503);
    assert.equal(ctx.provider.calls.chat, 0);
  }, { configured: false });
});

test("the landing page's 'try one correction' needs no token (it is limited per IP address instead)", async () => {
  await withServer(async (base) => {
    const r = await post(base, "/api/try-correct", null, { text: "She go home" });
    assert.notEqual(r.status, 401);
  });
});

// ---- the daily limit -------------------------------------------------------------------------------------------------------

test("a free user gets FREE_DAILY_LIMIT requests, then 429 DAILY_LIMIT_REACHED with remaining 0 and the reset time", async () => {
  await withServer(async (base, ctx) => {
    for (let i = 0; i < 3; i += 1) assert.equal((await post(base, "/api/chat", "tok-alice", chat())).status, 200);
    const denied = await post(base, "/api/chat", "tok-alice", chat());
    assert.equal(denied.status, 429);
    const body = await denied.json();
    assert.equal(body.code, "DAILY_LIMIT_REACHED");
    assert.equal(body.remaining, 0);
    assert.equal(body.limit, 3);
    assert.equal(Date.parse(body.resetAt) > Date.now(), true);
    assert.equal(new Date(body.resetAt).getUTCHours(), 19, "midnight in Tashkent is 19:00 UTC");
    assert.equal(new Date(body.resetAt).getUTCMinutes(), 0);
    assert.equal(denied.headers.get("x-usage-remaining"), "0");
    assert.ok(Number(denied.headers.get("retry-after")) > 0);
    assert.equal(ctx.provider.calls.chat, 3, "the refused request never reached the AI");
  }, { env: { FREE_DAILY_LIMIT: "3" } });
});

test("the default limit is 10", async () => {
  await withServer(async (base, ctx) => {
    for (let i = 0; i < 10; i += 1) assert.equal((await post(base, "/api/chat", "tok-alice", chat())).status, 200, "request " + (i + 1));
    assert.equal((await post(base, "/api/chat", "tok-alice", chat())).status, 429);
    assert.equal(ctx.provider.calls.chat, 10);
  });
});

test("the limit applies per user and across all three chat routes together", async () => {
  await withServer(async (base) => {
    assert.equal((await post(base, "/api/chat", "tok-alice", chat())).status, 200);
    assert.equal((await post(base, "/chat", "tok-alice", chat())).status, 200);
    const stream = await post(base, "/api/chat/stream", "tok-alice", chat());
    assert.equal(stream.status, 200);
    await stream.text();
    for (const route of ["/api/chat", "/chat", "/api/chat/stream"]) assert.equal((await post(base, route, "tok-alice", chat())).status, 429, route + " shares the same count");
    assert.equal((await post(base, "/api/chat", "tok-bob", chat())).status, 200, "another user is unaffected");
  }, { env: { FREE_DAILY_LIMIT: "3" } });
});

test("every learning feature counts: Translate, Grammar, Speak, vocabulary suggestions, images, Regenerate", async () => {
  await withServer(async (base, ctx) => {
    const png = "data:image/png;base64," + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(100, 1)]).toString("base64");
    const requests = [
      chat("translate", "Source language: detect it automatically\nTarget language: English\n\nText to translate:\nsalom"),
      chat("grammar", "Writing language: English\n\nText:\nI has"),
      chat("speak", "[Practice language: English | Native language: Uzbek]\nhello"),
      chat("vocabulary", "Practice language: English\nTopic: food"),
      { mode: "general", messages: [{ role: "user", content: "", images: [png] }] },
      chat("general", "regenerate = the same request again")
    ];
    for (const body of requests) assert.equal((await post(base, "/api/chat", "tok-alice", body)).status, 200);
    assert.equal(ctx.db.read("alice").usageCount, requests.length);
  }, { env: { FREE_DAILY_LIMIT: "20" } });
});

test("NOT counted: tap-a-word lookups and transcription of the user's own voice - both still need a signed-in user", async () => {
  await withServer(async (base, ctx) => {
    for (let i = 0; i < 15; i += 1) assert.equal((await post(base, "/api/chat", "tok-alice", chat("word-lookup", "Word: cat"))).status, 200);
    for (let i = 0; i < 3; i += 1) {
      const t = await fetch(base + "/api/transcribe", { method: "POST", headers: { "Content-Type": "audio/webm", Authorization: "Bearer tok-alice" }, body: Buffer.alloc(4000, 1) });
      assert.equal(t.status, 200);
    }
    assert.equal(ctx.db.read("alice"), undefined, "not even a usage document was created");
    assert.equal((await post(base, "/api/chat", null, chat("word-lookup", "Word: cat"))).status, 401, "lookups need a sign-in too");
    // and the allowance is still all there
    assert.equal((await post(base, "/api/chat", "tok-alice", chat())).status, 200);
    assert.equal(ctx.db.read("alice").usageCount, 1);
  }, { env: { RATE_LIMIT_MAX_REQUESTS: "100" } });
});

test("a user who is out of free requests can still look words up and transcribe their voice (those are not counted)", async () => {
  await withServer(async (base) => {
    assert.equal((await post(base, "/api/chat", "tok-alice", chat())).status, 200);
    assert.equal((await post(base, "/api/chat", "tok-alice", chat())).status, 429);
    assert.equal((await post(base, "/api/chat", "tok-alice", chat("word-lookup", "Word: cat"))).status, 200);
    const t = await fetch(base + "/api/transcribe", { method: "POST", headers: { "Content-Type": "audio/webm", Authorization: "Bearer tok-alice" }, body: Buffer.alloc(4000, 1) });
    assert.equal(t.status, 200);
  }, { env: { FREE_DAILY_LIMIT: "1" } });
});

test("invalid requests and AI failures do not use up a request (given back)", async () => {
  let fail = false;
  await withServer(async (base, ctx) => {
    for (const body of [{ mode: "general", messages: [] }, { mode: "nope", messages: [{ role: "user", content: "x" }] }, { mode: "general", messages: [{ role: "user", content: "" }] }, { mode: "grammar", messages: [{ role: "user", content: "x", images: ["data:image/png;base64,AAAA"] }] }]) {
      const r = await post(base, "/api/chat", "tok-alice", body);
      assert.ok(r.status >= 400 && r.status < 500, "refused with " + r.status);
    }
    assert.equal(ctx.db.read("alice").usageCount, 0, "four refused requests cost nothing");
    fail = true;
    assert.equal((await post(base, "/api/chat", "tok-alice", chat())).status, 500);
    assert.equal((await post(base, "/api/chat/stream", "tok-alice", chat())).status, 200);
    assert.equal(ctx.db.read("alice").usageCount, 0, "provider errors cost nothing");
    fail = false;
    assert.equal((await post(base, "/api/chat", "tok-alice", chat())).status, 200);
    assert.equal(ctx.db.read("alice").usageCount, 1);
  }, { provider: { chat: async (body) => { if (fail) throw Object.assign(new Error("boom"), { status: 500 }); return body.stream ? (async function* () { yield { model: "m", choices: [{ delta: { content: "x" } }] }; })() : OK_REPLY; } } });
});

test("a request refused for coming too fast (rate limiter) is not counted against the day", async () => {
  await withServer(async (base, ctx) => {
    const statuses = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await post(base, "/api/chat", "tok-alice", chat())).status);
    assert.deepEqual(statuses, [200, 200, 429, 429]);
    assert.equal(ctx.db.read("alice").usageCount, 2);
  }, { env: { RATE_LIMIT_MAX_REQUESTS: "2", FREE_DAILY_LIMIT: "50" } });
});

test("concurrent requests through the real route never exceed the limit", async () => {
  await withServer(async (base, ctx) => {
    const results = await Promise.all(Array.from({ length: 20 }, () => post(base, "/api/chat", "tok-alice", chat())));
    const statuses = results.map((r) => r.status);
    assert.equal(statuses.filter((s) => s === 200).length, 4);
    assert.equal(statuses.filter((s) => s === 429).length, 16);
    assert.equal(ctx.provider.calls.chat, 4, "the AI was called only for the allowed ones");
    assert.equal(ctx.db.read("alice").usageCount, 4);
  }, { env: { FREE_DAILY_LIMIT: "4", RATE_LIMIT_MAX_REQUESTS: "100" } });
});

test("if the usage record cannot be read or written the request is refused (503), never let through unmetered", async () => {
  await withServer(async (base, ctx) => {
    ctx.db.failNext = new Error("firestore down");
    const r = await post(base, "/api/chat", "tok-alice", chat());
    assert.equal(r.status, 503);
    assert.equal((await r.json()).code, "USAGE_UNAVAILABLE");
    assert.equal(ctx.provider.calls.chat, 0);
    assert.equal((await post(base, "/api/chat", "tok-alice", chat())).status, 200, "and it recovers");
  });
});

// ---- premium ---------------------------------------------------------------------------------------------------------------

test("premium users are not limited; expired premium counts as free", async () => {
  await withServer(async (base, ctx) => {
    for (let i = 0; i < 6; i += 1) {
      const r = await post(base, "/api/chat", "tok-vip", chat());
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("x-usage-plan"), "premium");
      assert.equal(r.headers.get("x-usage-remaining"), "unlimited");
    }
    assert.equal(ctx.db.read("vip").usageCount, undefined, "nothing is counted for premium");
    const lapsed = [];
    for (let i = 0; i < 4; i += 1) lapsed.push((await post(base, "/api/chat", "tok-lapsed", chat())).status);
    assert.deepEqual(lapsed, [200, 200, 429, 429]);
  }, { env: { FREE_DAILY_LIMIT: "2" }, documents: { "users/vip": { plan: "premium", premiumUntil: FUTURE }, "users/lapsed": { plan: "premium", premiumUntil: PAST } } });
});

// ---- what every response carries ---------------------------------------------------------------------------------------------

test("every AI response says how many requests are left: headers on all, 'quota' in JSON, in the stream's final event", async () => {
  await withServer(async (base) => {
    const first = await post(base, "/api/chat", "tok-alice", chat());
    assert.equal(first.headers.get("x-usage-plan"), "free");
    assert.equal(first.headers.get("x-usage-limit"), "5");
    assert.equal(first.headers.get("x-usage-remaining"), "4");
    assert.equal(Date.parse(first.headers.get("x-usage-reset")) > Date.now(), true);
    const json = await first.json();
    assert.deepEqual([json.quota.remaining, json.quota.limit, json.quota.premium], [4, 5, false]);
    assert.equal(json.reply, "hi");

    const stream = await post(base, "/api/chat/stream", "tok-alice", chat());
    assert.equal(stream.headers.get("x-usage-remaining"), "3");
    const text = await stream.text();
    const done = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).filter((l) => l !== "[DONE]").map((l) => JSON.parse(l)).find((e) => e.type === "done");
    assert.equal(done.quota.remaining, 3);
    assert.equal(json.usage.inputTokens, 1, "the provider's token usage field is unchanged");
  }, { env: { FREE_DAILY_LIMIT: "5" } });
});

test("the headers are exposed to the page even when it comes from another origin (desktop app)", async () => {
  await withServer(async (base) => {
    const r = await post(base, "/api/chat", "tok-alice", chat(), { Origin: "http://localhost:3000" });
    const exposed = (r.headers.get("access-control-expose-headers") || "").toLowerCase();
    ["x-usage-plan", "x-usage-limit", "x-usage-remaining", "x-usage-reset"].forEach((h) => assert.ok(exposed.includes(h), h));
  });
});

test("GET /api/usage: needs a sign-in, shows plan and today's numbers, counts nothing", async () => {
  await withServer(async (base, ctx) => {
    assert.equal((await fetch(base + "/api/usage")).status, 401);
    await post(base, "/api/chat", "tok-alice", chat());
    await post(base, "/api/chat", "tok-alice", chat());
    const r = await fetch(base + "/api/usage", { headers: { Authorization: "Bearer tok-alice" } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual([body.plan, body.premium, body.limit, body.used, body.remaining], ["free", false, 5, 2, 3]);
    assert.equal(body.priceLabel, "Coming soon");
    assert.equal(body.contactUrl, "https://t.me/linguahub_support");
    assert.equal(ctx.db.read("alice").usageCount, 2);
    const vip = await (await fetch(base + "/api/usage", { headers: { Authorization: "Bearer tok-vip" } })).json();
    assert.deepEqual([vip.plan, vip.premium, vip.limit, vip.remaining], ["premium", true, null, null]);
    assert.ok(vip.premiumUntil);
  }, { env: { FREE_DAILY_LIMIT: "5", PREMIUM_CONTACT_URL: "https://t.me/linguahub_support" }, documents: { "users/vip": { plan: "premium", premiumUntil: FUTURE } } });
});

// ---- the gate with a clock: midnight in Tashkent, end to end through Express ------------------------------------------------

test("through the gate: refused before Tashkent midnight, served after it", async () => {
  const db = createFakeFirestore({ "users/u1": { usageDate: "2026-03-10", usageCount: 2 } });
  let now = new Date("2026-03-10T18:59:30Z");
  const gate = createAiGate({ getAdmin: () => ({ getFirestore: () => db }), limit: 2, now: () => now, logger: { warn() {}, error() {} } });
  const app = express();
  app.use(express.json());
  app.post("/ai", (req, res, next) => { req.user = { uid: "u1" }; next(); }, gate.usageGate, (req, res) => res.json({ ok: true, quota: gate.quotaFor(req) }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const base = "http://127.0.0.1:" + server.address().port;
    const before = await fetch(base + "/ai", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(before.status, 429);
    assert.equal((await before.json()).resetAt, "2026-03-10T19:00:00.000Z");
    now = new Date("2026-03-10T19:00:01Z");
    const after = await fetch(base + "/ai", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(after.status, 200);
    assert.equal((await after.json()).quota.remaining, 1);
    assert.equal(usage.dayKey(now), "2026-03-11");
  } finally { await new Promise((r) => { server.close(r); server.closeAllConnections && server.closeAllConnections(); }); }
});

// ---- no way around it ------------------------------------------------------------------------------------------------------

test("structure: every route that reaches the AI provider is built with aiChain, and the provider is never called anywhere else", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const code = source.split(/\r?\n/).filter((l) => !l.trim().startsWith("//")).join("\n");
  const routes = [];
  code.replace(/app\.(?:post|get|put|patch|delete|all)\(\s*("[^"]+")([\s\S]*?)\);\s*\n/g, (m, route, rest) => { routes.push({ route: route.slice(1, -1), rest }); return m; });
  const ai = routes.filter((r) => /handleChat|handleChatStream|handleTranscribe/.test(r.rest));
  assert.deepEqual(ai.map((r) => r.route).sort(), ["/api/chat", "/api/chat/stream", "/api/transcribe", "/chat"]);
  ai.forEach((r) => assert.match(r.rest, /aiChain\(/, r.route + " uses the shared gate"));
  assert.match(code, /function aiChain\(\.\.\.limiters\) \{\s*return \[authenticateRequired, \.\.\.limiters, aiGate\.usageGate\];/, "sign-in first, then the speed limits, then the day's allowance");
  const providerCalls = code.match(/openai\.(chat|audio)\.[a-z.]+\.create\(/g) || [];
  assert.equal(providerCalls.length, 2, "server.js calls the provider only in handleChat and handleChatStream");
  const transcribeSource = fs.readFileSync(path.join(__dirname, "..", "lib", "transcribe.js"), "utf8");
  assert.equal((transcribeSource.match(/openai\.audio\.transcriptions\.create\(/g) || []).length, 1, "and transcription's single call sits behind /api/transcribe (aiChain)");
  assert.doesNotMatch(code, /authenticateOptional,[^)]*handleChat/, "no AI route is guest-accessible any more");
  const tryRoute = routes.find((r) => r.route === "/api/try-correct");
  assert.ok(tryRoute && /tryLimiter/.test(tryRoute.rest) && !/aiChain/.test(tryRoute.rest), "the landing demo stays IP-limited and sign-in free");
  assert.ok(fs.readFileSync(path.join(__dirname, "..", "lib", "tryCorrect.js"), "utf8").includes("openai.chat.completions.create"), "it is the one other provider call, and it is the IP-limited demo");
});

test("structure: usage is never kept in memory - the gate holds no counters", () => {
  const gate = fs.readFileSync(path.join(__dirname, "..", "lib", "aiGate.js"), "utf8");
  const usageSource = fs.readFileSync(path.join(__dirname, "..", "lib", "usage.js"), "utf8");
  for (const source of [gate, usageSource]) {
    const code = source.split(/\r?\n/).filter((l) => !l.trim().startsWith("//")).join("\n");
    assert.doesNotMatch(code, /new Map\(|new Set\(|createMemoryLimiter|MemoryStore/, "no in-memory state");
  }
  assert.match(usageSource, /db\.runTransaction/, "counted inside a Firestore transaction");
});

// ---- configuration ----------------------------------------------------------------------------------------------------------

test("env: FREE_DAILY_LIMIT defaults to 10 and is validated; paywall texts have safe defaults; only https contact links are kept", () => {
  assert.equal(validateEnv({}).freeDailyLimit, 10);
  assert.equal(validateEnv({ FREE_DAILY_LIMIT: "25" }).freeDailyLimit, 25);
  for (const bad of ["0", "-3", "abc", "2.5"]) {
    const r = validateEnv({ FREE_DAILY_LIMIT: bad });
    assert.equal(r.ok, false, bad);
    assert.match(r.errors.join(" "), /FREE_DAILY_LIMIT/);
  }
  assert.equal(validateEnv({}).premiumPriceLabel, "Coming soon");
  assert.equal(validateEnv({ PREMIUM_PRICE_LABEL: "  $4.99 / month " }).premiumPriceLabel, "$4.99 / month");
  assert.equal(validateEnv({ PREMIUM_PRICE_LABEL: "x".repeat(200) }).premiumPriceLabel.length, 60);
  assert.equal(validateEnv({}).premiumContactUrl, null);
  assert.equal(validateEnv({ PREMIUM_CONTACT_URL: "https://t.me/linguahub_support" }).premiumContactUrl, "https://t.me/linguahub_support");
  for (const bad of ["javascript:alert(1)", "http://t.me/x", "t.me/x", "data:text/html,hi", "not a url", "ftp://x.example"]) {
    const r = validateEnv({ PREMIUM_CONTACT_URL: bad });
    assert.equal(r.premiumContactUrl, null, bad);
    assert.ok(r.warnings.some((w) => /PREMIUM_CONTACT_URL/.test(w)), bad);
  }
});
