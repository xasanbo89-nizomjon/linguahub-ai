"use strict";

// Phase 7, Task 4 + Task 7: responsive + visual QA across the required
// viewport matrix. Loads real content (a populated conversation with a
// long title, a code block, a table, and Arabic/mixed RTL text) at each
// width, checks for horizontal page overflow and clipped controls, and
// saves a full-page screenshot per viewport for real visual inspection
// (Read tool) - not just structural assertion.

const path = require("node:path");
const { withApp } = require("./harness");
const { createResults } = require("./results");

const VIEWPORTS = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1280x800", width: 1280, height: 800 },
  { name: "1024x768", width: 1024, height: 768 },
  { name: "768x1024", width: 768, height: 1024 },
  { name: "430x932", width: 430, height: 932 },
  { name: "390x844", width: 390, height: 844 },
  { name: "360x800", width: 360, height: 800 }
];

const LONG_TITLE_MESSAGE =
  "This is a deliberately very long user message used to force a long auto-generated conversation title so the sidebar and header truncation behavior can be checked under every viewport width in this matrix";

const RTL_MIXED_MESSAGE =
  "مرحبا Hello، هذا نص مختلط RTL and LTR content يحتوي على both directions in one message.";

async function seedConversation(page) {
  await page.route("**/api/chat/stream", (route) => {
    const markdown =
      "Mixed content check:\n\n" +
      "**bold** and a [link](https://example.com) and inline `code`.\n\n" +
      "```js\nfunction veryLongFunctionNameForOverflowTesting(argumentOne, argumentTwo, argumentThree) {\n  return argumentOne + argumentTwo + argumentThree;\n}\n```\n\n" +
      "| Column One | Column Two | A Third Wider Column |\n|---|---|---|\n| value | value | a somewhat longer cell value here |\n";
    const body = `data: ${JSON.stringify({ delta: markdown })}\n\ndata: [DONE]\n\n`;
    route.fulfill({ status: 200, contentType: "text/event-stream", body });
  });

  await page.fill("#user-input", LONG_TITLE_MESSAGE);
  await page.locator("#user-input").press("Enter");
  await page.waitForSelector(".code-block", { timeout: 10000 });

  await page.fill("#user-input", RTL_MIXED_MESSAGE);
  await page.locator("#user-input").press("Enter");
  await page.waitForTimeout(600);
  const stopVisible = await page.locator("#send-btn.is-stop").count();
  if (stopVisible) { await page.click("#send-btn"); await page.waitForTimeout(200); }

  await page.unroute("**/api/chat/stream");
}

async function checkOverflow(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      overflowing: doc.scrollWidth > doc.clientWidth + 1 // +1px rounding tolerance
    };
  });
}

async function run() {
  const results = createResults("Phase 7 Responsive + Visual QA");

  await withApp(async ({ page, baseUrl }) => {
    await page.goto(baseUrl + "/index.html", { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.getElementById("mode-select").options.length >= 7);

    await seedConversation(page);

    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.waitForTimeout(250);

      const overflow = await checkOverflow(page);
      results.check(`${vp.name}: no horizontal page overflow`, !overflow.overflowing, `scrollWidth=${overflow.scrollWidth} clientWidth=${overflow.clientWidth}`);

      const composerVisible = await page.locator("#user-input").isVisible();
      results.check(`${vp.name}: composer is visible, not hidden`, composerVisible);

      const codeBlockOverflow = await page.evaluate(() => {
        const pre = document.querySelector(".code-block pre");
        if (!pre) return null;
        return { scrollWidth: pre.scrollWidth, clientWidth: pre.clientWidth, overflowX: getComputedStyle(pre).overflowX };
      });
      results.check(
        `${vp.name}: code blocks scroll internally (overflow-x set, doesn't force page width)`,
        codeBlockOverflow && codeBlockOverflow.overflowX === "auto",
        JSON.stringify(codeBlockOverflow)
      );

      // Mobile widths: sidebar becomes a drawer (translated off-canvas when
      // closed, per source) - the settings button lives inside it, so its
      // touch target is only meaningfully checked while the drawer is open,
      // matching how a real user would actually reach it on this width.
      const isMobile = vp.width < 900;
      if (isMobile) {
        await page.click("#sidebar-toggle-btn");
        await page.waitForTimeout(450); // safely past the 320ms drawer transition
        const drawerOpenClass = await page.evaluate(() => document.getElementById("app-shell").className);
        const backdropVisible = await page.locator("#sidebar-backdrop").isVisible();
        results.check(`${vp.name}: mobile drawer opens with a visible backdrop`, backdropVisible, drawerOpenClass);

        await page.screenshot({ path: path.join(__dirname, "screenshots", `${vp.name}-drawer-open.png`), fullPage: false });
      }

      const settingsBtnBox = await page.locator("#settings-btn").boundingBox();
      const settingsBtnOnscreen = settingsBtnBox && settingsBtnBox.x >= 0 && settingsBtnBox.y >= 0;
      results.check(
        `${vp.name}: settings button touch target has a reasonable size (>=32px) and is on-screen when reachable`,
        settingsBtnBox && settingsBtnBox.height >= 32 && settingsBtnBox.width >= 32 && settingsBtnOnscreen,
        JSON.stringify(settingsBtnBox)
      );

      if (isMobile) {
        // The backdrop covers the full viewport but the drawer (now
        // correctly stacked above it, see theme.css --z-sidebar) covers its
        // own width on the left - click a point in the dimmed area outside
        // the drawer instead of the element's default center, which would
        // land inside the drawer itself on these narrow widths.
        await page.locator("#sidebar-backdrop").click({ position: { x: vp.width - 10, y: 50 } });
        await page.waitForTimeout(450);
        const backdropGoneAfterClose = (await page.locator("#sidebar-backdrop").isVisible()) === false;
        results.check(`${vp.name}: mobile drawer closes via backdrop click`, backdropGoneAfterClose);
      }

      await page.screenshot({ path: path.join(__dirname, "screenshots", `${vp.name}-full.png`), fullPage: true });
      results.note(`${vp.name}: screenshot saved`, `${vp.name}-full.png`);
    }

    // Settings panel + dialog at the smallest mobile width - the drawer
    // must be open first since #settings-btn lives inside it.
    await page.setViewportSize({ width: 360, height: 800 });
    await page.click("#sidebar-toggle-btn");
    await page.waitForTimeout(450); // safely past the 320ms drawer transition
    await page.click("#settings-btn");
    await page.waitForSelector(".lh-settings-dialog");
    const settingsOverflow = await checkOverflow(page);
    results.check("360x800: settings dialog does not cause page overflow", !settingsOverflow.overflowing, JSON.stringify(settingsOverflow));
    const closeBtnBox = await page.locator(".lh-settings-dialog .lh-btn-primary").boundingBox();
    results.check("360x800: settings dialog close button is reachable/visible", Boolean(closeBtnBox));
    await page.screenshot({ path: path.join(__dirname, "screenshots", "360x800-settings-dialog.png") });
    await page.click(".lh-settings-dialog .lh-btn-primary");
  });

  results.printSummary();
  results.save("responsive.json");
  return results.summary();
}

if (require.main === module) {
  run().then((s) => process.exit(s.failed > 0 ? 1 : 0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { run, VIEWPORTS };
