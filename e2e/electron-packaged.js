"use strict";

// Phase 9, Task 6: launches the REAL PACKAGED app
// (dist/win-unpacked/LinguaHub AI.exe - the actual electron-builder output,
// running from app.asar with the Phase 8/9 pruned node_modules) rather than
// the dev source tree (main.js via `electron .`, covered by e2e/electron.js).
// This is the only way to catch packaging-specific breakage (a file the
// "files" allowlist wrongly excluded, a path assumption that only holds in
// the dev tree, etc.) that a dev-mode launch can't reveal.
//
// Requires dist/win-unpacked to already exist (run
// `npx electron-builder --dir --publish never` first) - this script does
// not build it, only launches and verifies it.

const path = require("node:path");
const fs = require("node:fs");
const { _electron: electron } = require("playwright");
const { spawn } = require("node:child_process");
const { createResults } = require("./results");

const BACKEND_URL = "http://127.0.0.1:3000";
const PACKAGED_EXE = path.join(__dirname, "..", "dist", "win-unpacked", "LinguaHub AI.exe");

const childEnv = Object.assign({}, process.env);
delete childEnv.ELECTRON_RUN_AS_NODE;

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url + "/health");
      if (res.ok) return true;
    } catch (err) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Backend did not become healthy within ${timeoutMs}ms`);
}

async function run() {
  const results = createResults("Phase 9 Packaged Electron Launch Verification");

  if (!fs.existsSync(PACKAGED_EXE)) {
    results.check("packaged app exists (run electron-builder --dir first)", false, PACKAGED_EXE);
    results.printSummary();
    results.save("electron-packaged.json");
    return results.summary();
  }
  results.note("packaged exe found", PACKAGED_EXE);

  const backend = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let backendErr = "";
  backend.stderr.on("data", (d) => { backendErr += d.toString(); });

  const consoleErrors = [];
  let electronApp = null;

  try {
    await waitForHealth(BACKEND_URL, 15000);
    results.check("backend starts and becomes healthy", true);

    electronApp = await electron.launch({
      executablePath: PACKAGED_EXE,
      args: [],
      env: childEnv
    });
    results.check("the PACKAGED app (dist/win-unpacked, running from app.asar) launches for real", true);

    const window = await electronApp.firstWindow();
    results.check("a real BrowserWindow opens from the packaged app", Boolean(window));
    window.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });

    await window.waitForLoadState("domcontentloaded");
    const url = window.url();
    results.check("no blank screen: packaged app loads real content (not blank/error page)", url.includes("index.html"), url);

    await window.waitForFunction(() => document.getElementById("mode-select") && document.getElementById("mode-select").options.length >= 7, { timeout: 15000 });
    results.check("real assets load from inside the packaged asar (mode selector populated)", true);

    const apiBase = await window.evaluate(() => window.LINGUAHUB_CONFIG.API_BASE_URL);
    results.check("packaged app's config.js still resolves file:// to the local backend", apiBase === BACKEND_URL, apiBase);

    // Real streaming round-trip from inside the packaged app.
    await window.fill("#user-input", "Say the single word: PackagedOK");
    await window.locator("#user-input").press("Enter");
    await window.waitForSelector('.message[data-role="assistant"][data-status="complete"], .message[data-role="assistant"][data-status="failed"]', { timeout: 20000 });
    const replyStatus = await window.evaluate(() => Array.from(document.querySelectorAll('.message[data-role="assistant"]')).pop().dataset.status);
    results.check("a real chat round-trip completes from the packaged app", replyStatus === "complete", `status=${replyStatus}`);

    // Theme + LocalStorage sanity from inside the packaged app.
    await window.click("#settings-btn");
    await window.waitForSelector(".lh-settings-dialog");
    await window.click('.theme-option:has-text("Dark")');
    await window.waitForTimeout(150);
    const themeApplied = await window.evaluate(() => document.documentElement.getAttribute("data-theme"));
    results.check("theme switching works in the packaged app", themeApplied === "dark", themeApplied);
    await window.click(".lh-settings-dialog .lh-btn-primary");

    const storedNamespaces = await window.evaluate(() => Object.keys(window.localStorage).filter((k) => k.includes("chat-history")));
    results.check("LocalStorage works in the packaged app", storedNamespaces.length > 0, JSON.stringify(storedNamespaces));

    results.check("no fatal console errors in the packaged app", consoleErrors.length === 0, JSON.stringify(consoleErrors.slice(0, 5)));

    await window.screenshot({ path: path.join(__dirname, "screenshots", "electron-packaged-window.png") });
    results.note("packaged app screenshot saved", "electron-packaged-window.png");
  } finally {
    if (electronApp) await electronApp.close().catch(() => {});
    backend.kill();
    await new Promise((resolve) => { backend.once("exit", resolve); setTimeout(resolve, 3000); });
    if (backendErr) results.note("backend stderr", backendErr.slice(0, 500));
  }

  results.printSummary();
  results.save("electron-packaged.json");
  return results.summary();
}

if (require.main === module) {
  run().then((s) => process.exit(s.failed > 0 ? 1 : 0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { run };
