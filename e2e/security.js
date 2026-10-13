"use strict";

// Phase 7, Task 14: security QA in a real browser + source. Checks secret
// exposure, XSS/script-injection resistance in Markdown/imports, disabled
// modes being unforceable, and that CORS/CSP/Helmet stay active.

const fs = require("node:fs");
const path = require("node:path");
const { withApp, exportActiveConversation, importConversationFile } = require("./harness");
const { createResults } = require("./results");

function readSource(relPath) {
  return fs.readFileSync(path.join(__dirname, "..", relPath), "utf8");
}

async function run() {
  const results = createResults("Phase 7 Security QA");

  // --- Source checks: no secret ever lands in shipped frontend code --------
  const wwwFiles = fs.readdirSync(path.join(__dirname, "..", "www")).filter((f) => f.endsWith(".js"));
  let secretFound = null;
  for (const file of wwwFiles) {
    const src = readSource(path.join("www", file));
    if (/sk-[a-zA-Z0-9]{10,}/.test(src)) secretFound = `${file}: OpenAI-shaped key`;
    if (/-----BEGIN PRIVATE KEY-----/.test(src)) secretFound = `${file}: private key block`;
  }
  results.check("no OpenAI key or private key literal exists anywhere in www/*.js", !secretFound, secretFound || "clean");

  const serverSrc = readSource("server.js");
  results.check("server.js never sends process.env.OPENAI_API_KEY in a response body", !/res\.(json|send)\([^)]*OPENAI_API_KEY/.test(serverSrc));

  const aiModesSrc = readSource("lib/aiModes.js");
  results.check("toPublicMetadata()'s allowlist excludes systemPrompt/model/temperature/tools by construction", /id:\s*mode\.id[\s\S]{0,120}capability:\s*mode\.capability/.test(aiModesSrc));

  await withApp(async ({ page, baseUrl, backendUrl }) => {
    await page.goto(baseUrl + "/index.html", { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.getElementById("mode-select").options.length >= 7);

    // --- No secret reaches the browser at runtime -----------------------------
    const pageContent = await page.content();
    results.check("rendered page HTML contains no OpenAI-shaped key", !/sk-[a-zA-Z0-9]{10,}/.test(pageContent));

    const modesResponse = await page.evaluate(async (url) => {
      const r = await fetch(url + "/api/ai/modes");
      return r.text();
    }, backendUrl);
    results.check("GET /api/ai/modes response body has no system prompt, model name, or key", !/sk-|systemPrompt|gpt-4/i.test(modesResponse), modesResponse.slice(0, 200));

    // --- Disabled mode cannot be forced through the UI ------------------------
    let forcedSelection = null;
    try {
      await page.selectOption("#mode-select", "image", { timeout: 1000 });
      forcedSelection = await page.locator("#mode-select").inputValue();
    } catch (err) {
      forcedSelection = "rejected-by-browser";
    }
    results.check("a disabled mode (image) cannot be forced into the selector via the UI", forcedSelection !== "image", forcedSelection);

    // Even if a request is hand-crafted to bypass the UI entirely, the
    // backend must still refuse it (already covered by tests/ai-modes-request.test.js,
    // re-verified live here from the browser's own network stack).
    const disabledModeAttempt = await page.evaluate(async (url) => {
      const r = await fetch(url + "/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hi", mode: "image" })
      });
      return { status: r.status, body: await r.json() };
    }, backendUrl);
    results.check("backend rejects a hand-crafted request for a disabled mode (defense in depth)", disabledModeAttempt.status === 400, JSON.stringify(disabledModeAttempt));

    // --- A raw model override attempt is rejected, not silently honored ------
    const modelOverrideAttempt = await page.evaluate(async (url) => {
      const r = await fetch(url + "/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hi", mode: "general", model: "gpt-4o" })
      });
      return { status: r.status, body: await r.json() };
    }, backendUrl);
    results.check("a client-supplied model override is rejected with 400, not silently used", modelOverrideAttempt.status === 400, JSON.stringify(modelOverrideAttempt));

    // --- CORS: cannot be meaningfully tested from in-page fetch() - browsers
    // treat "Origin" as a forbidden header name and always send the page's
    // real origin regardless of what JS requests, so this can't simulate an
    // attacker's origin. Real CORS-rejection coverage (a raw Node fetch that
    // CAN set an arbitrary Origin) already exists and passes in
    // tests/server.test.js ("CORS blocks an unrecognized origin..."); not
    // duplicated here.
    results.note("CORS rejection of unrecognized origins", "verified in tests/server.test.js (Node-level fetch, not browser-restricted) - not re-testable from in-page JS");

    // --- CSP + Helmet headers present, read at the real network level --------
    // (NOT via in-page fetch().headers.get() - the Fetch API only exposes
    // CORS-safelisted response headers to page-context JS for a cross-origin
    // request, which excludes CSP/X-Content-Type-Options/X-Frame-Options
    // regardless of whether the server actually sent them, so that approach
    // would misreport "missing" even when the header is genuinely present
    // on the wire. Playwright's own response object sees every real header.)
    const healthResponse = await page.request.get(backendUrl + "/health");
    const cspResponse = healthResponse.headers()["content-security-policy"];
    results.check("Content-Security-Policy header is present", Boolean(cspResponse), cspResponse);
    results.check("CSP has no 'unsafe-inline' or 'unsafe-eval'", Boolean(cspResponse) && !/unsafe-inline|unsafe-eval/.test(cspResponse), cspResponse);

    const helmetHeaders = {
      xContentTypeOptions: healthResponse.headers()["x-content-type-options"],
      xFrameOrCsp: healthResponse.headers()["x-frame-options"] || (cspResponse || "").includes("frame-ancestors")
    };
    results.check("X-Content-Type-Options: nosniff is present", helmetHeaders.xContentTypeOptions === "nosniff", JSON.stringify(helmetHeaders));
    results.check("clickjacking protection present (X-Frame-Options or CSP frame-ancestors)", Boolean(helmetHeaders.xFrameOrCsp), JSON.stringify(helmetHeaders));

    // --- Markdown XSS resistance: script tags, event handlers, javascript: links ---
    const xssPayload = "<img src=x onerror=alert(1)>\n\n[click me](javascript:alert(2))\n\n<script>window.__xss=true;</script>\n\n<a href=\"javascript:alert(3)\">link</a>";
    await page.route("**/api/chat/stream", (route) => {
      route.fulfill({ status: 200, contentType: "text/event-stream", body: `data: ${JSON.stringify({ delta: xssPayload })}\n\ndata: [DONE]\n\n` });
    });
    await page.fill("#user-input", "xss test");
    await page.locator("#user-input").press("Enter");
    await page.waitForSelector('.message[data-role="assistant"][data-status="complete"]', { timeout: 10000 });
    await page.waitForTimeout(200);

    const xssResult = await page.evaluate(() => ({
      windowFlagSet: window.__xss === true,
      hasScriptTag: document.querySelectorAll(".message-content script").length,
      hasOnerrorAttr: Array.from(document.querySelectorAll(".message-content img")).some((img) => img.hasAttribute("onerror")),
      hasJsLinks: Array.from(document.querySelectorAll(".message-content a")).some((a) => (a.getAttribute("href") || "").startsWith("javascript:"))
    }));
    results.check("no <script> tag executes from Markdown-rendered content", !xssResult.windowFlagSet && xssResult.hasScriptTag === 0, JSON.stringify(xssResult));
    results.check("no onerror/event-handler attribute survives sanitization", !xssResult.hasOnerrorAttr, JSON.stringify(xssResult));
    results.check("no javascript: link survives sanitization", !xssResult.hasJsLinks, JSON.stringify(xssResult));
    await page.unroute("**/api/chat/stream");

    // --- Imported conversation with HTML/script content stays inert ----------
    const maliciousExport = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      app: "LinguaHub AI",
      conversation: {
        title: "<img src=x onerror=alert(9)>",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: { mode: "general" },
        messages: [{ role: "user", content: "<script>window.__importXss=true;</script>normal text", createdAt: new Date().toISOString(), status: "complete" }]
      }
    };
    const tmpFile = path.join(__dirname, "screenshots", "malicious-import.json");
    fs.writeFileSync(tmpFile, JSON.stringify(maliciousExport));
    await importConversationFile(page, tmpFile);
    await page.waitForTimeout(400);
    const importXssResult = await page.evaluate(() => ({
      flagSet: window.__importXss === true,
      scriptTagCount: document.querySelectorAll("script[src='']").length,
      titleHasRawImg: document.querySelectorAll(".conversation-item-title img").length
    }));
    results.check("imported HTML-like content never executes as script", !importXssResult.flagSet, JSON.stringify(importXssResult));
    results.check("imported HTML-like content renders as inert text, not markup, in the sidebar title", importXssResult.titleHasRawImg === 0, JSON.stringify(importXssResult));

    // --- Exported conversation JSON never contains a system prompt -----------
    await page.route("**/api/chat/stream", (route) => {
      route.fulfill({ status: 200, contentType: "text/event-stream", body: `data: ${JSON.stringify({ delta: "reply text" })}\n\ndata: [DONE]\n\n` });
    });
    await page.click("#new-chat-btn");
    await page.waitForTimeout(150);
    await page.fill("#user-input", "export secrecy check");
    await page.locator("#user-input").press("Enter");
    await page.waitForSelector('.message[data-role="assistant"][data-status="complete"]', { timeout: 10000 });
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      exportActiveConversation(page)
    ]);
    const exportPath = path.join(__dirname, "screenshots", "security-export-check.json");
    await download.saveAs(exportPath);
    const exportedText = fs.readFileSync(exportPath, "utf8");
    results.check(
      "exported conversation JSON contains no backend system-prompt fragments or secrets",
      !/You are LinguaHub|sk-|systemPrompt/i.test(exportedText),
      "checked"
    );
    await page.unroute("**/api/chat/stream");

    // --- Phase 8 additions ----------------------------------------------------

    // No token (or anything token-shaped) ever lands in the chat-history
    // LocalStorage data itself, even after a real send/save cycle.
    const chatStorageDump = await page.evaluate(() => {
      const out = {};
      for (const key of Object.keys(window.localStorage)) {
        if (key.includes("chat-history")) out[key] = window.localStorage.getItem(key);
      }
      return out;
    });
    const chatStorageText = JSON.stringify(chatStorageDump);
    results.check(
      "no Authorization/Bearer/JWT-shaped value exists anywhere in chat-history LocalStorage data",
      !/Bearer\s|eyJ[a-zA-Z0-9_-]{10,}\./.test(chatStorageText),
      "checked chat-history:* keys only"
    );

    // Input limits still active (per-mode maxInputChars, enforced server-side).
    // Runs BEFORE the rate-limit exhaustion probe below, which deliberately
    // saturates the limiter for the rest of this script's requests.
    const oversized = await page.evaluate(async (url) => {
      const r = await fetch(url + "/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "x".repeat(50000), mode: "general" })
      });
      return { status: r.status, body: await r.json() };
    }, backendUrl);
    results.check("oversized input is rejected by the backend (input limit still enforced)", oversized.status === 400 && /too long/i.test(oversized.body.reply), JSON.stringify(oversized));

    // Context limits: an absurdly long messages array is still handled safely
    // (rejected or trimmed, never crashes the server / hangs the request).
    const hugeContext = await page.evaluate(async (url) => {
      const messages = Array.from({ length: 200 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: "context filler message number " + i }));
      const r = await fetch(url + "/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages, mode: "general" })
      });
      return { status: r.status };
    }, backendUrl);
    results.check("an oversized context (200 messages) is handled safely, not a crash/hang", [200, 400, 500].includes(hugeContext.status), JSON.stringify(hugeContext));

    // Backend remains authoritative: rate limiting is still active. Run
    // LAST - it deliberately exhausts the limiter for the rest of this run.
    const rateLimitProbe = await page.evaluate(async (url) => {
      const results = [];
      for (let i = 0; i < 35; i += 1) {
        const r = await fetch(url + "/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: "" }) // deliberately invalid -> fast 400, never reaches OpenAI
        });
        results.push(r.status);
      }
      return results;
    }, backendUrl);
    results.check(
      "rate limiting is still active (a burst of requests eventually gets 429)",
      rateLimitProbe.includes(429),
      `statuses seen: ${JSON.stringify(Array.from(new Set(rateLimitProbe)))}`
    );
  });

  results.printSummary();
  results.save("security.json");
  return results.summary();
}

if (require.main === module) {
  run().then((s) => process.exit(s.failed > 0 ? 1 : 0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { run };
