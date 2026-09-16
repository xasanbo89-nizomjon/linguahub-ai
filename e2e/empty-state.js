"use strict";

// Phase 7 regression test for a real, confirmed browser bug: elements
// toggled via the `hidden` DOM property stayed visually rendered because an
// author CSS rule (e.g. `.empty-state{ display: flex }`) beat the browser's
// built-in `[hidden]{ display: none }` UA-stylesheet rule - author-origin
// rules always win over user-agent-origin rules in the cascade, regardless
// of matching specificity. Observed live in real Chromium at 1440x900: the
// empty-state welcome card rendered on top of an active, non-empty
// conversation. Fixed in www/styles.css with a global
// `[hidden]{ display: none !important; }` rule (see tests/styles-source.test.js
// for the fast source-level guard on that rule's presence).
//
// This script re-verifies the actual rendered behavior in a real browser
// across every scenario named in the fix requirements.

const { withApp } = require("./harness");
const { createResults } = require("./results");

async function emptyStateInfo(page) {
  return page.evaluate(() => {
    const el = document.getElementById("empty-state");
    return { hiddenAttr: el.hidden, display: getComputedStyle(el).display, actuallyVisible: el.offsetParent !== null };
  });
}

function isHidden(info) {
  return info.hiddenAttr === true && info.display === "none" && info.actuallyVisible === false;
}
function isVisible(info) {
  return info.hiddenAttr === false && info.display !== "none" && info.actuallyVisible === true;
}

async function run() {
  const results = createResults("Phase 7 Regression: empty-state [hidden] visibility bug");

  await withApp(async ({ page, baseUrl }) => {
    await page.goto(baseUrl + "/index.html", { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.getElementById("mode-select").options.length >= 7);

    results.check("a genuinely empty conversation shows the empty state", isVisible(await emptyStateInfo(page)), JSON.stringify(await emptyStateInfo(page)));

    await page.route("**/api/chat/stream", (route) => {
      const body = `data: ${JSON.stringify({ delta: "hello reply" })}\n\ndata: [DONE]\n\n`;
      route.fulfill({ status: 200, contentType: "text/event-stream", body });
    });

    await page.fill("#user-input", "message one");
    await page.locator("#user-input").press("Enter");
    await page.waitForTimeout(600);
    results.check("empty state disappears after the first user message", isHidden(await emptyStateInfo(page)), JSON.stringify(await emptyStateInfo(page)));

    await page.fill("#user-input", "message two");
    await page.locator("#user-input").press("Enter");
    await page.waitForTimeout(600);
    results.check("empty state stays hidden after further assistant rendering", isHidden(await emptyStateInfo(page)), JSON.stringify(await emptyStateInfo(page)));

    await page.click("#new-chat-btn");
    await page.waitForTimeout(300);
    results.check("switching to another empty conversation (New Chat) shows the empty state", isVisible(await emptyStateInfo(page)), JSON.stringify(await emptyStateInfo(page)));

    await page.locator(".conversation-item").nth(1).click();
    await page.waitForTimeout(300);
    results.check("switching back to a populated conversation hides it", isHidden(await emptyStateInfo(page)), JSON.stringify(await emptyStateInfo(page)));

    await page.locator(".conversation-item").nth(0).click();
    await page.waitForTimeout(300);
    results.check("switching back to the empty conversation shows it again", isVisible(await emptyStateInfo(page)), JSON.stringify(await emptyStateInfo(page)));

    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction(() => document.getElementById("mode-select").options.length >= 7);
    await page.waitForTimeout(300);
    results.check("refresh restores the correct visibility (active conversation was empty)", isVisible(await emptyStateInfo(page)), JSON.stringify(await emptyStateInfo(page)));

    const layout = await page.evaluate(() => {
      const wrapper = document.querySelector(".chat-scroll-wrapper");
      const chatBox = document.getElementById("chat-box");
      return { wrapperHeight: wrapper.getBoundingClientRect().height, chatBoxHeight: chatBox.getBoundingClientRect().height };
    });
    results.check(
      "no layout gap remains when hidden (chat-box fills the wrapper's full height)",
      Math.abs(layout.wrapperHeight - layout.chatBoxHeight) < 2,
      JSON.stringify(layout)
    );

    await page.unroute("**/api/chat/stream");
  });

  results.printSummary();
  results.save("empty-state.json");
  return results.summary();
}

if (require.main === module) {
  run().then((s) => process.exit(s.failed > 0 ? 1 : 0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { run };
