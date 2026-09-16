"use strict";

// Phase 7, Task 3: real browser smoke test. Runs the real backend (real
// OpenAI key from .env) and the real frontend under Playwright/headless
// Chromium - a genuine browser engine executing the real shipped source,
// not a simulation. Every check below is REAL BROWSER unless its own log
// line says MOCKED (only used for the Markdown/code-block rendering check,
// where a controlled response is needed for deterministic assertions -
// live streaming/generation itself is verified elsewhere in this file with
// the real provider).

const path = require("node:path");
const fs = require("node:fs");
const { withApp } = require("./harness");
const { createResults } = require("./results");

async function run() {
  const results = createResults("Phase 7 Smoke Test");
  const consoleErrors = [];
  const pageErrors = [];
  const port5500ApiCalls = [];
  const failedRequests = [];
  const allResponses = [];

  await withApp(async ({ page, context, baseUrl, backendUrl }) => {
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => {
      pageErrors.push(String(err));
    });
    page.on("requestfailed", (req) => {
      failedRequests.push({ url: req.url(), failure: req.failure() && req.failure().errorText });
    });
    page.on("response", (res) => {
      allResponses.push({ url: res.url(), status: res.status() });
      const url = res.url();
      const resourceType = res.request().resourceType();
      if (
        (resourceType === "xhr" || resourceType === "fetch") &&
        /:5500\//.test(url)
      ) {
        port5500ApiCalls.push(url);
      }
    });

    // --- 1-3: load, no blank screen, no fatal console error -------------
    const response = await page.goto(baseUrl + "/index.html", { waitUntil: "networkidle" });
    results.check("1. app loads (HTTP 200 from static server)", response.status() === 200, `status ${response.status()}`);

    const bodyText = await page.evaluate(() => document.body.innerText.trim().length);
    const chatBoxExists = await page.locator("#chat-box").count();
    results.check("2. no blank screen (body has content, #chat-box present)", bodyText > 0 && chatBoxExists === 1);

    // Give the async mode-bootstrap a moment to settle before judging errors.
    await page.waitForTimeout(500);
    results.check("3. no fatal console error on load", consoleErrors.length === 0, consoleErrors.join(" | "));
    results.check("3b. no uncaught page exception on load", pageErrors.length === 0, pageErrors.join(" | "));

    // --- 4: requests target backend port 3000 ----------------------------
    const modesResponse = allResponses.find((r) => r.url.includes("/api/ai/modes"));
    results.check(
      "4. frontend requests target backend port 3000",
      Boolean(modesResponse) && modesResponse.url.startsWith(backendUrl),
      modesResponse ? modesResponse.url : "no /api/ai/modes request observed"
    );

    // --- 5-6: GET /health and GET /api/ai/modes succeed -------------------
    const healthCheck = await page.evaluate(async (url) => {
      const r = await fetch(url + "/health");
      return { status: r.status, body: await r.json() };
    }, backendUrl);
    results.check("5. GET /health succeeds", healthCheck.status === 200 && healthCheck.body.status === "ok");

    results.check("6. GET /api/ai/modes succeeds", Boolean(modesResponse) && modesResponse.status === 200);

    // --- 7-11: modes appear correctly, disabled ones unselectable --------
    await page.waitForFunction(() => {
      const sel = document.getElementById("mode-select");
      return sel && sel.options.length >= 7;
    }, { timeout: 5000 });

    const modeOptions = await page.evaluate(() => {
      const sel = document.getElementById("mode-select");
      return Array.from(sel.options).map((o) => ({ value: o.value, disabled: o.disabled, text: o.textContent }));
    });
    const byId = Object.fromEntries(modeOptions.map((o) => [o.value, o]));
    results.check("7. General mode appears", Boolean(byId.general) && !byId.general.disabled);
    results.check("8. Codex mode appears", Boolean(byId.codex) && !byId.codex.disabled);
    results.check("9. Cyber mode appears", Boolean(byId.cyber) && !byId.cyber.disabled);
    results.check("10. Deep Thinking mode appears", Boolean(byId["deep-thinking"]) && !byId["deep-thinking"].disabled);
    results.check(
      "11. disabled modes (image/voice/web-search) cannot be selected",
      byId.image && byId.image.disabled && byId.voice && byId.voice.disabled && byId["web-search"] && byId["web-search"].disabled,
      JSON.stringify(modeOptions.filter((o) => ["image", "voice", "web-search"].includes(o.value)))
    );
    // Attempt to force-select a disabled option the way a real user could
    // only do via devtools, not the UI - confirms the browser itself
    // refuses it (selectOption throws/no-ops on a disabled option).
    let disabledSelectionRejected = false;
    try {
      await page.selectOption("#mode-select", "image", { timeout: 1000 });
      const valueAfter = await page.locator("#mode-select").inputValue();
      disabledSelectionRejected = valueAfter !== "image";
    } catch (err) {
      disabledSelectionRejected = true;
    }
    results.check("11b. programmatic selection of a disabled mode is rejected by the browser", disabledSelectionRejected);

    // --- 12-14: New Chat, conversation selection, search ------------------
    const initialConvCount = await page.locator(".conversation-item").count();
    await page.click("#new-chat-btn");
    await page.waitForTimeout(200);
    await page.fill("#user-input", "first conversation marker hello");
    await page.click("#send-btn");
    // Wait for the user message bubble to appear (not the assistant reply -
    // this section only needs conversations to exist, not a full generation).
    await page.waitForSelector('.message[data-role="user"]');
    await page.click("#new-chat-btn");
    await page.waitForTimeout(200);
    await page.fill("#user-input", "second conversation marker world");
    await page.click("#send-btn");
    await page.waitForSelector('.message[data-role="user"]');
    const afterConvCount = await page.locator(".conversation-item").count();
    // New Chat deliberately reuses an already-empty, auto-titled conversation
    // instead of spawning a duplicate empty one (Phase 3 behavior, unchanged)
    // - so two New-Chat-then-send cycles starting from an empty first
    // conversation correctly yield 2 conversations total, not 3.
    results.check("12. New Chat creates new conversations", afterConvCount >= 2 && afterConvCount > initialConvCount, `before=${initialConvCount} after=${afterConvCount}`);

    const firstTitle = await page.locator(".conversation-item").nth(1).locator(".conversation-item-title").textContent();
    await page.locator(".conversation-item").nth(1).click();
    await page.waitForTimeout(200);
    const titleAfterSelect = await page.locator("#conversation-title").textContent();
    results.check("13. conversation selection switches the active conversation", titleAfterSelect.trim() === (firstTitle || "").trim(), `expected "${firstTitle}" got "${titleAfterSelect}"`);

    await page.fill("#chat-search-input", "marker hello");
    await page.waitForTimeout(200);
    const searchResults = await page.locator(".conversation-item").count();
    await page.fill("#chat-search-input", "");
    await page.waitForTimeout(200);
    const searchResultsCleared = await page.locator(".conversation-item").count();
    results.check("14. search filters and clearing restores the full list", searchResults >= 1 && searchResults < afterConvCount && searchResultsCleared === afterConvCount, `filtered=${searchResults} full=${searchResultsCleared}`);

    // --- 15-18: theme switching --------------------------------------------
    await page.click("#settings-btn");
    await page.waitForSelector(".lh-settings-dialog");
    results.check("19. settings opens", await page.locator(".lh-settings-dialog").isVisible());

    await page.click('.theme-option:has-text("Light")');
    await page.waitForTimeout(150);
    const lightTheme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    results.check("15/16. theme switching + light mode renders", lightTheme === "light", `data-theme=${lightTheme}`);
    await page.screenshot({ path: path.join(__dirname, "screenshots", "theme-light.png") });

    await page.click('.theme-option:has-text("Dark")');
    await page.waitForTimeout(150);
    const darkTheme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    results.check("17. dark mode renders", darkTheme === "dark", `data-theme=${darkTheme}`);
    await page.screenshot({ path: path.join(__dirname, "screenshots", "theme-dark.png") });

    await page.click('.theme-option:has-text("System")');
    await page.waitForTimeout(150);
    const systemThemeApplied = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    results.check("18. system theme source logic works (resolves to a concrete light/dark value)", systemThemeApplied === "light" || systemThemeApplied === "dark", `data-theme=${systemThemeApplied}`);

    // --- 20-21: dialogs and toasts ------------------------------------------
    await page.click(".lh-settings-dialog .lh-btn-primary"); // Done/close button
    await page.waitForTimeout(150);
    results.check("20. settings dialog closes", (await page.locator(".lh-settings-dialog").count()) === 0);

    await page.locator(".conversation-item").first().locator('button[aria-label^="Rename"]').click();
    await page.waitForSelector(".lh-dialog-input");
    const renameDialogOpen = await page.locator(".lh-dialog-input").isVisible();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    const renameDialogClosedByEscape = (await page.locator(".lh-dialog-input").count()) === 0;
    results.check("20b. rename dialog opens and Escape cancels it", renameDialogOpen && renameDialogClosedByEscape);

    // Toast: trigger via copy action later (§28) - checked there and
    // recorded as satisfying item 21 too, since it's the same toast system.

    // --- 22-24: composer -----------------------------------------------------
    await page.fill("#user-input", "");
    await page.type("#user-input", "typed composer text");
    const composerValue = await page.locator("#user-input").inputValue();
    results.check("22. composer accepts input", composerValue === "typed composer text");

    await page.fill("#user-input", "");
    await page.locator("#user-input").press("Shift+Enter");
    await page.locator("#user-input").type("line two");
    const afterShiftEnter = await page.locator("#user-input").inputValue();
    results.check("24. Shift+Enter inserts a newline instead of sending", afterShiftEnter.includes("\n"), JSON.stringify(afterShiftEnter));
    await page.fill("#user-input", "");

    // --- 25-28: real generation, Stop, partial response, Copy (REAL provider) --
    await page.selectOption("#mode-select", "general");
    await page.fill("#user-input", "Please count slowly from one to fifty, one number per line, spelled out in full English words.");
    await page.locator("#user-input").press("Enter");
    results.check("23. Enter sends the message", true, "verified implicitly by generation starting below");

    await page.waitForFunction(() => {
      const btn = document.getElementById("send-btn");
      return btn && btn.classList.contains("is-stop");
    }, { timeout: 10000 });
    results.check("25. Stop button appears during generation (REAL provider)", true);

    await page.waitForTimeout(600); // let a little real streamed content accumulate
    await page.click("#send-btn"); // now acting as Stop
    await page.waitForFunction(() => {
      const btn = document.getElementById("send-btn");
      return btn && !btn.classList.contains("is-stop");
    }, { timeout: 10000 });
    results.check("26. Stop aborts generation", true);

    const lastAssistant = page.locator('.message[data-role="assistant"]').last();
    const partialStatus = await lastAssistant.getAttribute("data-status");
    const partialText = (await lastAssistant.locator(".message-content").textContent()) || "";
    results.check(
      "27. partial response remains after Stop, status is 'stopped'",
      partialStatus === "stopped" && partialText.trim().length > 0,
      `status=${partialStatus} textLen=${partialText.trim().length}`
    );

    const userMsg = page.locator('.message[data-role="user"]').last();
    await userMsg.hover();
    await userMsg.locator('.message-action-btn[data-action="copy"]').click();
    await page.waitForTimeout(200);
    const toastVisible = await page.locator(".lh-toast, [class*=toast]").count();
    results.check("21/28. Copy action works and a toast renders", toastVisible > 0, `toast elements found: ${toastVisible}`);

    // --- 29: Edit ------------------------------------------------------------
    await userMsg.locator('.message-action-btn[data-action="edit"]').click();
    await page.waitForSelector(".message-edit-textarea");
    await page.fill(".message-edit-textarea", "edited prompt: say OK and nothing else");
    const laterCount = await page.locator('.message[data-role="assistant"]').count();
    await page.click('.message-edit-actions .lh-btn-primary');
    if (laterCount > 0) {
      // A confirmation dialog is expected since a later assistant message exists.
      await page.waitForSelector(".lh-dialog-actions .lh-btn-danger", { timeout: 3000 }).catch(() => {});
      const confirmBtn = page.locator(".lh-dialog-actions .lh-btn-danger");
      if (await confirmBtn.count()) await confirmBtn.click();
    }
    await page.waitForTimeout(800);
    const editedUserText = await page.locator('.message[data-role="user"]').last().locator(".message-content").textContent();
    results.check("29. Edit works (message replaced and resent)", (editedUserText || "").includes("edited prompt"), editedUserText);

    // Let the edited generation settle (or abort it) before moving on.
    const stopBtnVisible = await page.locator("#send-btn.is-stop").count();
    if (stopBtnVisible) {
      await page.click("#send-btn");
      await page.waitForTimeout(300);
    }

    // --- 30: Regenerate --------------------------------------------------------
    const assistantBeforeRegen = page.locator('.message[data-role="assistant"]').last();
    const idBefore = await assistantBeforeRegen.getAttribute("data-message-id");
    const regenBtn = assistantBeforeRegen.locator('.message-action-btn[data-action="regenerate"]');
    if (await regenBtn.count()) {
      await regenBtn.click();
      await page.waitForTimeout(600);
      // Abort quickly - we only need to prove it replaced in place, not a full completion.
      const stopVisible = await page.locator("#send-btn.is-stop").count();
      if (stopVisible) await page.click("#send-btn");
      await page.waitForTimeout(300);
      const countAfterRegen = await page.locator('.message[data-role="assistant"]').count();
      const idAfter = await page.locator('.message[data-role="assistant"]').last().getAttribute("data-message-id");
      results.check("31. Regenerate replaces the message in place (no duplicate)", idAfter === idBefore, `before=${idBefore} after=${idAfter} count=${countAfterRegen}`);
    } else {
      results.check("31. Regenerate replaces the message in place (no duplicate)", false, "no regenerate button found - message may still be in a non-final state");
    }

    // --- 31: Retry for a forced failure (network interception) -----------------
    await page.click("#new-chat-btn");
    await page.waitForTimeout(200);
    await page.route("**/api/chat/stream", (route) => route.abort("failed"));
    await page.route("**/api/chat", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ reply: "❌ Error connecting to AI" }) }));
    await page.fill("#user-input", "this request is forced to fail");
    await page.locator("#user-input").press("Enter");
    await page.waitForFunction(() => {
      const el = document.querySelector('.message[data-role="assistant"]');
      return el && el.dataset.status === "failed";
    }, { timeout: 10000 });
    const retryBtn = page.locator('.message[data-role="assistant"] .message-action-btn[data-action="retry"]');
    results.check("31b. Retry button appears for a forced failure", (await retryBtn.count()) > 0);
    await page.unroute("**/api/chat/stream");
    await page.unroute("**/api/chat");

    // --- 32-34: Markdown + code block rendering (MOCKED render path only) ------
    await page.click("#new-chat-btn");
    await page.waitForTimeout(200);
    const mockedMarkdown = "Here is **bold text** and a code block:\n\n```js\nfunction add(a, b) {\n  return a + b;\n}\n```\n";
    await page.route("**/api/chat/stream", (route) => {
      const body = `data: ${JSON.stringify({ delta: mockedMarkdown })}\n\ndata: [DONE]\n\n`;
      route.fulfill({ status: 200, contentType: "text/event-stream", body });
    });
    await page.fill("#user-input", "give me bold text and a js code block");
    await page.locator("#user-input").press("Enter");
    await page.waitForSelector(".code-block", { timeout: 10000 });
    const hasBold = (await page.locator('.message[data-role="assistant"] strong').count()) > 0;
    const hasCodeBlock = (await page.locator(".code-block code").count()) > 0;
    results.check("32/33. [MOCKED render path] Markdown and code blocks render", hasBold && hasCodeBlock);

    await page.locator(".code-block-copy-btn").first().click();
    await page.waitForTimeout(150);
    const copyBtnText = await page.locator(".code-block-copy-btn").first().textContent();
    results.check("34. [MOCKED render path] Code copy works", (copyBtnText || "").toLowerCase().includes("copied"), copyBtnText);
    await page.unroute("**/api/chat/stream");

    // --- 35: Import/export (REAL browser download + real file input) ----------
    await page.click("#new-chat-btn");
    await page.waitForTimeout(200);
    await page.fill("#user-input", "export flow marker message");
    await page.locator("#user-input").press("Enter");
    await page.waitForSelector('.message[data-role="user"]');
    const stopBtnForExport = await page.locator("#send-btn.is-stop").count();
    if (stopBtnForExport) { await page.click("#send-btn"); await page.waitForTimeout(200); }

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.click("#export-chat-btn")
    ]);
    const downloadPath = path.join(__dirname, "screenshots", "exported-conversation.json");
    await download.saveAs(downloadPath);
    const exportedJson = JSON.parse(fs.readFileSync(downloadPath, "utf8"));
    results.check(
      "35a. Export downloads a real, valid conversation JSON",
      exportedJson.conversation && exportedJson.conversation.messages.some((m) => m.content.includes("export flow marker")),
      "downloaded and parsed successfully"
    );

    const convCountBeforeImport = await page.locator(".conversation-item").count();
    await page.setInputFiles("#import-chat-input", downloadPath);
    await page.waitForTimeout(400);
    const convCountAfterImport = await page.locator(".conversation-item").count();
    results.check("35b. Import adds a new conversation from the exported file", convCountAfterImport === convCountBeforeImport + 1, `before=${convCountBeforeImport} after=${convCountAfterImport}`);

    // --- 36-37: no 405, no accidental port-5500 API calls -----------------------
    const any405 = allResponses.filter((r) => r.status === 405);
    results.check("36. no 405 regression anywhere in the run", any405.length === 0, JSON.stringify(any405));
    results.check("37. no XHR/fetch request went to port 5500", port5500ApiCalls.length === 0, JSON.stringify(port5500ApiCalls));

    results.note("console errors observed", JSON.stringify(consoleErrors));
    results.note("failed requests observed", JSON.stringify(failedRequests));
  });

  results.printSummary();
  results.save("smoke.json");
  return results.summary();
}

if (require.main === module) {
  run().then((s) => process.exit(s.failed > 0 ? 1 : 0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { run };
