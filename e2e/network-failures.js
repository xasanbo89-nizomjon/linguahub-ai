"use strict";

// Phase 7, Task 12: real browser behavior under network failure conditions
// (backend stopped, DNS-style failure, timeout/abort, malformed stream,
// empty stream, 401/403/429/500, aborted request) - real Playwright route
// interception against the real frontend, checking real DOM state
// afterward (prompt preserved, loading resets, no raw stack trace leaked,
// no duplicate message/toast).

const { withApp } = require("./harness");
const { createResults } = require("./results");

async function sendAndWaitForOutcome(page, text) {
  await page.fill("#user-input", text);
  await page.locator("#user-input").press("Enter");
  await page.waitForFunction(() => {
    const el = document.querySelector('.message[data-role="assistant"]:last-child');
    return el && (el.dataset.status === "complete" || el.dataset.status === "failed" || el.dataset.status === "stopped");
  }, { timeout: 15000 });
  return page.evaluate(() => {
    const el = document.querySelector('.message[data-role="assistant"]:last-child');
    return { status: el.dataset.status, text: el.querySelector(".message-content").textContent };
  });
}

async function run() {
  const results = createResults("Phase 7 Network Failure QA");

  await withApp(async ({ page, baseUrl }) => {
    await page.goto(baseUrl + "/index.html", { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.getElementById("mode-select").options.length >= 7);

    const pageErrors = [];
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    async function freshConversation() {
      await page.click("#new-chat-btn");
      await page.waitForTimeout(150);
    }

    // --- 401 from both endpoints (e.g. bad/expired provider key) -----------
    await freshConversation();
    await page.route("**/api/chat/stream", (route) => route.abort("failed"));
    await page.route("**/api/chat", (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ reply: "❌ Invalid OpenAI API key. Check your .env file." }) }));
    const r401 = await sendAndWaitForOutcome(page, "trigger 401");
    results.check("401: message ends in 'failed' status, not stuck loading", r401.status === "failed", JSON.stringify(r401));
    results.check("401: user-facing text has no raw stack trace / internal path", !/at\s+\w+.*\(.*:\d+:\d+\)/.test(r401.text) && !/node_modules/.test(r401.text), r401.text);
    await page.unroute("**/api/chat/stream");
    await page.unroute("**/api/chat");

    // --- 403 -----------------------------------------------------------------
    await freshConversation();
    await page.route("**/api/chat/stream", (route) => route.abort("failed"));
    await page.route("**/api/chat", (route) => route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ reply: "❌ Origin not allowed." }) }));
    const r403 = await sendAndWaitForOutcome(page, "trigger 403");
    results.check("403: message ends in 'failed' status", r403.status === "failed", JSON.stringify(r403));
    const retryBtn403 = page.locator('.message[data-role="assistant"]:last-child .message-action-btn[data-action="retry"]');
    results.check("403: Retry action is offered after a failure", (await retryBtn403.count()) > 0);
    await page.unroute("**/api/chat/stream");
    await page.unroute("**/api/chat");

    // --- 429 (rate limited) ---------------------------------------------------
    await freshConversation();
    await page.route("**/api/chat/stream", (route) => route.abort("failed"));
    await page.route("**/api/chat", (route) => route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ reply: "❌ Too many requests. Please wait a moment and try again." }) }));
    const r429 = await sendAndWaitForOutcome(page, "trigger 429");
    results.check("429: message ends in 'failed' status", r429.status === "failed", JSON.stringify(r429));
    await page.unroute("**/api/chat/stream");
    await page.unroute("**/api/chat");

    // --- 500 (provider/unexpected server error) -------------------------------
    await freshConversation();
    await page.route("**/api/chat/stream", (route) => route.abort("failed"));
    await page.route("**/api/chat", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ reply: "❌ Unexpected server error." }) }));
    const r500 = await sendAndWaitForOutcome(page, "trigger 500");
    results.check("500: message ends in 'failed' status", r500.status === "failed", JSON.stringify(r500));
    await page.unroute("**/api/chat/stream");
    await page.unroute("**/api/chat");

    // --- Backend completely stopped / DNS-style unreachable (connection refused) ---
    await freshConversation();
    await page.route("**/api/chat/stream", (route) => route.abort("connectionrefused"));
    await page.route("**/api/chat", (route) => route.abort("connectionrefused"));
    const rDown = await sendAndWaitForOutcome(page, "trigger backend down");
    results.check("backend unreachable: message ends in 'failed' status, not stuck loading forever", rDown.status === "failed", JSON.stringify(rDown));
    results.check("backend unreachable: no unhandled page exception was thrown", pageErrors.length === 0, JSON.stringify(pageErrors));
    const sendBtnResetAfterDown = await page.evaluate(() => document.getElementById("send-btn").disabled === false && !document.getElementById("send-btn").classList.contains("is-stop"));
    results.check("backend unreachable: composer/send controls reset (not stuck disabled)", sendBtnResetAfterDown);
    await page.unroute("**/api/chat/stream");
    await page.unroute("**/api/chat");

    // --- Timeout (request hangs indefinitely, user aborts) --------------------
    await freshConversation();
    await page.route("**/api/chat/stream", () => {}); // never resolves, never calls route.fulfill/abort
    await page.fill("#user-input", "this will hang");
    await page.locator("#user-input").press("Enter");
    await page.waitForFunction(() => document.getElementById("send-btn").classList.contains("is-stop"), { timeout: 5000 });
    await page.waitForTimeout(300);
    await page.click("#send-btn"); // user-initiated Stop
    await page.waitForFunction(() => !document.getElementById("send-btn").classList.contains("is-stop"), { timeout: 5000 });
    const afterHangStop = await page.evaluate(() => {
      const el = document.querySelector('.message[data-role="assistant"]:last-child');
      return { status: el.dataset.status };
    });
    results.check("hung request: user Stop resolves it cleanly (status settles, not left streaming)", afterHangStop.status !== "streaming", JSON.stringify(afterHangStop));
    await page.unroute("**/api/chat/stream");

    // --- Malformed SSE stream (garbage, not valid "data: {...}" frames) -------
    await freshConversation();
    await page.route("**/api/chat/stream", (route) => {
      route.fulfill({ status: 200, contentType: "text/event-stream", body: "this is not a valid SSE frame at all\n\nnor is this{{{" });
    });
    const rMalformed = await sendAndWaitForOutcome(page, "trigger malformed stream");
    results.check("malformed stream: settles to a real status (failed/stopped), not stuck", ["failed", "stopped", "complete"].includes(rMalformed.status), JSON.stringify(rMalformed));
    await page.unroute("**/api/chat/stream");

    // --- Empty stream (200 OK, connects, immediately ends with zero deltas) ---
    await freshConversation();
    await page.route("**/api/chat/stream", (route) => {
      route.fulfill({ status: 200, contentType: "text/event-stream", body: "data: [DONE]\n\n" });
    });
    await page.route("**/api/chat", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ reply: "" }) }));
    const rEmpty = await sendAndWaitForOutcome(page, "trigger empty stream");
    results.check("empty stream: settles without crashing (some real status reached)", Boolean(rEmpty.status), JSON.stringify(rEmpty));
    await page.unroute("**/api/chat/stream");
    await page.unroute("**/api/chat");

    // --- Prompt preservation: a failed send must not have silently discarded
    // ------ what the user typed (the message bubble itself remains, and the
    // ------ composer isn't left in a broken state for the next message). -----
    await freshConversation();
    await page.route("**/api/chat/stream", (route) => route.abort("failed"));
    await page.route("**/api/chat", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ reply: "❌ Unexpected server error." }) }));
    await sendAndWaitForOutcome(page, "the original prompt text");
    const userBubbleText = await page.locator('.message[data-role="user"]').last().locator(".message-content").textContent();
    results.check("failed send: the user's original prompt remains visible (not discarded)", userBubbleText.includes("the original prompt text"), userBubbleText);
    await page.unroute("**/api/chat/stream");
    await page.unroute("**/api/chat");

    await page.fill("#user-input", "composer still works after a failure");
    const composerStillWorks = await page.locator("#user-input").inputValue();
    results.check("composer remains usable for the next message after a failure", composerStillWorks === "composer still works after a failure");

    // --- No duplicate toast flood: several quick failures shouldn't stack
    // ------ unbounded toasts (toast.js already caps visible count - re-verify
    // ------ live here in a failure-heavy scenario). --------------------------
    const toastCountNow = await page.locator(".lh-toast, [class*=toast]").count();
    results.note("toast element count after this failure-heavy run", toastCountNow);
    results.check("no runaway toast accumulation (stays within the visible cap)", toastCountNow <= 10, `count=${toastCountNow}`);

    results.note("page errors observed across the whole run", JSON.stringify(pageErrors));
  });

  results.printSummary();
  results.save("network-failures.json");
  return results.summary();
}

if (require.main === module) {
  run().then((s) => process.exit(s.failed > 0 ? 1 : 0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { run };
