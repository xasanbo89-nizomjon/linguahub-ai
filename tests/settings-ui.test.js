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
    hidden: false,
    files: null,
    value: "",
    accept: "",
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

function buildSandbox({ storedSettings, themeMode = "system", user = null, appMode = null, voice = false, sync = null } = {}) {
  const body = createFakeElement("body");
  const logoutBtn = createFakeElement("button");
  const loginBtn = createFakeElement("button");
  let logoutClicks = 0;
  let loginClicks = 0;
  logoutBtn.addEventListener("click", () => { logoutClicks += 1; });
  loginBtn.addEventListener("click", () => { loginClicks += 1; });

  const documentStub = {
    createElement: (tag) => createFakeElement(tag),
    body,
    activeElement: null,
    getElementById: (id) => (id === "logout-btn" ? logoutBtn : id === "login-btn" ? loginBtn : null),
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
  if (voice) {
    sandbox.LinguaHubVoice = {
      buildSettingsSection(ui) {
        const el = ui.section("Voice");
        el.appendChild(ui.row("Voice features"));
        return el;
      }
    };
  }
  if (sync) {
    sandbox.linguahubSync = sync;
    sandbox.LinguaHubChatSync = { statusText: (st) => ({ synced: "Synced", syncing: "Syncing\u2026", offline: "Offline" }[st] || "") };
  }
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SETTINGS_SRC, sandbox, { filename: "settings-ui.js" });

  return { sandbox, documentStub, body, logoutBtn, loginBtn, getLogoutClicks: () => logoutClicks, getLoginClicks: () => loginClicks, getThemeMode: () => currentThemeMode };
}

// The dialog is tabs > panels > sections > rows; these helpers query by id /
// label instead of child position.
function walk(el, fn) { fn(el); (el.children || []).forEach((c) => walk(c, fn)); }
function findById(root, id) { let hit = null; walk(root, (e) => { if (e.id === id) hit = e; }); return hit; }
function findAll(root, pred) { const out = []; walk(root, (e) => { if (pred(e)) out.push(e); }); return out; }
const tabButton = (body, id) => findById(body, "settings-tab-" + id);
const tabPanel = (body, id) => findById(body, "settings-panel-" + id);
const tabIds = (body) => findAll(body, (e) => e.className === "settings-tab").map((e) => e.id.replace("settings-tab-", ""));
const rowByLabel = (root, label) => findAll(root, (e) => e.className === "settings-row").find((r) => r.children[0] && r.children[0].textContent === label);
const buttonByText = (root, text) => findAll(root, (e) => e.tag === "button" && e.textContent === text)[0];
const tablist = (body) => findAll(body, (e) => e._attrs && e._attrs.role === "tablist")[0];

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
  const checkboxInput = findById(tabPanel(body, "chat"), "settings-enter-to-send");

  checkboxInput.checked = false;
  checkboxInput.dispatchChange();

  assert.equal(sandbox.LinguaHubSettingsUI.isEnterToSendEnabled(), false);
  assert.equal(sandbox.localStorage.getItem("linguahub-ai:settings"), JSON.stringify({ enterToSend: false }));
});

// ---- tabs -----------------------------------------------------------------------------------------

test("settings has a left tab list with Appearance, Chat, Voice, Data and Account - nothing removed", () => {
  const { sandbox, body } = buildSandbox({ voice: true });
  openPanel(sandbox, {});
  assert.deepEqual(tabIds(body), ["appearance", "chat", "voice", "data", "account"]);
  const list = tablist(body);
  assert.equal(list._attrs["aria-orientation"], "vertical");
  // every previous setting is still reachable inside its tab
  assert.ok(findById(tabPanel(body, "appearance"), "settings-wow-effects"));
  assert.ok(findAll(tabPanel(body, "appearance"), (e) => e.className === "theme-option").length === 3);
  assert.ok(findById(tabPanel(body, "chat"), "settings-enter-to-send"));
  assert.ok(buttonByText(tabPanel(body, "chat"), "Clear"));
  assert.ok(rowByLabel(tabPanel(body, "voice"), "Voice features"));
  assert.ok(buttonByText(tabPanel(body, "data"), "Clear all"));
});

test("tabs follow the ARIA pattern: tablist/tab/tabpanel, aria-selected, roving tabindex, hidden inactive panels", () => {
  const { sandbox, body } = buildSandbox({ voice: true });
  openPanel(sandbox, {});
  const ids = tabIds(body);
  ids.forEach((id, i) => {
    const tab = tabButton(body, id);
    const panel = tabPanel(body, id);
    assert.equal(tab._attrs.role, "tab");
    assert.equal(panel._attrs.role, "tabpanel");
    assert.equal(tab._attrs["aria-controls"], panel.id);
    assert.equal(panel._attrs["aria-labelledby"], tab.id);
    assert.equal(tab._attrs["aria-selected"], String(i === 0));
    assert.equal(tab._attrs.tabindex, i === 0 ? "0" : "-1");
    assert.equal(panel.hidden, i !== 0);
  });
});

test("clicking a tab shows its panel and hides the others", () => {
  const { sandbox, body } = buildSandbox({ voice: true });
  openPanel(sandbox, {});
  tabButton(body, "data").click();
  assert.equal(tabPanel(body, "data").hidden, false);
  assert.equal(tabPanel(body, "appearance").hidden, true);
  assert.equal(tabButton(body, "data")._attrs["aria-selected"], "true");
  assert.equal(tabButton(body, "appearance")._attrs["aria-selected"], "false");
});

test("arrow keys, Home and End move between tabs (wrapping) and select them", () => {
  const { sandbox, body } = buildSandbox({ voice: true });
  openPanel(sandbox, {});
  const list = tablist(body);
  const key = (k) => list.dispatch("keydown", { key: k, preventDefault() {} });
  key("ArrowDown");
  assert.equal(tabButton(body, "chat")._attrs["aria-selected"], "true");
  assert.equal(tabButton(body, "chat")._focused, true);
  key("End");
  assert.equal(tabButton(body, "account")._attrs["aria-selected"], "true");
  key("ArrowDown");
  assert.equal(tabButton(body, "appearance")._attrs["aria-selected"], "true", "wraps to the first tab");
  key("ArrowUp");
  assert.equal(tabButton(body, "account")._attrs["aria-selected"], "true", "wraps to the last tab");
  key("Home");
  assert.equal(tabButton(body, "appearance")._attrs["aria-selected"], "true");
});

test("open({ tab }) opens straight to that tab (the account menu uses it); unknown tabs fall back to the first", () => {
  const a = buildSandbox({});
  a.sandbox.LinguaHubSettingsUI.open({ tab: "account" });
  assert.equal(tabButton(a.body, "account")._attrs["aria-selected"], "true");
  assert.equal(tabPanel(a.body, "account").hidden, false);
  const b = buildSandbox({});
  b.sandbox.LinguaHubSettingsUI.open({}, { tab: "nonsense" });
  assert.equal(tabButton(b.body, "appearance")._attrs["aria-selected"], "true");
});

test("the first (selected) tab button receives focus when the dialog opens", async () => {
  const { sandbox, body } = buildSandbox({});
  openPanel(sandbox, {});
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(tabButton(body, "appearance")._focused, true);
});

// ---- appearance / chat ---------------------------------------------------------------------------------

test("clicking a theme option calls LinguaHubTheme.setMode and updates aria-pressed", () => {
  const { sandbox, body, getThemeMode } = buildSandbox({ themeMode: "system" });
  openPanel(sandbox, {});
  const options = findAll(tabPanel(body, "appearance"), (e) => e.className === "theme-option");
  assert.deepEqual(options.map((o) => o.textContent), ["System", "Light", "Dark"]);
  options[2].click();
  assert.equal(getThemeMode(), "dark");
  assert.equal(options[2]._attrs["aria-pressed"], "true");
  assert.equal(options[0]._attrs["aria-pressed"], "false");
});

test("Clear current conversation delegates to the controller's clearActiveConversation", () => {
  const { sandbox, body } = buildSandbox({});
  let called = false;
  openPanel(sandbox, { clearActiveConversation: () => { called = true; } });
  buttonByText(tabPanel(body, "chat"), "Clear").click();
  assert.equal(called, true);
});

test("toggling WOW Effects persists the preference and applies it immediately", () => {
  const { sandbox, body } = buildSandbox({});
  let applied = null;
  sandbox.LinguaHubWowEffects = { apply: (enabled) => { applied = enabled; } };
  openPanel(sandbox, {});
  const wowInput = findById(tabPanel(body, "appearance"), "settings-wow-effects");
  wowInput.checked = true;
  wowInput.dispatchChange();
  assert.equal(applied, true);
  assert.equal(sandbox.localStorage.getItem("linguahub-ai:settings"), JSON.stringify({ enterToSend: true, wowEffects: true }));
});

// ---- data ------------------------------------------------------------------------------------------------

test("Data tab: Export (this chat / all chats), Import and Clear all are all there and wired to the controller", () => {
  const { sandbox, body } = buildSandbox({});
  const calls = [];
  const imported = [];
  openPanel(sandbox, {
    exportActiveConversation: () => calls.push("one"),
    exportAllConversations: () => calls.push("all"),
    importFile: (file) => imported.push(file)
  });
  const data = tabPanel(body, "data");
  assert.ok(rowByLabel(data, "Export chats"));
  assert.ok(rowByLabel(data, "Import chats"));
  assert.ok(rowByLabel(data, "Delete all chats"));
  buttonByText(data, "This chat").click();
  buttonByText(data, "All chats").click();
  assert.deepEqual(calls, ["one", "all"]);

  const fileInput = findById(data, "settings-import-file");
  assert.equal(fileInput.type, "file");
  assert.equal(fileInput.hidden, true);
  let pickerOpened = false;
  fileInput.click = () => { pickerOpened = true; };
  buttonByText(data, "Choose file\u2026").click();
  assert.equal(pickerOpened, true, "the button opens the file picker");
  const file = { name: "chats.json" };
  fileInput.files = [file];
  fileInput.dispatch("change");
  assert.deepEqual(imported, [file]);
  assert.equal(fileInput.value, "", "the input is reset so the same file can be picked again");
});

test("Clear all is the outlined danger button and only closes the panel when the controller reports success", async () => {
  const ok = buildSandbox({});
  openPanel(ok.sandbox, { clearAllConversations: async () => true });
  const btn = buttonByText(tabPanel(ok.body, "data"), "Clear all");
  assert.match(btn.className, /lh-btn-danger/);
  btn.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ok.body.children[0]._removed, true, "panel closes after a successful clear-all");

  const no = buildSandbox({});
  openPanel(no.sandbox, { clearAllConversations: async () => false });
  buttonByText(tabPanel(no.body, "data"), "Clear all").click();
  await new Promise((r) => setTimeout(r, 10));
  assert.notEqual(no.body.children[0]._removed, true, "cancelled -> stays open");
});

// ---- account ---------------------------------------------------------------------------------------------

test("Account tab, signed out: explains guest mode and offers a working Sign in", () => {
  const { sandbox, body, getLoginClicks } = buildSandbox({ user: null });
  openPanel(sandbox, {});
  const account = tabPanel(body, "account");
  assert.ok(rowByLabel(account, "Signed out"));
  assert.ok(findAll(account, (e) => e.className === "settings-note")[0].textContent.match(/guest/));
  assert.equal(buttonByText(account, "Sign out"), undefined, "no sign-out when signed out");
  buttonByText(account, "Sign in").click();
  assert.equal(getLoginClicks(), 1, "delegates to the real #login-btn");
  assert.equal(body.children[0]._removed, true, "the dialog closes so the sign-in flow is visible");
});

test("Account tab, signed in: shows the user, delegates Sign out to the real #logout-btn", () => {
  const { sandbox, body, getLogoutClicks } = buildSandbox({ user: { displayName: "Ada Lovelace", email: "ada@example.com" } });
  openPanel(sandbox, {});
  const account = tabPanel(body, "account");
  const infoRow = rowByLabel(account, "Ada Lovelace");
  assert.ok(infoRow);
  assert.equal(infoRow.children[1].textContent, "ada@example.com");
  buttonByText(account, "Sign out").click();
  assert.equal(getLogoutClicks(), 1, "must delegate to the real logout button, not reimplement logout");
  assert.equal(body.children[0]._removed, true, "panel closes after triggering logout");
});

test("Account tab shows the live sync status and stops listening when the dialog closes", () => {
  let listener = null;
  let unsubscribed = 0;
  const sync = { getStatus: () => "syncing", onStatusChange: (cb) => { listener = cb; return () => { unsubscribed += 1; }; } };
  const { sandbox, body } = buildSandbox({ user: { displayName: "Ada", email: "a@b.c" }, sync });
  openPanel(sandbox, {});
  const status = findById(tabPanel(body, "account"), "settings-sync-status");
  assert.equal(status.textContent, "Syncing\u2026");
  listener("synced");
  assert.equal(status.textContent, "Synced");
  listener("offline");
  assert.equal(status.textContent, "Offline");
  sandbox.LinguaHubSettingsUI.close();
  assert.equal(unsubscribed, 1);
});

test("Account tab offers to upload this device's guest chats, and hides the row once they are uploaded", () => {
  const guest = [{ id: "g1", title: "Old chat", messages: [{ role: "user", content: "x" }] }];
  let merged = null;
  let refreshed = 0;
  const controller = {
    store: { listGuestConversations: () => guest, mergeConversations: (list) => { merged = list; return { ok: true, added: list.length, skipped: 0 }; } },
    refreshList: () => { refreshed += 1; }
  };
  const { sandbox, body } = buildSandbox({ user: { displayName: "Ada", email: "a@b.c" } });
  openPanel(sandbox, controller);
  const account = tabPanel(body, "account");
  const row = rowByLabel(account, "Chats from this device (1)");
  assert.ok(row);
  buttonByText(account, "Upload to account").click();
  assert.deepEqual(merged, guest);
  assert.equal(refreshed, 1);
  assert.equal(row.hidden, true);
});

test("Account tab has no upload row when there are no guest chats", () => {
  const controller = { store: { listGuestConversations: () => [] } };
  const { sandbox, body } = buildSandbox({ user: { displayName: "Ada", email: "a@b.c" } });
  openPanel(sandbox, controller);
  assert.equal(buttonByText(tabPanel(body, "account"), "Upload to account"), undefined);
});

// ---- embedded mode ---------------------------------------------------------------------------------------

test("embedded mode hides Export/Import (a host shell owns them) but keeps Clear all", () => {
  const { sandbox, body } = buildSandbox({ appMode: { isEmbedded: true, showImportExport: false, showAccountUI: false } });
  openPanel(sandbox, {});
  const data = tabPanel(body, "data");
  assert.equal(rowByLabel(data, "Export chats"), undefined);
  assert.equal(rowByLabel(data, "Import chats"), undefined);
  assert.ok(buttonByText(data, "Clear all"));
});

test("standalone mode shows Export and Import", () => {
  const { sandbox, body } = buildSandbox({});
  openPanel(sandbox, {});
  assert.ok(rowByLabel(tabPanel(body, "data"), "Export chats"));
  assert.ok(rowByLabel(tabPanel(body, "data"), "Import chats"));
});

test("embedded mode: there is no Account tab at all (LinguaHub's shell owns the account UI)", () => {
  const { sandbox, body } = buildSandbox({
    user: { displayName: "Ada Lovelace", email: "ada@example.com" },
    appMode: { isEmbedded: true, showAccountUI: false, showImportExport: false }
  });
  openPanel(sandbox, {});
  assert.deepEqual(tabIds(body), ["appearance", "chat", "data"]);
});

test("embedded mode's account override can bring the Account tab back, independent of Import/Export", () => {
  const { sandbox, body } = buildSandbox({
    user: { displayName: "Ada Lovelace", email: "ada@example.com" },
    appMode: { isEmbedded: true, showImportExport: true, showAccountUI: true }
  });
  openPanel(sandbox, {});
  assert.deepEqual(tabIds(body), ["appearance", "chat", "data", "account"]);
});

// ---- dialog behaviour --------------------------------------------------------------------------------------

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

test("the dialog is a labelled modal and the layout scrolls inside the window (source checks)", () => {
  assert.match(SETTINGS_SRC, /aria-modal/);
  assert.match(SETTINGS_SRC, /aria-orientation", "vertical"/);
  const css = fs.readFileSync(path.join(__dirname, "..", "www", "styles.css"), "utf8");
  assert.match(css, /\.lh-settings-dialog\{[^}]*max-width:\s*760px/);
  assert.match(css, /\.settings-layout\{[^}]*grid-template-columns:\s*172px/);
  assert.match(css, /\.settings-panels\{[^}]*overflow-y:\s*auto/);
  assert.match(css, /@media \(max-width: 600px\)\{\s*\.settings-layout\{/);
});
