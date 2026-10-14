"use strict";

// Phase 5, step 0: POST /api/transcribe - limits, validation, provider call, rate limit.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const T = require("../lib/transcribe.js");

const audio = (n) => Buffer.alloc(n, 1);

test("validateUpload: accepts audio containers (with codec parameters) and picks the file name", () => {
  const ok = T.validateUpload({ contentType: "audio/webm;codecs=opus", body: audio(5000), language: "uz" });
  assert.deepEqual(ok, { ok: true, fileName: "speech.webm", language: "uz" });
  assert.equal(T.validateUpload({ contentType: "Audio/MP4", body: audio(5000) }).fileName, "speech.mp4");
  assert.equal(T.validateUpload({ contentType: "audio/ogg; codecs=opus", body: audio(5000) }).ok, true);
  assert.equal(T.validateUpload({ contentType: "audio/webm", body: audio(5000), language: "" }).language, undefined, "auto-detect");
});

test("validateUpload: rejects other types, empty, tiny and oversize bodies, and unknown languages", () => {
  assert.equal(T.validateUpload({ contentType: "application/json", body: audio(5000) }).status, 415);
  assert.equal(T.validateUpload({ contentType: "text/plain", body: audio(5000) }).status, 415);
  assert.equal(T.validateUpload({ contentType: undefined, body: audio(5000) }).status, 415);
  assert.equal(T.validateUpload({ contentType: "audio/webm", body: Buffer.alloc(0) }).status, 400);
  assert.equal(T.validateUpload({ contentType: "audio/webm", body: {} }).status, 400);
  assert.equal(T.validateUpload({ contentType: "audio/webm", body: audio(T.MIN_AUDIO_BYTES - 1) }).status, 422);
  assert.equal(T.validateUpload({ contentType: "audio/webm", body: audio(T.MAX_AUDIO_BYTES + 1) }).status, 413);
  assert.equal(T.validateUpload({ contentType: "audio/webm", body: audio(T.MAX_AUDIO_BYTES) }).ok, true, "the limit itself is allowed");
  assert.equal(T.validateUpload({ contentType: "audio/webm", body: audio(5000), language: "xx" }).status, 400);
  assert.equal(T.validateUpload({ contentType: "audio/webm", body: audio(5000), language: "en-US-with-long-tail" }).status, 400);
  assert.ok(T.MAX_AUDIO_BYTES <= 4.5 * 1024 * 1024, "stays under the serverless request-size limit");
});

function fakeRes() {
  const res = { statusCode: 200, body: null, status(c) { res.statusCode = c; return res; }, json(b) { res.body = b; return res; } };
  return res;
}

function handler(create, logs) {
  const logger = { info: (m, f) => logs && logs.push(["info", m, f]), error: (m, f) => logs && logs.push(["error", m, f]) };
  const openai = { audio: { transcriptions: { create } } };
  return T.createTranscribeHandler({ openai, toFile: async (buf, name) => ({ buf, name }), logger });
}

test("handler: sends the clip and language to the provider and returns cleaned text", async () => {
  const seen = [];
  const h = handler(async (params, opts) => { seen.push([params, opts]); return { text: "  Hello \n  there  " }; });
  const res = fakeRes();
  await h({ headers: { "content-type": "audio/webm;codecs=opus" }, body: audio(4000), query: { lang: "en" }, id: "r1" }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { text: "Hello there" });
  assert.equal(seen[0][0].model, "whisper-1");
  assert.equal(seen[0][0].language, "en");
  assert.equal(seen[0][0].file.name, "speech.webm");
  assert.equal(seen[0][0].file.buf.length, 4000);
  assert.ok(seen[0][1].timeout > 0, "the provider call is time-limited");
});

test("handler: no language -> auto-detect; very long text is cut", async () => {
  const seen = [];
  const h = handler(async (params) => { seen.push(params); return { text: "x".repeat(5000) }; });
  const res = fakeRes();
  await h({ headers: { "content-type": "audio/ogg" }, body: audio(4000), query: {} }, res);
  assert.equal("language" in seen[0], false);
  assert.equal(res.body.text.length, 2000);
});

test("handler: invalid uploads never reach the provider", async () => {
  let called = 0;
  const h = handler(async () => { called += 1; return { text: "x" }; });
  for (const req of [
    { headers: { "content-type": "application/json" }, body: audio(4000), query: {} },
    { headers: { "content-type": "audio/webm" }, body: audio(10), query: {} },
    { headers: { "content-type": "audio/webm" }, body: audio(4000), query: { lang: "zz" } },
    { headers: { "content-type": "audio/webm" }, body: undefined, query: {} }
  ]) {
    const res = fakeRes();
    await h(req, res);
    assert.ok(res.statusCode >= 400);
    assert.equal(res.body.text, "");
  }
  assert.equal(called, 0);
});

test("handler: provider failures give a safe message - no provider details, never the key - and are logged without content", async () => {
  const logs = [];
  const h = handler(async () => { const e = new Error("secret detail sk-123 from provider"); e.status = 500; throw e; }, logs);
  const res = fakeRes();
  await h({ headers: { "content-type": "audio/webm" }, body: audio(4000), query: {}, id: "r9" }, res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.text, "");
  assert.doesNotMatch(JSON.stringify(res.body), /sk-123|secret detail/);
  assert.equal(res.body.requestId, "r9");
  assert.doesNotMatch(JSON.stringify(logs), /sk-123|secret detail/);

  const bad = handler(async () => { const e = new Error("x"); e.status = 401; throw e; });
  const res2 = fakeRes();
  await bad({ headers: { "content-type": "audio/webm" }, body: audio(4000), query: {} }, res2);
  assert.match(res2.body.reply, /Invalid OpenAI API key/);
});

test("handler: logs size and outcome only - never the transcript", async () => {
  const logs = [];
  const h = handler(async () => ({ text: "my private sentence" }), logs);
  await h({ headers: { "content-type": "audio/webm" }, body: audio(4000), query: {}, id: "r2" }, fakeRes());
  assert.doesNotMatch(JSON.stringify(logs), /private sentence/);
  assert.equal(logs[0][2].bytes, 4000);
});

// ---- through the real app (validation paths never reach the provider) ---------------------------------------

async function withServer(fn, env) {
  const saved = {};
  Object.keys(env || {}).forEach((k) => { saved[k] = process.env[k]; process.env[k] = env[k]; });
  delete require.cache[require.resolve("../server.js")];
  const app = require("../server.js");
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try { await fn("http://127.0.0.1:" + server.address().port); }
  finally {
    await new Promise((r) => { server.close(r); server.closeAllConnections && server.closeAllConnections(); });
    Object.keys(saved).forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
    delete require.cache[require.resolve("../server.js")];
  }
}

test("route: wrong type, too small and too large are refused with safe JSON", async () => {
  await withServer(async (base) => {
    const post = (type, body, query) => fetch(base + "/api/transcribe" + (query || ""), { method: "POST", headers: { "Content-Type": type }, body });
    let r = await post("application/json", "{}");
    assert.equal(r.status, 415);
    r = await post("audio/webm", Buffer.alloc(10, 1));
    assert.equal(r.status, 422);
    assert.equal((await r.json()).text, "");
    r = await post("audio/webm", Buffer.alloc(4000, 1), "?lang=zz");
    assert.equal(r.status, 400);
    r = await post("audio/webm", Buffer.alloc(T.MAX_AUDIO_BYTES + 1024, 1));
    assert.equal(r.status, 413);
    assert.deepEqual(Object.keys(await r.json()).sort(), ["reply", "requestId"]);
  });
});

test("route: has its own rate limit (TRANSCRIBE_RATE_LIMIT_MAX_REQUESTS) and answers 429 with Retry-After", async () => {
  await withServer(async (base) => {
    const statuses = [];
    for (let i = 0; i < 4; i += 1) {
      const r = await fetch(base + "/api/transcribe", { method: "POST", headers: { "Content-Type": "audio/webm" }, body: Buffer.alloc(10, 1) });
      statuses.push(r.status);
      if (r.status === 429) assert.ok(Number(r.headers.get("retry-after")) > 0);
    }
    assert.deepEqual(statuses, [422, 422, 429, 429]);
  }, { TRANSCRIBE_RATE_LIMIT_MAX_REQUESTS: "2" });
});

test("route: the chat limiter budget is separate (transcribing does not use up chat requests)", async () => {
  await withServer(async (base) => {
    for (let i = 0; i < 4; i += 1) await fetch(base + "/api/transcribe", { method: "POST", headers: { "Content-Type": "audio/webm" }, body: Buffer.alloc(10, 1) });
    const chat = await fetch(base + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [] }) });
    assert.equal(chat.status, 400, "validation error, not 429");
  }, { TRANSCRIBE_RATE_LIMIT_MAX_REQUESTS: "2" });
});

test("env: the transcription rate limit is validated like the others", () => {
  const { validateEnv } = require("../lib/env.js");
  assert.equal(validateEnv({}).transcribeRateLimitMaxRequests, 20);
  assert.equal(validateEnv({ TRANSCRIBE_RATE_LIMIT_MAX_REQUESTS: "5" }).transcribeRateLimitMaxRequests, 5);
  const bad = validateEnv({ TRANSCRIBE_RATE_LIMIT_MAX_REQUESTS: "abc" });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(" "), /TRANSCRIBE_RATE_LIMIT_MAX_REQUESTS/);
});
