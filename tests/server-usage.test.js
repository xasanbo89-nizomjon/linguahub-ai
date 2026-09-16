"use strict";

// Tests the authoritative provider-usage-metadata contract added to
// POST /api/chat and POST /api/chat/stream. Uses a fake "openai" module
// injected into Node's own require.cache before server.js is required -
// the same require.cache-reload technique tests/server.test.js's own
// rate-limit test already uses, extended so the fake module stands in for
// the real OpenAI SDK. This tests the REAL server.js route handlers end to
// end over real HTTP, with only the network-calling SDK replaced - not a
// reimplementation of the route logic.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

process.env.RATE_LIMIT_MAX_REQUESTS = process.env.RATE_LIMIT_MAX_REQUESTS || "1000";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-test-placeholder-not-a-real-key";

const openaiModulePath = require.resolve("openai");
const serverModulePath = require.resolve("../server.js");

// Swapped per-test via setBehavior() below - the fake module reads this
// live on every call, so each test can point it at a different canned
// response without re-requiring the module.
let behavior = null;

function setBehavior(next) {
  behavior = next;
}

function FakeOpenAI() {
  this.chat = {
    completions: {
      create(params) {
        if (params.stream) return behavior.stream(params);
        return behavior.nonStream(params);
      }
    }
  };
}

async function* asyncIterableOf(items) {
  for (const item of items) yield item;
}

before(() => {
  // Install the fake in place of the real "openai" package before server.js
  // (which does `const OpenAI = require("openai")` at module scope) is
  // required fresh.
  require.cache[openaiModulePath] = {
    id: openaiModulePath,
    filename: openaiModulePath,
    loaded: true,
    exports: FakeOpenAI
  };
  delete require.cache[serverModulePath];
});

let server;
let baseUrl;

before(async () => {
  const app = require("../server.js");
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  // Restore real modules so any OTHER test file that happens to run in this
  // same process afterward gets the real "openai" package and a fresh
  // server.js, not this file's fake.
  delete require.cache[openaiModulePath];
  delete require.cache[serverModulePath];
});

async function readSSE(res) {
  const text = await res.text();
  return text
    .split("\n\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
}

// ---------------------------------------------------------------------
// POST /api/chat (non-streaming)
// ---------------------------------------------------------------------

test("POST /api/chat: 'reply' remains present and unchanged in shape (backward compatibility)", async () => {
  setBehavior({
    nonStream: async () => ({
      model: "gpt-4.1-mini-2025-04-14",
      choices: [{ message: { content: "Hello there." } }],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }
    })
  });

  const res = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "hi" })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.reply, "Hello there.");
});

test("POST /api/chat: real usage metadata is mapped from the provider response - never estimated", async () => {
  setBehavior({
    nonStream: async () => ({
      model: "gpt-4.1-mini-2025-04-14",
      choices: [{ message: { content: "Hello there." } }],
      usage: { prompt_tokens: 42, completion_tokens: 17, total_tokens: 59 }
    })
  });

  const res = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "hi" })
  });
  const body = await res.json();
  assert.equal(body.model, "gpt-4.1-mini-2025-04-14");
  assert.deepEqual(body.usage, { inputTokens: 42, outputTokens: 17 });
});

test("POST /api/chat: model reflects the real provider-returned identifier, not the request's own configured mode.model string", async () => {
  // The provider is free to return a more specific dated snapshot than
  // what was requested - the response must reflect what OpenAI actually
  // used, not just echo back the request.
  setBehavior({
    nonStream: async () => ({
      model: "gpt-4.1-mini-2025-09-30-preview",
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    })
  });
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "hi" })
  });
  const body = await res.json();
  assert.equal(body.model, "gpt-4.1-mini-2025-09-30-preview");
});

test("POST /api/chat: usage is null (never fabricated 0/0) when the provider response genuinely has no usage field", async () => {
  setBehavior({
    nonStream: async () => ({
      model: "gpt-4.1-mini-2025-04-14",
      choices: [{ message: { content: "ok" } }]
      // no `usage` key at all - matches the SDK's own optional typing.
    })
  });

  const res = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "hi" })
  });
  const body = await res.json();
  assert.equal(body.usage, null);
  assert.notDeepEqual(body.usage, { inputTokens: 0, outputTokens: 0 }, "must never fake zero values");
});

test("POST /api/chat: a client-supplied model is still rejected outright (unchanged validation, model stays backend-only)", async () => {
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "hi", model: "gpt-4o" })
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.reply, /may not set: model/i);
});

test("POST /api/chat: no secret (API key, raw provider object, internal fields) is ever present in the response", async () => {
  setBehavior({
    nonStream: async () => ({
      model: "gpt-4.1-mini-2025-04-14",
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      // Realistic extra fields a real OpenAI response object carries -
      // must never leak into the client-facing JSON.
      id: "chatcmpl-real-internal-id",
      system_fingerprint: "fp_internal_abc123",
      _request_id: "req_internal_xyz"
    })
  });
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "hi" })
  });
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ["model", "reply", "usage"]);
  const asString = JSON.stringify(body);
  assert.doesNotMatch(asString, /sk-/, "must never leak an API-key-shaped string");
  assert.doesNotMatch(asString, /fp_internal|req_internal|chatcmpl-real-internal-id/, "must never leak raw provider internals");
});

// ---------------------------------------------------------------------
// POST /api/chat/stream
// ---------------------------------------------------------------------

test("POST /api/chat/stream: delta events remain in their exact existing shape", async () => {
  setBehavior({
    stream: () => asyncIterableOf([
      { model: "gpt-4.1-mini-2025-04-14", choices: [{ delta: { content: "Hel" } }], usage: null },
      { model: "gpt-4.1-mini-2025-04-14", choices: [{ delta: { content: "lo" } }], usage: null },
      { model: "gpt-4.1-mini-2025-04-14", choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }
    ])
  });

  const res = await fetch(`${baseUrl}/api/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "hi" })
  });
  const events = await readSSE(res);
  const deltaEvents = events.filter((e) => e !== "[DONE]" && JSON.parse(e).delta !== undefined);
  assert.deepEqual(deltaEvents.map((e) => JSON.parse(e)), [{ delta: "Hel" }, { delta: "lo" }]);
});

test("POST /api/chat/stream: [DONE] sentinel is still the final line (backward compatibility)", async () => {
  setBehavior({
    stream: () => asyncIterableOf([
      { model: "gpt-4.1-mini-2025-04-14", choices: [{ delta: { content: "hi" } }], usage: null },
      { model: "gpt-4.1-mini-2025-04-14", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
    ])
  });
  const res = await fetch(`${baseUrl}/api/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "hi" })
  });
  const events = await readSSE(res);
  assert.equal(events[events.length - 1], "[DONE]");
});

test("POST /api/chat/stream: a final 'done' metadata event is sent, with real model/usage, immediately before [DONE]", async () => {
  setBehavior({
    stream: () => asyncIterableOf([
      { model: "gpt-4.1-mini-2025-04-14", choices: [{ delta: { content: "hi" } }], usage: null },
      { model: "gpt-4.1-mini-2025-04-14", choices: [], usage: { prompt_tokens: 33, completion_tokens: 11, total_tokens: 44 } }
    ])
  });
  const res = await fetch(`${baseUrl}/api/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "hi" })
  });
  const events = await readSSE(res);
  assert.equal(events[events.length - 1], "[DONE]");
  const doneEvent = JSON.parse(events[events.length - 2]);
  assert.equal(doneEvent.type, "done");
  assert.equal(doneEvent.model, "gpt-4.1-mini-2025-04-14");
  assert.deepEqual(doneEvent.usage, { inputTokens: 33, outputTokens: 11 });
});

test("POST /api/chat/stream: usage is null in the done event (never fabricated) when the provider stream never sends a usage chunk", async () => {
  setBehavior({
    // Simulates an interrupted/older-behavior stream where the final
    // include_usage chunk never arrives - the SDK's own documented
    // possibility ("If the stream is interrupted... you may not receive
    // the final usage chunk").
    stream: () => asyncIterableOf([
      { model: "gpt-4.1-mini-2025-04-14", choices: [{ delta: { content: "partial" } }], usage: null }
    ])
  });
  const res = await fetch(`${baseUrl}/api/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "hi" })
  });
  const events = await readSSE(res);
  const doneEvent = JSON.parse(events[events.length - 2]);
  assert.equal(doneEvent.type, "done");
  assert.equal(doneEvent.usage, null);
  assert.notDeepEqual(doneEvent.usage, { inputTokens: 0, outputTokens: 0 }, "must never fake zero values");
});

test("POST /api/chat/stream: the create() call requests provider usage via stream_options.include_usage (the documented mechanism, not a guess)", async () => {
  let capturedParams = null;
  setBehavior({
    stream: (params) => {
      capturedParams = params;
      return asyncIterableOf([
        { model: "gpt-4.1-mini-2025-04-14", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
      ]);
    }
  });
  await fetch(`${baseUrl}/api/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "hi" })
  });
  assert.deepEqual(capturedParams.stream_options, { include_usage: true });
});

test("POST /api/chat/stream: no secret or raw provider internal field appears anywhere in the SSE stream", async () => {
  setBehavior({
    stream: () => asyncIterableOf([
      { model: "gpt-4.1-mini-2025-04-14", choices: [{ delta: { content: "hi" } }], usage: null, system_fingerprint: "fp_internal_zzz", id: "chatcmpl-internal-id" },
      { model: "gpt-4.1-mini-2025-04-14", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, system_fingerprint: "fp_internal_zzz" }
    ])
  });
  const res = await fetch(`${baseUrl}/api/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "hi" })
  });
  const raw = (await readSSE(res)).join("\n");
  assert.doesNotMatch(raw, /sk-/);
  assert.doesNotMatch(raw, /fp_internal|chatcmpl-internal-id/);
});

test("POST /api/chat/stream: a client-supplied model is still rejected outright before any provider call happens", async () => {
  const res = await fetch(`${baseUrl}/api/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "hi", model: "gpt-4o" })
  });
  assert.equal(res.status, 400);
});
