"use strict";

// Executes the real www/settings-ui.js source inside a sandboxed vm context
// with a minimal fake DOM plus fake LinguaHubTheme/LinguaHubAuth globals -
// no jsdom dependency.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const SETTINGS_SRC = fs.readFileSync(path.join(__dirname, "..", "www", "settings-ui.js"), "utf8");

function createFakeStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); }
  };
}

function createFakeElement(tag) {
  const el = {
    tag,
    _listeners: {},
    _attrs: {},
    children: [],
    textContent: "",
    className: "",
    id: "",
    htmlFor: "",
    type: "",
    checked: false,
    focus() { el._focused = true; },
    setAttribute(name, v) { this._attrs[name] = v; },
    getAttribute(name) { return this._attrs[name]; },
    addEventListener(event, handler) { (this._listeners[event] = this._listeners[event] || []).push(handler); },
    appendChild(child) { this.children.push(child); return child; },
    remove() { el._removed = true; },
    querySelectorAll() { return el._focusable || []; },
    click() { (this._listeners.click || []).forEach((h) => h()); },
    dispatchChange() { (this._listeners.change || []).forEach((h) => h()); },
    dispatch(event, evt) { (this._listeners[event] || []).forEach((h) => h(evt)); }
  };
  return el;
}

function buildSandbox({ storedSettings, themeMode = "system", user = null, appMode = null } = {}) {
  const body = createFakeElement("body");
  const logoutBtn = createFakeElement("button");
  let logoutClicks = 0;
  logoutBtn.addEventListener("click", () => { logoutClicks += 1; });

  const documentStub = {
    createElement: (tag) => createFakeElement(tag),
    body,
    activeElement: null,
    getElementById: (id) => (id === "logout-btn" ? logoutBtn : null),
    addEventListener(event, handler) {
      documentStub._keydownHandlers = documentStub._keydownHandlers || [];
      documentStub._keydownHandlers.push(handler);
    },
    removeEventListener(event, handler) {
      documentStub._keydownHandlers = (documentStub._keydownHandlers || []).filter((h) => h !== handler);
    },
    fireKeydown(evt) {
      (documentStub._keydownHandlers || []).forEach((h) => h(evt));
    }
  };

  let currentThemeMode = themeMode;
  const fakeTheme = {
    getMode: () => currentThemeMode,
    setMode: (mode) => { currentThemeMode = mode; }
  };

  const fakeAuth = { getCurrentUser: () => user };

  const sandbox = {
    console, setTimeout, clearTimeout,
    localStorage: createFakeStorage(storedSettings ? { "linguahub-ai:settings": JSON.stringify(storedSettings) } : {}),
    document: documentStub,
    LinguaHubTheme: fakeTheme,
    LinguaHubAuth: fakeAuth
  };
  if (appMode) sandbox.LinguaHubAppMode = appMode;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SETTINGS_SRC, sandbox, { filename: "settings-ui.js" });

  return { sandbox, documentStub, body, logoutBtn, getLogoutClicks: () => logoutClicks, getThemeMode: () => currentThemeMode };
}

function openPanel(sandbox, controller) {
  sandbox.LinguaHubSettingsUI.open(controller || {});
}

test("isEnterToSendEnabled() defaults to true with no stored settings", () => {
  const { sandbox } = buildSandbox({});
  assert.equal(sandbox.LinguaHubSettingsUI.isEnterToSendEnabled(), true);
});

test("isEnterToSendEnabled() reflects a stored false value", () => {
  const { sandbox } = buildSandbox({ storedSettings: { enterToSend: false } });
  assert.equal(sandbox.LinguaHubSettingsUI.isEnterToSendEnabled(), false);
});

test("corrupted stored settings JSON falls back to defaults instead of crashing", () => {
  const { sandbox } = buildSandbox({});
  sandbox.localStorage.setItem("linguahub-ai:settings", "{not valid json");
  assert.doesNotThrow(() => openPanel(sandbox, {}));
});

test("unknown settings fields are ignored, not crashing and not surfaced", () => {
  const { sandbox } = buildSandbox({ storedSettings: { enterToSend: true, futureField: "should be ignored" } });
  assert.equal(sandbox.LinguaHubSettingsUI.isEnterToSendEnabled(), true);
});

test("toggling the Enter-to-send switch persists the new value", () => {
  const { sandbox, body } = buildSandbox({});
  openPanel(sandbox, {});
  const panel = body.children[0].children[0];
  const chatSection = panel.children[2]; // title, appearance, chat, data, account, actions
  const enterRow = chatSection.children[1];
  const switchWrapper = enterRow.children[1];
  const checkboxInput = switchWrapper.children[0];

  checkboxInput.checked = false;
  checkboxInput.dispatchChange();

  assert.equal(sandbox.LinguaHubSettingsUI.isEnterToSendEnabled(), false);
  assert.equal(sandbox.localStorage.getItem("linguahub-ai:settings"), JSON.stringify({ enterToSend: false }));
});

test("clicking a theme option calls LinguaHubTheme.setMode and updates aria-pressed", () => {
  const { sandbox, body, getThemeMode } = buildSandbox({ themeMode: "system" });
  openPanel(sandbox, {});
  const panel = body.children[0].children[0];
  const appearanceSection = panel.children[1];
  const themeRow = appearanceSection.children[1];
  const group = themeRow.children[1];
  const [systemBtn, lightBtn, darkBtn] = group.children;

  assert.equal(systemBtn.getAttribute("aria-pressed"), "true");
  darkBtn.click();

  assert.equal(getThemeMode(), "dark");
  assert.equal(darkBtn.getAttribute("aria-pressed"), "true");
  assert.equal(systemBtn.getAttribute("aria-pressed"), "false");
});

test("Clear current conversation delegates to the controller's clearActiveConversation", () => {
  const { sandbox, body } = buildSandbox({});
  let called = false;
  openPanel(sandbox, { clearActiveConversation: () => { called = true; } });
  const panel = body.children[0].children[0];
  const chatSection = panel.children[2];
  const clearBtn = chatSection.children[2].children[1];
  clearBtn.click();
  assert.equal(called, true);
});

test("toggling WOW Effects persists the preference and applies it immediately", () => {
  const { sandbox, body } = buildSandbox({});
  let applied = null;
  sandbox.LinguaHubWowEffects = { apply: (enabled) => { applied = enabled; } };
  openPanel(sandbox, {});
  const appearanceSection = body.children[0].children[0].children[1];
  const wowInput = appearanceSection.children[2].children[1].children[0];
  wowInput.checked = true;
  wowInput.dispatchChange();
  assert.equal(applied, true);
  assert.equal(sandbox.localStorage.getItem("linguahub-ai:settings"), JSON.stringify({ enterToSend: true, wowEffects: true }));
});

test("Clear local history requires the controller and closes the panel only when it reports success", async () => {
  const { sandbox, body } = buildSandbox({});
  openPanel(sandbox, { clearAllConversations: async () => true });
  const panel = body.children[0].children[0];
  const dataSection = panel.children[3];
  const clearAllBtn = dataSection.children[1].children[1];
  clearAllBtn.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(body.children[0]._removed, true, "panel should close after a successful clear-all");
});

test("Clear local history keeps the panel open when the controller reports failure/cancellation", async () => {
  const { sandbox, body } = buildSandbox({});
  openPanel(sandbox, { clearAllConversations: async () => false });
  const panel = body.children[0].children[0];
  const dataSection = panel.children[3];
  const clearAllBtn = dataSection.children[1].children[1];
  clearAllBtn.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.notEqual(body.children[0]._removed, true);
});

test("Account section shows 'Signed out' with no logout control when there is no user", () => {
  const { sandbox, body } = buildSandbox({ user: null });
  openPanel(sandbox, {});
  const panel = body.children[0].children[0];
  const accountSection = panel.children[4];
  const infoRow = accountSection.children[1];
  assert.equal(infoRow.children[0].textContent, "Signed out");
  assert.equal(accountSection.children.length, 2, "no logout row when signed out");
});

test("Account section shows the signed-in user and a working logout delegating to the real #logout-btn", () => {
  const { sandbox, body, getLogoutClicks } = buildSandbox({ user: { displayName: "Ada Lovelace", email: "ada@example.com" } });
  openPanel(sandbox, {});
  const panel = body.children[0].children[0];
  const accountSection = panel.children[4];
  const infoRow = accountSection.children[1];
  assert.equal(infoRow.children[0].textContent, "Ada Lovelace");
  assert.equal(infoRow.children[1].textContent, "ada@example.com");

  const logoutRow = accountSection.children[2];
  const settingsLogoutBtn = logoutRow.children[1];
  settingsLogoutBtn.click();

  assert.equal(getLogoutClicks(), 1, "must delegate to the real logout button, not reimplement logout");
  assert.equal(body.children[0]._removed, true, "panel closes after triggering logout");
});

// --- Integration Prep phase: embedded mode --------------------------------

test("Import/Export rows are never rendered in the Settings dialog", () => {
  const { sandbox, body } = buildSandbox({ appMode: { isEmbedded: true, showImportExport: false, showAccountUI: false } });
  openPanel(sandbox, {});
  const panel = body.children[0].children[0];
  const chatSection = panel.children[2];
  const dataSection = panel.children[3];
  assert.equal(chatSection.children.length, 3, "heading + Enter-to-send + Clear");
  assert.equal(dataSection.children.length, 2, "heading + Clear local history");
});

test("standalone mode also omits Import/Export rows", () => {
  const { sandbox, body } = buildSandbox({});
  openPanel(sandbox, {});
  const panel = body.children[0].children[0];
  const chatSection = panel.children[2];
  const dataSection = panel.children[3];
  assert.equal(chatSection.children.length, 3);
  assert.equal(dataSection.children.length, 2);
});

test("embedded mode: the Account section is not rendered at all (Task 5 - LinguaHub's shell owns the account UI)", () => {
  const { sandbox, body } = buildSandbox({
    user: { displayName: "Ada Lovelace", email: "ada@example.com" },
    appMode: { isEmbedded: true, showAccountUI: false, showImportExport: false }
  });
  openPanel(sandbox, {});
  const panel = body.children[0].children[0];
  // title, appearance, chat, data, [actions] - no account section at all.
  assert.equal(panel.children.length, 5, "no Account section child at all in embedded mode");
});

test("embedded mode's account override remains independent of removed Import/Export actions", () => {
  const { sandbox, body } = buildSandbox({
    user: { displayName: "Ada Lovelace", email: "ada@example.com" },
    appMode: { isEmbedded: true, showImportExport: true, showAccountUI: true }
  });
  openPanel(sandbox, {});
  const panel = body.children[0].children[0];
  const chatSection = panel.children[2];
  const dataSection = panel.children[3];
  assert.equal(chatSection.children.length, 3);
  assert.equal(dataSection.children.length, 2);
  assert.equal(panel.children.length, 6, "Account section present when explicitly overridden back on");
});

test("Escape closes the settings panel and restores focus", () => {
  const { sandbox, body, documentStub } = buildSandbox({});
  const trigger = createFakeElement("button");
  documentStub.activeElement = trigger;
  openPanel(sandbox, {});
  documentStub.fireKeydown({ key: "Escape", preventDefault() {} });
  assert.equal(body.children[0]._removed, true);
  assert.equal(trigger._focused, true);
});

test("opening settings twice does not stack two panels", () => {
  const { sandbox, body } = buildSandbox({});
  openPanel(sandbox, {});
  openPanel(sandbox, {});
  const openPanels = body.children.filter((c) => !c._removed);
  assert.equal(openPanels.length, 1);
});
