"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

// High enough that the handful of chat-route requests made by the
// functional tests below never trip it; the dedicated rate-limit test
// spins up its own isolated server instance with a low limit instead.
process.env.RATE_LIMIT_MAX_REQUESTS = process.env.RATE_LIMIT_MAX_REQUESTS || "1000";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-test-placeholder-not-a-real-key";

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
});

test("GET /health returns 200 with a safe JSON body", async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "ok");
  assert.equal(body.service, "linguahub-ai");
  assert.ok(body.timestamp);
  const asString = JSON.stringify(body);
  assert.doesNotMatch(asString, /sk-/, "health response must never leak an API key");
});

test("POST /api/chat/stream exists and rejects an empty message with 400 JSON (not 404/405)", async () => {
  const res = await fetch(`${baseUrl}/api/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "" })
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.reply, /message is required/i);
});

test("POST /api/chat/stream rejects a missing body with 400 JSON", async () => {
  const res = await fetch(`${baseUrl}/api/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({})
  });
  assert.equal(res.status, 400);
});

test("POST /api/chat/stream rejects an oversized message with 400 JSON", async () => {
  const res = await fetch(`${baseUrl}/api/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "a".repeat(9000) })
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.reply, /too long/i);
});

test("malformed JSON body returns 400 JSON via the centralized error handler, not an HTML stack trace", async () => {
  const res = await fetch(`${baseUrl}/api/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not valid json"
  });
  assert.equal(res.status, 400);
  const contentType = res.headers.get("content-type") || "";
  assert.match(contentType, /application\/json/);
  const body = await res.json();
  assert.doesNotMatch(JSON.stringify(body), /at Object|\.js:\d+:\d+/, "response must not contain a raw stack trace");
});

test("GET on the POST-only chat stream route does not crash and does not return HTML", async () => {
  const res = await fetch(`${baseUrl}/api/chat/stream`, { method: "GET" });
  assert.equal(res.status, 404);
  const contentType = res.headers.get("content-type") || "";
  assert.match(contentType, /application\/json/);
});

test("unmatched /api/* route returns a safe JSON 404, not the SPA/static fallback", async () => {
  const res = await fetch(`${baseUrl}/api/does-not-exist`);
  assert.equal(res.status, 404);
  const contentType = res.headers.get("content-type") || "";
  assert.match(contentType, /application\/json/);
});

test("legacy POST /chat route still works for backward compatibility", async () => {
  const res = await fetch(`${baseUrl}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "" })
  });
  assert.equal(res.status, 400);
});

test("CORS allows a configured dev frontend origin", async () => {
  const res = await fetch(`${baseUrl}/health`, {
    headers: { Origin: "http://127.0.0.1:5500" }
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "http://127.0.0.1:5500");
});

test("CORS blocks an unrecognized origin with a safe 403 JSON response", async () => {
  const res = await fetch(`${baseUrl}/health`, {
    headers: { Origin: "http://evil.example.com" }
  });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.match(body.reply, /origin not allowed/i);
});

test("rate limiting kicks in after too many requests from the same client", async () => {
  // Isolated app instance/port with a low limit so this test doesn't share
  // rate-limiter state with the functional tests above.
  const serverPath = require.resolve("../server.js");
  delete require.cache[serverPath];
  const previousLimit = process.env.RATE_LIMIT_MAX_REQUESTS;
  process.env.RATE_LIMIT_MAX_REQUESTS = "3";
  const limitedApp = require("../server.js");
  process.env.RATE_LIMIT_MAX_REQUESTS = previousLimit;

  const limitedServer = http.createServer(limitedApp);
  await new Promise((resolve) => limitedServer.listen(0, "127.0.0.1", resolve));
  const { port } = limitedServer.address();
  const limitedBaseUrl = `http://127.0.0.1:${port}`;

  try {
    const attempts = 6;
    const statuses = [];
    for (let i = 0; i < attempts; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(`${limitedBaseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "" })
      });
      statuses.push(res.status);
    }
    assert.ok(statuses.includes(429), `expected at least one 429 among ${statuses.join(",")}`);
  } finally {
    await new Promise((resolve) => limitedServer.close(resolve));
    delete require.cache[serverPath];
  }
});
