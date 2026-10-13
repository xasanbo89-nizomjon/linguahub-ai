"use strict";

// Phase 7 test-only shared harness: starts the real backend (server.js, on
// port 3000, using whatever OPENAI_API_KEY is in .env) and a throwaway
// static file server (www/, on port 5500, standing in for a dev "Live
// Server") for the duration of one e2e script, launches a single headless
// Chromium instance via Playwright, and tears everything down afterward -
// including killing the child backend process, so no server is left
// running after a script exits (even on failure).

const { spawn } = require("node:child_process");
const path = require("node:path");
const { chromium } = require("playwright");
const { createStaticServer } = require("./static-server");

const BACKEND_URL = "http://127.0.0.1:3000";
const FRONTEND_URL = "http://127.0.0.1:5500";

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url + "/health");
      if (res.ok) return true;
    } catch (err) {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Backend did not become healthy within ${timeoutMs}ms`);
}

async function startBackend() {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += d.toString(); });
  child.stderr.on("data", (d) => { stderr += d.toString(); });
  await waitForHealth(BACKEND_URL, 15000);
  return {
    process: child,
    getLogs: () => ({ stdout, stderr }),
    async stop() {
      child.kill();
      const exited = await new Promise((resolve) => {
        child.once("exit", () => resolve(true));
        setTimeout(() => resolve(false), 3000);
      });
      return exited;
    }
  };
}

// Phase 10 fix: plain `server.close(callback)` only invokes its callback
// once every open connection has ended on its own - a single lingering
// keep-alive socket (Chromium's HTTP/1.1 connection pool doesn't always
// tear down the instant browser.close() returns) can make it hang far
// longer than a test run should ever wait, silently leaving this exact
// static server listening on port 5500 in the background. Found for real
// this phase: a leaked static-server process was discovered still
// LISTENING on 5500 well after its own smoke-test invocation had already
// printed a "38/38 passed" summary and exited its own function - meaning
// that specific hang happened in a *different*, still-running invocation
// whose `staticServer.close(resolve)` call never resolved, so its own
// `finally` block (and therefore its own process exit) never completed.
// `closeAllConnections()` (Node 18.2+; this project requires v24) forces
// every open socket shut immediately instead of waiting for it to end
// gracefully, and the bounded fallback timeout below (matching
// backend.stop()'s existing 3s pattern) guarantees this can never hang
// again even if some other, still-unknown cause reappears.
async function stopStaticServer(server) {
  server.closeAllConnections();
  await new Promise((resolve) => {
    server.close(resolve);
    setTimeout(resolve, 3000);
  });
}

// Phase 10 regression guard, corrected in Phase 11: verify cleanup
// deterministically, in-process - not by probing whether *anything*
// answers on the port anymore. An external TCP-connect probe (the original
// Phase 10 version of this check) turned out to have a real false-positive
// mode, discovered for real running this exact suite on this development
// machine: after this harness's own static server closes cleanly, an
// entirely unrelated local process (observed here: a VS Code utility
// process, which appears to opportunistically grab a just-freed port
// 5500 for its own port-forwarding/preview feature) can start listening
// on the very same port moments later - a network probe at that point
// can't tell "our own leaked server" apart from "some other process now
// occupies this port number for unrelated reasons," and wrongly fails the
// suite either way. The fix is to check what we actually control: the
// real server object's own `.listening` state (for the in-process static
// server) and whether the backend child process actually exited (for the
// separate backend process) - both are exact, race-free, and immune to
// any third-party process's own use of the same port number.
function assertServerNotListening(server, name) {
  if (server.listening) {
    throw new Error(`${name} is still listening after harness cleanup - a server was left running`);
  }
}

async function withApp(fn) {
  const backend = await startBackend();
  const staticServer = createStaticServer();
  await new Promise((resolve) => staticServer.listen(5500, "127.0.0.1", resolve));

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      permissions: ["clipboard-read", "clipboard-write"]
    });
    const page = await context.newPage();
    await fn({ page, context, browser, backend, baseUrl: FRONTEND_URL, backendUrl: BACKEND_URL });
  } finally {
    await browser.close();
    await stopStaticServer(staticServer);
    const backendExited = await backend.stop();
    assertServerNotListening(staticServer, "the static server (port 5500)");
    if (!backendExited) {
      throw new Error("the backend process (port 3000) did not exit within the bounded timeout after being killed");
    }
  }
}

// Export/import have no buttons in the current UI (removed in Integration
// Prep - tests/integration-prep.test.js pins that), so e2e drives the same
// real code paths through window.linguahubHistory (the controller exposed by app.js).
function exportActiveConversation(page) {
  return page.evaluate(() => window.linguahubHistory.exportActiveConversation());
}

async function importConversationFile(page, filePath) {
  const text = require("node:fs").readFileSync(filePath, "utf8");
  await page.evaluate((json) => window.linguahubHistory.importFile(new File([json], "import.json", { type: "application/json" })), text);
}

module.exports = { withApp, BACKEND_URL, FRONTEND_URL, exportActiveConversation, importConversationFile };
