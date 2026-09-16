"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const appMode = require("../www/app-mode.js");

test("no config at all resolves to standalone (zero-configuration default)", () => {
  const resolved = appMode.resolve(undefined);
  assert.equal(resolved.mode, "standalone");
  assert.equal(resolved.isStandalone, true);
  assert.equal(resolved.isEmbedded, false);
});

test("an unrecognized APP_MODE value falls back to standalone, not a crash or a silent embedded mode", () => {
  const resolved = appMode.resolve({ APP_MODE: "something-else" });
  assert.equal(resolved.mode, "standalone");
});

test("APP_MODE: 'embedded' resolves to embedded", () => {
  const resolved = appMode.resolve({ APP_MODE: "embedded" });
  assert.equal(resolved.mode, "embedded");
  assert.equal(resolved.isEmbedded, true);
  assert.equal(resolved.isStandalone, false);
});

test("standalone mode shows Import/Export, mode selector, and account UI by default", () => {
  const resolved = appMode.resolve({ APP_MODE: "standalone" });
  assert.equal(resolved.showImportExport, true);
  assert.equal(resolved.showModeSelector, true);
  assert.equal(resolved.showAccountUI, true);
});

test("embedded mode hides Import/Export, mode selector, and account UI by default", () => {
  const resolved = appMode.resolve({ APP_MODE: "embedded" });
  assert.equal(resolved.showImportExport, false);
  assert.equal(resolved.showModeSelector, false);
  assert.equal(resolved.showAccountUI, false);
});

test("embedded mode's per-feature defaults can each be individually overridden back on", () => {
  const resolved = appMode.resolve({ APP_MODE: "embedded", SHOW_IMPORT_EXPORT: true });
  assert.equal(resolved.isEmbedded, true);
  assert.equal(resolved.showImportExport, true, "explicit override wins over the embedded default");
  assert.equal(resolved.showModeSelector, false, "other flags keep their own embedded default");
  assert.equal(resolved.showAccountUI, false);
});

test("standalone mode's flags can each be individually overridden off", () => {
  const resolved = appMode.resolve({ APP_MODE: "standalone", SHOW_ACCOUNT_UI: false });
  assert.equal(resolved.isEmbedded, false);
  assert.equal(resolved.showAccountUI, false, "explicit override wins over the standalone default");
  assert.equal(resolved.showImportExport, true, "other flags keep their own standalone default");
});

test("a non-boolean override value is ignored, not coerced - falls back to the mode's own default", () => {
  const resolved = appMode.resolve({ APP_MODE: "embedded", SHOW_IMPORT_EXPORT: "true" });
  assert.equal(resolved.showImportExport, false, "a string 'true' is not a boolean override and must not be treated as one");
});

test("resolve() is a pure function - calling it twice with different configs never leaks state between calls", () => {
  const a = appMode.resolve({ APP_MODE: "embedded" });
  const b = appMode.resolve({ APP_MODE: "standalone" });
  assert.equal(a.isEmbedded, true);
  assert.equal(b.isEmbedded, false);
});
