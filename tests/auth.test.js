"use strict";

// Backend Firebase-auth tests. Firebase Admin verification is mocked here
// via require.cache substitution (no real Firebase project/credentials are
// available in this environment) - production code always calls the real
// firebase-admin SDK (see lib/firebaseAdmin.js). Mocking is test-only.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-test-placeholder-not-a-real-key";
process.env.RATE_LIMIT_MAX_REQUESTS = process.env.RATE_LIMIT_MAX_REQUESTS || "1000";

const firebaseAdminPath = require.resolve("../lib/firebaseAdmin.js");
const authMiddlewarePath = require.resolve("../middleware/auth.js");
const serverPath = require.resolve("../server.js");

const VALID_TOKEN = "mock-valid-token";
const RAW_ERROR_FRAGMENT = "internal-firebase-detail-should-never-reach-the-client";
const MOCK_CLAIMS = {
  uid: "mock-uid-123",
  email: "mockuser@example.com",
  name: "Mock User",
  picture: "https://example.com/avatar.png",
  email_verified: true
};

function installMockFirebaseAdmin() {
  require.cache[firebaseAdminPath] = {
    id: firebaseAdminPath,
    filename: firebaseAdminPath,
    loaded: true,
    exports: {
      isConfigured: () => true,
      async verifyIdToken(idToken) {
        if (idToken === VALID_TOKEN) {
          return Object.assign({}, MOCK_CLAIMS);
        }
        const error = new Error(`Decoding Firebase ID token failed: ${RAW_ERROR_FRAGMENT}`);
        error.code = "auth/argument-error";
        throw error;
      }
    }
  };
}

let server;
let baseUrl;

before(async () => {
  installMockFirebaseAdmin();
  delete require.cache[authMiddlewarePath];
  delete require.cache[serverPath];
  const app = require("../server.js");
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  delete require.cache[serverPath];
  delete require.cache[authMiddlewarePath];
  delete require.cache[firebaseAdminPath];
});

test("GET /api/auth/me without a token returns 401", async () => {
  const res = await fetch(`${baseUrl}/api/auth/me`);
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.match(body.reply, /authentication required/i);
});

test("GET /api/auth/me with a malformed Authorization header returns 401", async () => {
  const res = await fetch(`${baseUrl}/api/auth/me`, { headers: { Authorization: "Token abc" } });
  assert.equal(res.status, 401);
});

test("GET /api/auth/me with an invalid token returns 401 and never leaks the raw Firebase error", async () => {
  const res = await fetch(`${baseUrl}/api/auth/me`, { headers: { Authorization: "Bearer not-a-real-token" } });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.doesNotMatch(JSON.stringify(body), new RegExp(RAW_ERROR_FRAGMENT));
});

test("GET /api/auth/me with a valid mocked token returns the identity derived from the verified token", async () => {
  const res = await fetch(`${baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${VALID_TOKEN}` } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.user.uid, MOCK_CLAIMS.uid);
  assert.equal(body.user.email, MOCK_CLAIMS.email);
  assert.equal(body.user.name, MOCK_CLAIMS.name);
  assert.equal(body.user.picture, MOCK_CLAIMS.picture);
  assert.equal(body.user.emailVerified, true);
  assert.equal(JSON.stringify(body).includes(VALID_TOKEN), false, "response must never echo back the raw token");
});

test("frontend-supplied identity (query params) is ignored - uid always comes from the verified token", async () => {
  const res = await fetch(`${baseUrl}/api/auth/me?uid=attacker-controlled-uid&role=admin`, {
    headers: { Authorization: `Bearer ${VALID_TOKEN}` }
  });
  const body = await res.json();
  assert.equal(body.user.uid, MOCK_CLAIMS.uid);
  assert.notEqual(body.user.uid, "attacker-controlled-uid");
});

test("chat route (optional auth) accepts a request carrying a valid token without changing the existing validation contract", async () => {
  const res = await fetch(`${baseUrl}/api/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${VALID_TOKEN}` },
    body: JSON.stringify({ message: "" })
  });
  assert.equal(res.status, 400);
});

test("chat route (optional auth) still works as a guest even with a garbage token (fails open, not 401)", async () => {
  const res = await fetch(`${baseUrl}/api/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer garbage-token" },
    body: JSON.stringify({ message: "" })
  });
  assert.equal(res.status, 400);
});

test("SPA/static fallback does not intercept /api/auth/me", async () => {
  const res = await fetch(`${baseUrl}/api/auth/me`);
  const contentType = res.headers.get("content-type") || "";
  assert.match(contentType, /application\/json/);
});

test("CORS preflight for /api/auth/me allows the Authorization header", async () => {
  const res = await fetch(`${baseUrl}/api/auth/me`, {
    method: "OPTIONS",
    headers: {
      Origin: "http://127.0.0.1:5500",
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "Authorization"
    }
  });
  assert.equal(res.status, 204);
  assert.match(res.headers.get("access-control-allow-headers") || "", /Authorization/i);
});

test("CORS still rejects an unconfigured origin on the auth route", async () => {
  const res = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Origin: "http://evil.example.com", Authorization: `Bearer ${VALID_TOKEN}` }
  });
  assert.equal(res.status, 403);
});

test("health endpoint remains public and unauthenticated", async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
});

test("required auth route fails clearly with 503 when Firebase Admin is not configured, without crashing guest routes", async () => {
  // Isolated app instance simulating a deployment with no Firebase Admin
  // credentials set (this project's actual current state - see docs).
  require.cache[firebaseAdminPath] = {
    id: firebaseAdminPath,
    filename: firebaseAdminPath,
    loaded: true,
    exports: {
      isConfigured: () => false,
      async verifyIdToken() {
        const error = new Error("Firebase Admin is not configured.");
        error.code = "auth/admin-not-configured";
        throw error;
      }
    }
  };
  delete require.cache[authMiddlewarePath];
  delete require.cache[serverPath];
  const unconfiguredApp = require("../server.js");
  const unconfiguredServer = http.createServer(unconfiguredApp);
  await new Promise((resolve) => unconfiguredServer.listen(0, "127.0.0.1", resolve));
  const { port } = unconfiguredServer.address();
  const unconfiguredBaseUrl = `http://127.0.0.1:${port}`;

  try {
    const meRes = await fetch(`${unconfiguredBaseUrl}/api/auth/me`, {
      headers: { Authorization: "Bearer anything" }
    });
    assert.equal(meRes.status, 503);

    // Guest chat must still work even though Admin isn't configured.
    const chatRes = await fetch(`${unconfiguredBaseUrl}/api/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "" })
    });
    assert.equal(chatRes.status, 400);

    const healthRes = await fetch(`${unconfiguredBaseUrl}/health`);
    assert.equal(healthRes.status, 200);
  } finally {
    await new Promise((resolve) => unconfiguredServer.close(resolve));
    // Restore the configured mock for any tests that run after this one.
    installMockFirebaseAdmin();
    delete require.cache[authMiddlewarePath];
    delete require.cache[serverPath];
  }
});
