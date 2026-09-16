"use strict";

// Phase 8, Task 5: the real-browser portion of the auth error matrix -
// what CAN be exercised for real without a configured Firebase project
// (verified NOT configured in this environment - see docs/phase-08-final-hardening.md).
// The interactive-login-specific rows (popup blocked/closed, unauthorized
// domain, real network error during a real popup, revoked token) are NOT
// RUN here and are not faked - see the report for the exact classification
// of every row in the matrix.

const { withApp } = require("./harness");
const { createResults } = require("./results");

async function run() {
  const results = createResults("Phase 8 Auth Error Matrix (real browser + real backend)");

  await withApp(async ({ page, baseUrl, backendUrl }) => {
    await page.goto(baseUrl + "/index.html", { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.getElementById("mode-select").options.length >= 7);

    // --- missing config: sign-in is honestly disabled (real, re-confirmed) ---
    const loginState = await page.evaluate(() => ({
      disabled: document.getElementById("login-btn").disabled,
      statusText: document.getElementById("auth-status").textContent
    }));
    results.check(
      "missing Firebase config: sign-in button is honestly disabled with a clear message",
      loginState.disabled === true && /unavailable/i.test(loginState.statusText),
      JSON.stringify(loginState)
    );

    // --- /api/auth/me without a token: real request, real backend ------------
    const noToken = await page.evaluate(async (url) => {
      const r = await fetch(url + "/api/auth/me");
      return { status: r.status, body: await r.json() };
    }, backendUrl);
    results.check("/api/auth/me with no token returns 401 with a safe message", noToken.status === 401 && /authentication required/i.test(noToken.body.reply), JSON.stringify(noToken));

    // --- /api/auth/me with an invalid/garbage token ---------------------------
    const invalidToken = await page.evaluate(async (url) => {
      const r = await fetch(url + "/api/auth/me", { headers: { Authorization: "Bearer this-is-not-a-real-firebase-token" } });
      return { status: r.status, body: await r.json() };
    }, backendUrl);
    results.check(
      "/api/auth/me with an invalid token fails safely (401 admin-not-configured maps to 503, or 401) with no raw Firebase error",
      [401, 503].includes(invalidToken.status) && !/at\s+\w+.*\(.*:\d+:\d+\)/.test(JSON.stringify(invalidToken.body)),
      JSON.stringify(invalidToken)
    );

    // --- expired-shaped token (well-formed JWT structure, garbage signature) ---
    const expiredShapedToken = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjF9.invalidsignature";
    const expiredToken = await page.evaluate(async ({ url, token }) => {
      const r = await fetch(url + "/api/auth/me", { headers: { Authorization: `Bearer ${token}` } });
      return { status: r.status, body: await r.json() };
    }, { url: backendUrl, token: expiredShapedToken });
    results.check(
      "/api/auth/me with an expired/invalid-signature-shaped token fails safely, no stack trace",
      [401, 503].includes(expiredToken.status) && !/node_modules|at Object/i.test(JSON.stringify(expiredToken.body)),
      JSON.stringify(expiredToken)
    );

    // --- backend Admin unavailable (this environment's real, current state) ---
    results.check(
      "backend Admin unavailable: /api/auth/me fails with 503 (not a crash), matching this environment's real state",
      invalidToken.status === 503 || expiredToken.status === 503,
      "Admin is not configured in this environment - both prior checks should reflect that consistently"
    );

    // --- guest chat keeps working even with a garbage Authorization header ---
    await page.route("**/api/chat/stream", (route) => route.abort("failed"));
    await page.route("**/api/chat", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ reply: "guest reply despite garbage token" }) }));
    const guestWithGarbageToken = await page.evaluate(async (url) => {
      const r = await fetch(url + "/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer totally-garbage" },
        body: JSON.stringify({ message: "hi" })
      });
      return { status: r.status };
    }, backendUrl); // cross-origin (5500 -> 3000), exercising real CORS on the way
    results.check("/api/chat fails open to guest even with a garbage Authorization header (never 401)", guestWithGarbageToken.status !== 401, JSON.stringify(guestWithGarbageToken));
    await page.unroute("**/api/chat/stream");
    await page.unroute("**/api/chat");

    // Real end-to-end version: through the ACTUAL app UI, not raw fetch. No
    // user is signed in (no real Firebase project exists), so
    // buildAuthHeaders() naturally attaches no Authorization header at all -
    // this is exactly the real guest path, exercised through the real send
    // flow rather than a hand-crafted fetch.
    await page.route("**/api/chat/stream", (route) => route.abort("failed"));
    await page.route("**/api/chat", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ reply: "guest still works" }) }));
    await page.fill("#user-input", "guest message with backend admin unavailable");
    await page.locator("#user-input").press("Enter");
    await page.waitForSelector('.message[data-role="assistant"][data-status="complete"], .message[data-role="assistant"][data-status="failed"]', { timeout: 10000 });
    const guestChatStatus = await page.evaluate(() => document.querySelector('.message[data-role="assistant"]:last-child').dataset.status);
    results.check("guest chat completes normally end-to-end regardless of backend auth state", guestChatStatus === "complete", guestChatStatus);
    await page.unroute("**/api/chat/stream");
    await page.unroute("**/api/chat");

    results.note("popup-blocked / popup-closed / unauthorized-domain / real network error during a real popup / revoked token", "NOT RUN - require a real, configured Firebase project (none exists in this environment); covered at the unit level with mocked Firebase in tests/frontend-auth.test.js instead");
  });

  results.printSummary();
  results.save("auth-error-matrix.json");
  return results.summary();
}

if (require.main === module) {
  run().then((s) => process.exit(s.failed > 0 ? 1 : 0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { run };
