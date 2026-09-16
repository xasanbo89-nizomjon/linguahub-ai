"use strict";

// Phase 7: runs every real-browser e2e suite in sequence (each script owns
// its own backend/static-server lifecycle via e2e/harness.js, so they run
// as separate processes for full isolation - one hung/crashed suite can't
// take down the ones after it). Prints a combined summary and exits
// non-zero if any suite has a real failure.
//
// Deliberately NOT part of `npm test` (see package.json): these need
// Playwright's Chromium, a live backend, and (for smoke/keyboard/etc.) the
// real OpenAI key already in .env - unlike the fast unit suite, they're not
// meant to run on every save/commit. Run explicitly via `npm run test:e2e`.

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const SUITES = [
  "smoke.js",
  "responsive.js",
  "empty-state.js",
  "accessibility.js",
  "keyboard.js",
  "network-failures.js",
  "storage.js",
  "security.js",
  "performance.js",
  "auth-error-matrix.js"
];

let anyFailed = false;

for (const suite of SUITES) {
  console.log(`\n########## ${suite} ##########\n`);
  const result = spawnSync(process.execPath, [path.join(__dirname, suite)], {
    stdio: "inherit",
    cwd: path.join(__dirname, "..")
  });
  if (result.status !== 0) anyFailed = true;
}

console.log(`\n========== e2e run complete: ${anyFailed ? "FAILURES PRESENT" : "all suites passed"} ==========`);
process.exit(anyFailed ? 1 : 0);
