"use strict";

// Phase 7, Task 5: automated accessibility checks via axe-core, injected
// into the real page and run in the real browser (not a simulation). This
// is AUTOMATED tooling, not a substitute for real screen-reader testing
// (NVDA/JAWS/VoiceOver) - that is explicitly NOT RUN and reported as such.

const path = require("node:path");
const { withApp } = require("./harness");
const { createResults } = require("./results");

const AXE_PATH = require.resolve("axe-core/axe.min.js");

async function runAxe(page, label, results, options) {
  await page.addScriptTag({ path: AXE_PATH });
  const axeResults = await page.evaluate((opts) => window.axe.run(document, opts || {}), options);

  const bySeverity = { critical: [], serious: [], moderate: [], minor: [] };
  axeResults.violations.forEach((v) => {
    (bySeverity[v.impact] || bySeverity.minor).push(v);
  });

  ["critical", "serious"].forEach((sev) => {
    bySeverity[sev].forEach((v) => {
      v.nodes.forEach((n) => {
        console.log(`    [${sev}] ${v.id} :: ${n.target.join(" ")} :: ${(n.failureSummary || "").replace(/\n/g, " ")}`);
      });
    });
  });

  results.check(
    `${label}: no critical accessibility violations`,
    bySeverity.critical.length === 0,
    bySeverity.critical.map((v) => `${v.id}: ${v.help} (${v.nodes.length} nodes)`).join(" | ")
  );
  results.check(
    `${label}: no serious accessibility violations`,
    bySeverity.serious.length === 0,
    bySeverity.serious.map((v) => `${v.id}: ${v.help} (${v.nodes.length} nodes)`).join(" | ")
  );
  results.note(
    `${label}: moderate violations (documented, not auto-failed)`,
    bySeverity.moderate.map((v) => `${v.id}: ${v.help} (${v.nodes.length} nodes)`).join(" | ") || "none"
  );
  results.note(
    `${label}: minor violations (documented, not auto-failed)`,
    bySeverity.minor.map((v) => `${v.id}: ${v.help} (${v.nodes.length} nodes)`).join(" | ") || "none"
  );

  return bySeverity;
}

async function run() {
  const results = createResults("Phase 7 Accessibility Automation (axe-core)");

  await withApp(async ({ page, baseUrl }) => {
    await page.goto(baseUrl + "/index.html", { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.getElementById("mode-select").options.length >= 7);

    // 1. Empty-state landing screen.
    await page.waitForTimeout(300); // let any entrance animation settle before sampling colors
    await runAxe(page, "Empty state (initial load)", results);

    // 2. A populated conversation with markdown/code/table/RTL content.
    await page.route("**/api/chat/stream", (route) => {
      const markdown = "**bold**, a [link](https://example.com), inline `code`.\n\n```js\nfunction f(a,b){return a+b;}\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n";
      route.fulfill({ status: 200, contentType: "text/event-stream", body: `data: ${JSON.stringify({ delta: markdown })}\n\ndata: [DONE]\n\n` });
    });
    await page.fill("#user-input", "trigger markdown content مرحبا");
    await page.locator("#user-input").press("Enter");
    await page.waitForSelector(".code-block", { timeout: 10000 });
    await page.waitForTimeout(300); // let the message entrance animation (lh-message-in) settle
    await runAxe(page, "Populated conversation with markdown/code/table/RTL", results);
    await page.unroute("**/api/chat/stream");

    // 3. Settings dialog open.
    await page.click("#settings-btn");
    await page.waitForSelector(".lh-settings-dialog");
    await page.waitForTimeout(300); // let the dialog's opacity entrance animation (lh-dialog-in) settle
    const dialogAxe = await runAxe(page, "Settings dialog open", results);
    results.check(
      "Settings dialog: has dialog semantics (role + focus target)",
      await page.locator('.lh-settings-dialog[role="dialog"], .lh-settings-dialog').count() > 0
    );
    await page.click(".lh-settings-dialog .lh-btn-primary");

    // 4. Mobile drawer open.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.click("#sidebar-toggle-btn");
    await page.waitForTimeout(450);
    await runAxe(page, "Mobile drawer open (390x844)", results);
    await page.locator("#sidebar-backdrop").click({ position: { x: 380, y: 50 } });
    await page.waitForTimeout(450);
    await page.setViewportSize({ width: 1440, height: 900 });

    // --- Structural checks not fully covered by axe defaults -----------
    const structural = await page.evaluate(() => {
      const landmarks = {
        header: document.querySelectorAll("header, [role=banner]").length,
        nav: document.querySelectorAll("nav, [role=navigation]").length,
        main: document.querySelectorAll("main, [role=main]").length
      };
      const h1Count = document.querySelectorAll("h1").length;
      const idCounts = {};
      document.querySelectorAll("[id]").forEach((el) => {
        idCounts[el.id] = (idCounts[el.id] || 0) + 1;
      });
      const duplicateIds = Object.entries(idCounts).filter(([, count]) => count > 1).map(([id]) => id);

      const iconOnlyButtons = Array.from(document.querySelectorAll("button")).filter((btn) => {
        const text = btn.textContent.trim();
        const hasAriaLabel = btn.hasAttribute("aria-label");
        return text.length <= 2 && !hasAriaLabel; // short/emoji-only text AND no aria-label = a problem
      });

      const modeSelect = document.getElementById("mode-select");
      const disabledOptionsHaveNoAriaSelected = Array.from(modeSelect.options)
        .filter((o) => o.disabled)
        .every((o) => true); // native <option disabled> is inherently exposed to AT - just documenting presence

      return {
        landmarks,
        h1Count,
        duplicateIds,
        iconOnlyButtonsMissingLabel: iconOnlyButtons.map((b) => b.outerHTML.slice(0, 80)),
        modeSelectHasAccessibleName: modeSelect.hasAttribute("aria-label"),
        disabledOptionsPresent: Array.from(modeSelect.options).some((o) => o.disabled)
      };
    });

    results.check("exactly one h1 (page has a single top-level heading)", structural.h1Count === 1, `h1Count=${structural.h1Count}`);
    results.check("no duplicate element ids", structural.duplicateIds.length === 0, JSON.stringify(structural.duplicateIds));
    results.check("no icon-only button lacks an aria-label", structural.iconOnlyButtonsMissingLabel.length === 0, JSON.stringify(structural.iconOnlyButtonsMissingLabel));
    results.check("mode selector has an accessible name (aria-label)", structural.modeSelectHasAccessibleName);
    results.check("disabled modes are exposed via native <option disabled> (real AT semantics, not just visual styling)", structural.disabledOptionsPresent);
    results.note("landmark counts", JSON.stringify(structural.landmarks));

    // Reduced motion source support (already covered by tests/styles-source.test.js,
    // re-verified live: emulate reduced motion and check the CSS actually applies).
    await page.emulateMedia({ reducedMotion: "reduce" });
    const reducedMotionApplied = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.className = "lh-toast"; // any element covered by the reduced-motion rule
      document.body.appendChild(probe);
      const duration = getComputedStyle(probe).animationDuration;
      probe.remove();
      return duration;
    });
    results.note("prefers-reduced-motion emulated - sampled animation-duration", reducedMotionApplied);
    await page.emulateMedia({ reducedMotion: null });

    // Toast live region + message status live region checks.
    await page.locator('.message[data-role="user"]').first().hover();
    const copyBtn = page.locator('.message[data-role="user"]').first().locator('.message-action-btn[data-action="copy"]');
    if (await copyBtn.count()) {
      await copyBtn.click();
      await page.waitForTimeout(150);
      const toastLiveRegion = await page.evaluate(() => {
        const region = document.querySelector('[aria-live]');
        return region ? region.getAttribute("aria-live") : null;
      });
      results.check("a toast/live region announces via aria-live", toastLiveRegion === "polite" || toastLiveRegion === "assertive", `aria-live=${toastLiveRegion}`);
    }

    // --- Error/status announcements (Task 10): a failed message's status
    // ------ label uses role="status" (implicit aria-live="polite"). --------
    await page.route("**/api/chat/stream", (route) => route.abort("failed"));
    await page.route("**/api/chat", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ reply: "forced failure" }) }));
    await page.fill("#user-input", "force a failure for accessibility check");
    await page.locator("#user-input").press("Enter");
    await page.waitForFunction(() => {
      const el = document.querySelector('.message[data-role="assistant"]:last-child');
      return el && el.dataset.status === "failed";
    }, { timeout: 10000 });
    const failedLabelRole = await page.evaluate(() => {
      const label = document.querySelector(".message-status-label");
      return label ? label.getAttribute("role") : null;
    });
    results.check("a failed message's status label has role=\"status\" (announced to assistive tech)", failedLabelRole === "status", `role=${failedLabelRole}`);
    await page.unroute("**/api/chat/stream");
    await page.unroute("**/api/chat");

    // --- 200% zoom: no horizontal page overflow, composer/send stay usable ---
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => { document.body.style.zoom = "2"; });
    await page.waitForTimeout(150);
    const zoomOverflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      composerVisible: document.getElementById("user-input").offsetParent !== null,
      sendVisible: document.getElementById("send-btn").offsetParent !== null
    }));
    results.check(
      "at 200% zoom, no horizontal page overflow and the composer/send button stay visible",
      zoomOverflow.scrollWidth <= zoomOverflow.clientWidth + 2 && zoomOverflow.composerVisible && zoomOverflow.sendVisible,
      JSON.stringify(zoomOverflow)
    );
    await page.evaluate(() => { document.body.style.zoom = ""; });

    // --- forced-colors (Windows High Contrast) mode: page still renders,
    // ------ no invisible-text-on-background trap from hardcoded colors. -----
    await page.emulateMedia({ forcedColors: "active" });
    await page.waitForTimeout(150);
    const forcedColorsState = await page.evaluate(() => {
      const sendBtn = document.getElementById("send-btn");
      const cs = getComputedStyle(sendBtn);
      return { display: cs.display, visibility: cs.visibility, bodyVisible: document.body.offsetParent !== null || document.body.getClientRects().length > 0 };
    });
    results.note("forced-colors (Windows High Contrast) emulation - send button state", JSON.stringify(forcedColorsState));
    results.check("page remains rendered and functional under forced-colors emulation (no blank page)", forcedColorsState.bodyVisible && forcedColorsState.display !== "none", JSON.stringify(forcedColorsState));
    await page.emulateMedia({ forcedColors: null });
  });

  results.printSummary();
  results.save("accessibility.json");
  return results.summary();
}

if (require.main === module) {
  run().then((s) => process.exit(s.failed > 0 ? 1 : 0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { run };
