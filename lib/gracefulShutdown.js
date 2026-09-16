"use strict";

// LinguaHub AI - graceful shutdown handler (Phase 11).
//
// Extracted from server.js so its logic (order of operations, bounded
// timeouts, exit codes) can be unit-tested directly against fake
// server/limiter objects, rather than only through a real OS signal -
// which, in this development sandbox, cannot be reliably delivered to a
// child process at all (Windows has no real POSIX signals;
// child_process.kill('SIGTERM'/'SIGINT') on this platform terminates the
// process directly rather than invoking its registered handler - verified
// directly, not assumed; see docs/production-environment.md, "graceful
// shutdown platform note"). The handler logic itself is identical to what
// a real Linux/container production deployment relies on (SIGTERM from an
// orchestrator, standard Node process.on() signal handling), and IS
// exercised for real by a genuine interactive Ctrl+C in a real terminal -
// just not by this project's own automated Windows test environment.
//
// Reuses the exact lesson from the Phase 10 port-5500 leak: a plain
// server.close(callback) can hang indefinitely on a lingering keep-alive
// connection, so this always pairs it with closeIdleConnections() up
// front, a bounded force-timer that calls closeAllConnections(), and a
// second, even-more-bounded absolute-last-resort timer.

function createShutdownHandler(server, limiters, options) {
  options = options || {};
  const timeoutMs = options.timeoutMs || 10000;
  const logger = options.logger || { info() {}, warn() {}, error() {} };
  const exit = options.exit || process.exit.bind(process);

  let shuttingDown = false;

  return function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutdown started", { signal });

    for (const limiter of limiters) limiter.stop();

    server.closeIdleConnections?.();

    const forceTimer = setTimeout(() => {
      logger.warn("shutdown: forcing remaining connections closed after timeout");
      server.closeAllConnections?.();
    }, timeoutMs);

    // Absolute last resort: if server.close()'s callback itself never
    // fires for some other reason, don't hang forever. Declared BEFORE
    // server.close() below, not after - a real bug caught by this
    // module's own unit tests: server.close()'s callback can fire
    // synchronously (it does whenever nothing is actually listening/open
    // yet to wait on), and referencing a later `const` from inside a
    // callback that runs before that line has executed throws a
    // ReferenceError (the temporal dead zone) - which would have crashed
    // every fast, clean shutdown instead of completing it.
    const hardExitTimer = setTimeout(() => {
      logger.error("shutdown: hard exit after exceeding the absolute timeout");
      exit(1);
    }, timeoutMs + 5000);
    hardExitTimer.unref?.();

    server.close((err) => {
      clearTimeout(forceTimer);
      clearTimeout(hardExitTimer);
      if (err) {
        logger.error("shutdown: error while closing server", { errorName: err.name });
        exit(1);
        return;
      }
      logger.info("shutdown complete");
      exit(0);
    });
  };
}

module.exports = { createShutdownHandler };
