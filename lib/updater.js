"use strict";

// LinguaHub AI - desktop auto-update (electron-updater, GitHub Releases).
//
// Kept apart from main.js (which cannot be required outside Electron) so the
// rules are unit-testable with a fake updater:
//   - never in development (only a packaged build can update itself),
//   - never when LINGUAHUB_DISABLE_UPDATES=1,
//   - the first check waits START_DELAY_MS after launch, so it can never slow
//     the window down, then repeats every CHECK_INTERVAL_MS,
//   - a failed check (offline, rate limit, no release yet) is logged and
//     ignored: the app never shows an error for it,
//   - updates download in the background and install when the app quits;
//     checkForUpdatesAndNotify() shows the operating system's own
//     "update downloaded" notification.
// Where updates come from is configured in package.json -> build.publish
// (the GitHub repository's Releases). Nothing here publishes anything.

const START_DELAY_MS = 30000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

function setupAutoUpdates({ autoUpdater, isPackaged, env, logger, setTimeout: schedule, setInterval: repeat }) {
  const log = logger || { info() {}, warn() {} };
  if (!isPackaged) return { enabled: false, reason: "development" };
  if (env && env.LINGUAHUB_DISABLE_UPDATES === "1") return { enabled: false, reason: "disabled" };
  if (!autoUpdater) return { enabled: false, reason: "unavailable" };

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;

  autoUpdater.on("error", (error) => log.warn("update check failed: " + (error && error.message ? error.message : "unknown error")));
  autoUpdater.on("update-available", (info) => log.info("update available: " + (info && info.version)));
  autoUpdater.on("update-downloaded", (info) => log.info("update downloaded, installs on quit: " + (info && info.version)));

  function check() {
    try {
      const result = autoUpdater.checkForUpdatesAndNotify();
      if (result && typeof result.catch === "function") result.catch((error) => log.warn("update check failed: " + (error && error.message ? error.message : "unknown error")));
    } catch (error) {
      log.warn("update check failed: " + (error && error.message ? error.message : "unknown error"));
    }
  }

  const later = schedule || setTimeout;
  const every = repeat || setInterval;
  const first = later(check, START_DELAY_MS);
  const loop = every(check, CHECK_INTERVAL_MS);
  // timers must never keep the process alive on their own
  [first, loop].forEach((handle) => { if (handle && typeof handle.unref === "function") handle.unref(); });

  return {
    enabled: true,
    check,
    stop() {
      clearTimeout(first);
      clearInterval(loop);
    }
  };
}

module.exports = { setupAutoUpdates, START_DELAY_MS, CHECK_INTERVAL_MS };
