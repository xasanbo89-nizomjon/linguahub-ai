"use strict";

// Phase 7, Task 15: lightweight performance measurements using Playwright's
// own timing (no new perf framework/dependency added). Flags only confirmed
// major regressions (e.g. multi-second UI actions, unbounded DOM growth) -
// these are indicative measurements from one machine/run, not a formal
// benchmark suite.

const { withApp } = require("./harness");
const { createResults } = require("./results");

async function timeIt(fn) {
  const start = Date.now();
  await fn();
  return Date.now() - start;
}

async function run() {
  const results = createResults("Phase 7 Performance QA");

  await withApp(async ({ page, baseUrl }) => {
    const navStart = Date.now();
    await page.goto(baseUrl + "/index.html", { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.getElementById("mode-select").options.length >= 7);
    const initialRenderMs = Date.now() - navStart;
    results.note("initial render + mode-bootstrap time", `${initialRenderMs}ms`);
    results.check("initial render completes in well under 5s (real browser, cold start)", initialRenderMs < 5000, `${initialRenderMs}ms`);

    // --- Theme switch ----------------------------------------------------------
    await page.click("#settings-btn");
    await page.waitForSelector(".lh-settings-dialog");
    const themeSwitchMs = await timeIt(async () => {
      await page.click('.theme-option:has-text("Dark")');
      await page.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "dark");
    });
    results.note("theme switch time", `${themeSwitchMs}ms`);
    results.check("theme switch is fast (<500ms)", themeSwitchMs < 500, `${themeSwitchMs}ms`);
    await page.click(".lh-settings-dialog .lh-btn-primary");
    await page.waitForTimeout(200);

    // --- Sidebar toggle / drawer animation --------------------------------------
    await page.setViewportSize({ width: 390, height: 844 });
    const drawerOpenMs = await timeIt(async () => {
      await page.click("#sidebar-toggle-btn");
      await page.waitForFunction(() => document.getElementById("app-shell").classList.contains("sidebar-open"));
    });
    results.note("drawer open time (includes 320ms CSS transition)", `${drawerOpenMs}ms`);
    results.check("drawer open completes promptly (<1000ms)", drawerOpenMs < 1000, `${drawerOpenMs}ms`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await page.setViewportSize({ width: 1440, height: 900 });

    // --- Dialog open/close -------------------------------------------------------
    const dialogOpenMs = await timeIt(async () => {
      await page.locator(".conversation-item").first().locator('button[aria-label^="Rename"]').click();
      await page.waitForSelector(".lh-dialog-input");
    });
    results.check("dialog open is fast (<500ms)", dialogOpenMs < 500, `${dialogOpenMs}ms`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);

    // --- Toast lifecycle ----------------------------------------------------------
    // Need a real message to copy - the active conversation is still empty
    // at this point (only rename/dialog interactions happened so far).
    await page.fill("#user-input", "message for the toast timing check");
    await page.locator("#user-input").press("Enter");
    await page.waitForSelector('.message[data-role="user"]');
    const toastMs = await timeIt(async () => {
      await page.locator('.message[data-role="user"]').first().hover();
      await page.locator('.message[data-role="user"]').first().locator('.message-action-btn[data-action="copy"]').click();
      await page.waitForSelector(".lh-toast, [class*=toast]");
    });
    results.check("toast appears promptly after a trigger action (<500ms)", toastMs < 500, `${toastMs}ms`);

    // --- Large conversation: append many messages via direct store writes,
    // ------ then measure render + search performance. --------------------------
    // Start from a fresh, known, empty conversation (earlier steps in this
    // script already created others) so the seeded conversation can be
    // targeted afterward by its own identity, not a positional list index.
    await page.click("#new-chat-btn");
    await page.waitForTimeout(150);
    const seedTitle = "perf-seed-target-conversation";

    const seedMs = await timeIt(async () => {
      await page.evaluate((title) => {
        const store = window.LinguaHubChatStore.createChatStore({ storage: window.localStorage });
        const id = store.getActiveConversationId();
        for (let i = 0; i < 150; i += 1) {
          store.saveMessage(id, window.LinguaHubChatStore.createMessage(i % 2 === 0 ? "user" : "assistant", "message number " + i, "complete"));
        }
        store.renameConversation(id, title);
      }, seedTitle);
    });
    results.note("seeding 150 messages directly via chatStore API", `${seedMs}ms`);

    const rerenderMs = await timeIt(async () => {
      await page.click("#new-chat-btn");
      await page.waitForTimeout(150);
      await page.locator(".conversation-item").filter({ hasText: seedTitle }).first().click();
      await page.waitForFunction(() => document.querySelectorAll(".message").length >= 150, { timeout: 10000 });
    });
    results.note("re-rendering a 150-message conversation", `${rerenderMs}ms`);
    results.check("rendering a 150-message conversation stays reasonably fast (<3000ms)", rerenderMs < 3000, `${rerenderMs}ms`);

    // --- Search across many conversations -----------------------------------------
    const searchMs = await timeIt(async () => {
      await page.fill("#chat-search-input", "number 149");
      await page.waitForTimeout(250); // matches the app's own debounce
    });
    results.note("search across the conversation list", `${searchMs}ms`);
    await page.fill("#chat-search-input", "");
    await page.waitForTimeout(250);

    // --- Memory after repeated New Chat / dialog open-close / generation+stop ---
    const heapBefore = await page.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize : null));

    await page.route("**/api/chat/stream", (route) => {
      route.fulfill({ status: 200, contentType: "text/event-stream", body: `data: ${JSON.stringify({ delta: "quick reply" })}\n\ndata: [DONE]\n\n` });
    });

    for (let i = 0; i < 15; i += 1) {
      await page.click("#new-chat-btn");
    }
    for (let i = 0; i < 10; i += 1) {
      await page.click("#settings-btn");
      await page.waitForSelector(".lh-settings-dialog");
      await page.click(".lh-settings-dialog .lh-btn-primary");
      await page.waitForTimeout(30);
    }
    for (let i = 0; i < 5; i += 1) {
      await page.fill("#user-input", "repeat " + i);
      await page.locator("#user-input").press("Enter");
      await page.waitForSelector('.message[data-role="assistant"][data-status="complete"]', { timeout: 10000 });
    }
    await page.unroute("**/api/chat/stream");

    const heapAfter = await page.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize : null));
    if (heapBefore !== null && heapAfter !== null) {
      const growthMb = (heapAfter - heapBefore) / (1024 * 1024);
      results.note("JS heap growth after 15x New Chat + 10x dialog open/close + 5x generation cycles", `${growthMb.toFixed(2)}MB`);
      results.check("no gross memory blowup after repeated interaction cycles (<50MB growth)", growthMb < 50, `${growthMb.toFixed(2)}MB`);
    } else {
      results.note("performance.memory unavailable in this Chromium build", "heap growth check skipped (not a failure - Chrome-specific API, requires --enable-precise-memory-info in some versions)");
    }

    const finalMessageCount = await page.evaluate(() => document.querySelectorAll(".message").length);
    results.note("DOM message-node count after the stress sequence (sanity check, not unbounded)", finalMessageCount);
  });

  results.printSummary();
  results.save("performance.json");
  return results.summary();
}

if (require.main === module) {
  run().then((s) => process.exit(s.failed > 0 ? 1 : 0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { run };
