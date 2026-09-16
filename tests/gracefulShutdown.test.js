"use strict";

// Phase 11: lib/gracefulShutdown.js - tested directly against fake
// server/limiter objects with an injectable exit function, since a real
// OS signal cannot be reliably delivered to a child process in this
// Windows sandbox (see that file's own header comment - verified
// directly: child_process.kill('SIGTERM') and ('SIGINT') both terminate
// the child immediately without invoking its registered handler here,
// which is a demonstrated platform/tooling limitation of this specific
// development environment, not a defect in the handler logic itself).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createShutdownHandler } = require("../lib/gracefulShutdown.js");

function fakeServer(options) {
  options = options || {};
  const calls = [];
  return {
    calls,
    closeIdleConnections: () => calls.push("closeIdleConnections"),
    closeAllConnections: () => calls.push("closeAllConnections"),
    close: (callback) => {
      calls.push("close");
      if (options.closeDelayMs) {
        setTimeout(() => callback(options.closeError || null), options.closeDelayMs);
      } else {
        callback(options.closeError || null);
      }
    }
  };
}

function fakeLimiter() {
  let stopped = false;
  return { stop: () => { stopped = true; }, get stopped() { return stopped; } };
}

test("a normal shutdown stops every limiter, closes idle connections, closes the server, and exits 0", async () => {
  const server = fakeServer();
  const limiters = [fakeLimiter(), fakeLimiter(), fakeLimiter()];
  const exitCodes = [];
  const shutdown = createShutdownHandler(server, limiters, { exit: (code) => exitCodes.push(code) });

  shutdown("SIGTERM");

  assert.ok(limiters.every((l) => l.stopped), "every limiter must be stopped");
  assert.ok(server.calls.includes("closeIdleConnections"));
  assert.ok(server.calls.includes("close"));
  assert.deepEqual(exitCodes, [0]);
});

test("an error from server.close() exits 1, not 0", async () => {
  const server = fakeServer({ closeError: new Error("boom") });
  const exitCodes = [];
  const shutdown = createShutdownHandler(server, [], { exit: (code) => exitCodes.push(code) });

  shutdown("SIGTERM");

  assert.deepEqual(exitCodes, [1]);
});

test("calling shutdown twice only runs the shutdown sequence once", async () => {
  const server = fakeServer();
  const exitCodes = [];
  const shutdown = createShutdownHandler(server, [], { exit: (code) => exitCodes.push(code) });

  shutdown("SIGTERM");
  shutdown("SIGINT");

  assert.equal(server.calls.filter((c) => c === "close").length, 1, "server.close() must only be called once");
  assert.equal(exitCodes.length, 1, "exit must only be called once");
});

test("if server.close() never calls back, the bounded force timer still closes all connections", async () => {
  const server = fakeServer({ closeDelayMs: 999999 }); // effectively "never" within this test's timeout
  const exitCodes = [];
  const shutdown = createShutdownHandler(server, [], { exit: (code) => exitCodes.push(code), timeoutMs: 30 });

  shutdown("SIGTERM");

  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.ok(server.calls.includes("closeAllConnections"), "a hung close() must eventually force-close remaining connections");
  // exit() has not been called yet in this scenario (close()'s own
  // callback still hasn't fired) - that's expected; the absolute-last-
  // resort hard-exit timer (timeoutMs + 5000) is what would eventually
  // fire if close() truly never resolves, verified by the next test.
});

test("the absolute last-resort timer forces an exit(1) if close() truly never calls back", async () => {
  const server = fakeServer({ closeDelayMs: 999999 });
  const exitCodes = [];
  const shutdown = createShutdownHandler(server, [], { exit: (code) => exitCodes.push(code), timeoutMs: 10 });

  shutdown("SIGTERM");

  await new Promise((resolve) => setTimeout(resolve, 10 + 5000 + 100));

  assert.deepEqual(exitCodes, [1]);
}, { timeout: 8000 });

test("logger receives 'shutdown started' and 'shutdown complete' messages in order on a clean shutdown", async () => {
  const server = fakeServer();
  const messages = [];
  const logger = {
    info: (msg) => messages.push(msg),
    warn: () => {},
    error: () => {}
  };
  const shutdown = createShutdownHandler(server, [], { exit: () => {}, logger });

  shutdown("SIGTERM");

  assert.deepEqual(messages, ["shutdown started", "shutdown complete"]);
});

test("works with zero limiters and no logger/exit options provided (safe defaults)", () => {
  const server = fakeServer();
  const shutdown = createShutdownHandler(server, []);
  assert.doesNotThrow(() => shutdown("SIGTERM"));
});
