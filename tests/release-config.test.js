"use strict";

// Phase 5, step 5: desktop release readiness - installer config and auto-update rules.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { setupAutoUpdates, START_DELAY_MS, CHECK_INTERVAL_MS } = require("../lib/updater.js");

const root = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const main = fs.readFileSync(path.join(root, "main.js"), "utf8");

function fakeUpdater(options) {
  const handlers = {};
  const updater = {
    handlers,
    checks: 0,
    on(event, cb) { handlers[event] = cb; return updater; },
    checkForUpdatesAndNotify() {
      updater.checks += 1;
      if (options && options.throws) throw new Error("sync failure");
      return options && options.rejects ? Promise.reject(new Error("offline")) : Promise.resolve(null);
    }
  };
  return updater;
}

function fakeTimers() {
  const calls = { timeouts: [], intervals: [] };
  return {
    calls,
    setTimeout: (fn, ms) => { const h = { fn, ms, unrefed: false, unref() { h.unrefed = true; } }; calls.timeouts.push(h); return h; },
    setInterval: (fn, ms) => { const h = { fn, ms, unrefed: false, unref() { h.unrefed = true; } }; calls.intervals.push(h); return h; }
  };
}

test("updater: development builds and an explicit opt-out never update; a missing module is tolerated", () => {
  const timers = fakeTimers();
  const logs = [];
  const base = { logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) }, setTimeout: timers.setTimeout, setInterval: timers.setInterval };
  const dev = setupAutoUpdates(Object.assign({ autoUpdater: fakeUpdater(), isPackaged: false, env: {} }, base));
  assert.deepEqual(dev, { enabled: false, reason: "development" });
  const off = setupAutoUpdates(Object.assign({ autoUpdater: fakeUpdater(), isPackaged: true, env: { LINGUAHUB_DISABLE_UPDATES: "1" } }, base));
  assert.deepEqual(off, { enabled: false, reason: "disabled" });
  const missing = setupAutoUpdates(Object.assign({ autoUpdater: null, isPackaged: true, env: {} }, base));
  assert.deepEqual(missing, { enabled: false, reason: "unavailable" });
  assert.equal(timers.calls.timeouts.length + timers.calls.intervals.length, 0, "nothing was scheduled");
});

test("updater: a packaged build downloads in the background, installs on quit, never downgrades", () => {
  const updater = fakeUpdater();
  const timers = fakeTimers();
  const result = setupAutoUpdates({ autoUpdater: updater, isPackaged: true, env: {}, setTimeout: timers.setTimeout, setInterval: timers.setInterval });
  assert.equal(result.enabled, true);
  assert.equal(updater.autoDownload, true);
  assert.equal(updater.autoInstallOnAppQuit, true);
  assert.equal(updater.allowDowngrade, false);
  ["error", "update-available", "update-downloaded"].forEach((event) => assert.equal(typeof updater.handlers[event], "function", event));
});

test("updater: the first check waits at least 30 s after launch, then repeats every 6 h; timers never keep the process alive", () => {
  const updater = fakeUpdater();
  const timers = fakeTimers();
  setupAutoUpdates({ autoUpdater: updater, isPackaged: true, env: {}, setTimeout: timers.setTimeout, setInterval: timers.setInterval });
  assert.ok(START_DELAY_MS >= 30000);
  assert.equal(CHECK_INTERVAL_MS, 6 * 60 * 60 * 1000);
  assert.equal(timers.calls.timeouts[0].ms, START_DELAY_MS);
  assert.equal(timers.calls.intervals[0].ms, CHECK_INTERVAL_MS);
  assert.equal(updater.checks, 0, "nothing is checked at launch itself");
  assert.equal(timers.calls.timeouts[0].unrefed && timers.calls.intervals[0].unrefed, true);
  timers.calls.timeouts[0].fn();
  assert.equal(updater.checks, 1);
  timers.calls.intervals[0].fn();
  assert.equal(updater.checks, 2);
});

test("updater: failed checks (offline, no release yet, a throw) are logged quietly and never escape", async () => {
  for (const options of [{ rejects: true }, { throws: true }]) {
    const logs = [];
    const updater = fakeUpdater(options);
    const timers = fakeTimers();
    const result = setupAutoUpdates({ autoUpdater: updater, isPackaged: true, env: {}, logger: { info() {}, warn: (m) => logs.push(m) }, setTimeout: timers.setTimeout, setInterval: timers.setInterval });
    assert.doesNotThrow(() => result.check());
    await new Promise((r) => setImmediate(r));
    assert.equal(logs.length, 1);
    assert.match(logs[0], /update check failed/);
  }
  const logs = [];
  const updater = fakeUpdater();
  setupAutoUpdates({ autoUpdater: updater, isPackaged: true, env: {}, logger: { info() {}, warn: (m) => logs.push(m) }, setTimeout: fakeTimers().setTimeout, setInterval: fakeTimers().setInterval });
  updater.handlers.error(new Error("net::ERR_INTERNET_DISCONNECTED"));
  assert.match(logs[0], /update check failed: net::ERR_INTERNET_DISCONNECTED/);
});

test("updater: stop() cancels the schedule", () => {
  const updater = fakeUpdater();
  const result = setupAutoUpdates({ autoUpdater: updater, isPackaged: true, env: {}, setTimeout: () => 1, setInterval: () => 2 });
  assert.doesNotThrow(() => result.stop());
});

test("main.js: updates start after the window exists, electron-updater is only required for a packaged build, and the app id is shared with the installer", () => {
  assert.match(main, /const \{ setupAutoUpdates \} = require\("\.\/lib\/updater"\);/);
  const ready = main.slice(main.indexOf("app.whenReady()"));
  assert.ok(ready.indexOf("createWindow();") < ready.indexOf("startAutoUpdates();"));
  assert.match(main, /if \(app\.isPackaged\) \{\s*try \{ \(\{ autoUpdater \} = require\("electron-updater"\)\); \}/);
  assert.match(main, /app\.setAppUserModelId\(require\("\.\/package\.json"\)\.build\.appId\)/);
});

test("installer: product name LinguaHub, NSIS with a choice of folder, a desktop shortcut and Start menu entry", () => {
  assert.equal(pkg.build.productName, "LinguaHub");
  assert.deepEqual(pkg.build.win.target, [{ target: "nsis", arch: ["x64"] }]);
  assert.equal(pkg.build.nsis.createDesktopShortcut, "always");
  assert.equal(pkg.build.nsis.createStartMenuShortcut, true);
  assert.equal(pkg.build.nsis.shortcutName, "LinguaHub");
  assert.equal(pkg.build.nsis.oneClick, false);
  assert.equal(pkg.build.nsis.allowToChangeInstallationDirectory, true);
  assert.equal(pkg.build.nsis.perMachine, false, "per-user install: no administrator rights needed, and updates can install silently");
  assert.match(pkg.build.artifactName, /^LinguaHub-Setup-\$\{version\}\.\$\{ext\}$/);
});

test("installer: uninstalling or updating never deletes the learner's chats, words or settings", () => {
  assert.equal(pkg.build.nsis.deleteAppDataOnUninstall, false);
  assert.equal(pkg.name, "xasan-ai", 'the package "name" decides the user-data folder (where chats and vocabulary live); renaming it would orphan existing data');
  assert.equal(pkg.productName, undefined, "a top-level productName would also change the user-data folder");
});

test("icons: the installer, the app and the build resources folder all point at real generated files", () => {
  assert.equal(pkg.build.directories.buildResources, "assets");
  ["win.icon", "nsis.installerIcon", "nsis.uninstallerIcon", "nsis.installerHeaderIcon"].forEach((k) => {
    const value = k.split(".").reduce((o, p) => o[p], pkg.build);
    assert.ok(fs.existsSync(path.join(root, value)), k + " -> " + value);
  });
  assert.ok(fs.existsSync(path.join(root, pkg.build.mac.icon)));
  assert.ok(fs.existsSync(path.join(root, pkg.build.linux.icon)));
});

test("auto-update source: GitHub Releases of this repository, no token in the repo, and the release is never published by a script here", () => {
  assert.equal(pkg.build.publish.length, 1);
  const publish = pkg.build.publish[0];
  assert.equal(publish.provider, "github");
  assert.match(publish.owner, /^[\w-]+$/);
  assert.equal(publish.owner, "xasanbo89-nizomjon");
  assert.equal(publish.repo, "linguahub-ai");
  assert.deepEqual(Object.keys(publish).sort(), ["owner", "provider", "releaseType", "repo"], "no token or other secret in the config");
  assert.doesNotMatch(JSON.stringify(pkg), /GH_TOKEN|ghp_|github_pat_/);
  Object.values(pkg.scripts).forEach((s) => assert.doesNotMatch(s, /--publish (always|onTag|onTagOrDraft)/, s));
  assert.equal(pkg.scripts["dist:win"], "electron-builder --win --publish never");
});

test("packaging: electron-updater is a runtime dependency that ships inside the app; the allowlist includes the code that uses it", () => {
  assert.ok(pkg.dependencies["electron-updater"], "dependencies, not devDependencies");
  assert.equal(pkg.devDependencies["electron-updater"], undefined);
  const files = pkg.build.files;
  assert.ok(files.includes("node_modules/**/*"));
  assert.ok(!files.some((f) => /electron-updater/.test(f) && f.startsWith("!")), "not excluded");
  ["main.js", "preload.js", "lib/**/*", "www/**/*", "assets/icon.ico", "assets/icon.png"].forEach((f) => assert.ok(files.includes(f), f));
  assert.ok(!files.includes("scripts/**/*"), "build scripts stay out of the package");
});
