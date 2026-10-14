"use strict";

// Phase 5, step 3: keyboard shortcuts and the help dialog.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { createDom } = require("./helpers/miniDom.js");
const Shortcuts = require("../www/shortcuts.js");

const WWW = (f) => fs.readFileSync(path.join(__dirname, "..", "www", f), "utf8");

function key(k, mods) {
  return Object.assign({ type: "keydown", key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }, mods || {});
}
const ctrl = (k, mods) => key(k, Object.assign({ ctrlKey: true }, mods || {}));

function setup({ isMac = false, drawerVisible = false } = {}) {
  const dom = createDom();
  const doc = dom.document;
  doc.querySelector = (sel) => dom.all(doc.body).find((n) => n.nodeType === 1 && n.matches && n.matches(sel)) || null;
  const clicks = [];
  const add = (id) => {
    const el = doc.createElement("button");
    el.setAttribute("id", id);
    el.addEventListener("click", () => clicks.push(id));
    el.offsetParent = id === "sidebar-toggle-btn" ? (drawerVisible ? {} : null) : {};
    doc.body.appendChild(el);
    return el;
  };
  ["new-chat-btn", "settings-btn", "sidebar-collapse-btn", "sidebar-toggle-btn", "shortcuts-btn"].forEach(add);
  const opened = [];
  const calls = { showChat: 0, stopSpeaking: 0, stop: 0 };
  const win = {
    navigator: { platform: isMac ? "MacIntel" : "Win32" },
    LinguaHubWorkspace: { open: (id) => { opened.push(id); return true; }, showChat: () => { calls.showChat += 1; } },
    LinguaHubVoice: { stopSpeaking: () => { calls.stopSpeaking += 1; }, stop: () => { calls.stop += 1; } }
  };
  const api = Shortcuts.init({ document: doc, window: win, isMac });
  const press = (event) => { doc.dispatchEvent(event); return event; };
  return { dom, doc, clicks, opened, calls, win, api, press };
}

test("actionFor: the shortcut table, including the browser-friendly alternative for a new chat", () => {
  const a = (k, mods, mac) => Shortcuts.actionFor(ctrl(k, mods), mac);
  assert.equal(a("n"), "new-chat");
  assert.equal(a("N"), "new-chat", "caps lock");
  assert.equal(a("o", { shiftKey: true }), "new-chat");
  assert.equal(a(","), "settings");
  assert.equal(a("b"), "sidebar");
  assert.equal(a("/"), "help");
  ["1", "2", "3", "4", "5"].forEach((d, i) => assert.equal(a(d), "mode-" + ["general", "translate", "speak", "grammar", "vocabulary"][i]));
});

test("actionFor: anything else is left alone - no modifier, other keys, Alt (AltGr), shifted variants, the wrong modifier for the platform", () => {
  const none = (event, mac) => assert.equal(Shortcuts.actionFor(event, mac), null);
  none(key("n"));
  none(ctrl("6"));
  none(ctrl("0"));
  none(ctrl("k"), "Ctrl+K belongs to the search palette");
  none(ctrl("n", { altKey: true }), "AltGr = Ctrl+Alt must not trigger shortcuts");
  none(ctrl("n", { shiftKey: true }));
  none(ctrl("b", { shiftKey: true }));
  none(key("n", { metaKey: true }), false);
  none(ctrl("n"), true);
  none(ctrl("n", { metaKey: true }), true);
  none(null);
  assert.equal(Shortcuts.actionFor(key("n", { metaKey: true }), true), "new-chat", "Cmd on a Mac");
  assert.equal(Shortcuts.actionFor(key("1", { metaKey: true }), true), "mode-general");
});

test("isMacPlatform: from navigator.platform or the user agent", () => {
  assert.equal(Shortcuts.isMacPlatform({ platform: "MacIntel" }), true);
  assert.equal(Shortcuts.isMacPlatform({ userAgent: "Mozilla/5.0 (Macintosh)" }), true);
  assert.equal(Shortcuts.isMacPlatform({ platform: "Win32" }), false);
  assert.equal(Shortcuts.isMacPlatform(undefined), false);
});

test("Ctrl+N and Ctrl+Shift+O start a new chat (back from any mode screen) and the browser default is cancelled", () => {
  const t = setup();
  const e1 = t.press(ctrl("n"));
  assert.deepEqual(t.clicks, ["new-chat-btn"]);
  assert.equal(e1.defaultPrevented, true);
  assert.equal(t.calls.showChat, 1);
  t.press(ctrl("o", { shiftKey: true }));
  assert.deepEqual(t.clicks, ["new-chat-btn", "new-chat-btn"]);
});

test("Ctrl+, opens settings", () => {
  const t = setup();
  const e = t.press(ctrl(","));
  assert.deepEqual(t.clicks, ["settings-btn"]);
  assert.equal(e.defaultPrevented, true);
});

test("Ctrl+B collapses the sidebar on desktop and opens the drawer on a narrow window", () => {
  const desktop = setup({ drawerVisible: false });
  desktop.press(ctrl("b"));
  assert.deepEqual(desktop.clicks, ["sidebar-collapse-btn"]);
  const narrow = setup({ drawerVisible: true });
  narrow.press(ctrl("b"));
  assert.deepEqual(narrow.clicks, ["sidebar-toggle-btn"]);
});

test("Ctrl+1..5 switch to Free chat, Translate, Speak, Grammar and Vocabulary", () => {
  const t = setup();
  ["1", "2", "3", "4", "5"].forEach((d) => t.press(ctrl(d)));
  assert.deepEqual(t.opened, ["general", "translate", "speak", "grammar", "vocabulary"]);
  t.press(ctrl("6"));
  assert.equal(t.opened.length, 5);
});

test("on a Mac the shortcuts use Cmd, and Ctrl does nothing", () => {
  const t = setup({ isMac: true });
  t.press(ctrl("n"));
  assert.deepEqual(t.clicks, []);
  t.press(key("n", { metaKey: true }));
  assert.deepEqual(t.clicks, ["new-chat-btn"]);
});

test("while a dialog is open the shortcuts do nothing and the browser default is left alone", () => {
  const t = setup();
  const backdrop = t.doc.createElement("div");
  backdrop.className = "lh-dialog-backdrop";
  t.doc.body.appendChild(backdrop);
  const e = t.press(ctrl("n"));
  t.press(ctrl("2"));
  t.press(ctrl(","));
  assert.deepEqual(t.clicks, []);
  assert.deepEqual(t.opened, []);
  assert.equal(e.defaultPrevented, false);
  backdrop.remove();
  t.press(ctrl("n"));
  assert.deepEqual(t.clicks, ["new-chat-btn"]);
});

test("a key press someone else already handled is skipped", () => {
  const t = setup();
  const e = ctrl("n");
  e.defaultPrevented = true;
  t.press(e);
  assert.deepEqual(t.clicks, []);
});

test("Ctrl+/ opens the help dialog: titled, grouped, every shortcut listed with its keys", () => {
  const t = setup();
  const e = t.press(ctrl("/"));
  assert.equal(e.defaultPrevented, true);
  assert.equal(t.api.isHelpOpen(), true);
  const dialog = t.dom.byClass(t.doc.body, "shortcuts-dialog")[0];
  assert.equal(dialog.getAttribute("role"), "dialog");
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  assert.equal(t.dom.byTag(dialog, "h2")[0].textContent, "Keyboard shortcuts");
  assert.deepEqual(t.dom.byClass(dialog, "shortcuts-section").map((n) => n.textContent), ["General", "Modes", "Writing and listening", "Flashcard review"]);
  const text = dialog.textContent;
  ["New chat", "Search chats", "Settings", "Show or hide the sidebar", "Keyboard shortcuts", "Free chat", "Translate", "Speak", "Grammar", "Vocabulary", "Send message", "New line", "Show the answer", "Again, Hard, Good, Easy"]
    .forEach((label) => assert.ok(text.includes(label), label));
  const rows = t.dom.byClass(dialog, "shortcuts-row");
  const newChat = rows.find((r) => r.textContent.startsWith("New chat"));
  assert.deepEqual(t.dom.byTag(newChat, "kbd").map((k) => k.textContent), ["Ctrl", "N", "Ctrl", "Shift", "O"]);
  assert.equal(t.doc.activeElement, t.dom.byClass(dialog, "lh-btn")[0], "focus moves into the dialog");
});

test("the help shows Cmd / Shift symbols on a Mac", () => {
  const t = setup({ isMac: true });
  t.press(key("/", { metaKey: true }));
  const kbds = t.dom.byTag(t.doc.body, "kbd").map((k) => k.textContent);
  assert.ok(kbds.includes("⌘"));
  assert.ok(kbds.includes("⇧"));
  assert.ok(!kbds.includes("Ctrl"));
});

test("the help closes with Esc, Ctrl+/ again, its Close button or a click outside - and gives focus back", () => {
  const t = setup();
  const opener = t.doc.getElementById("settings-btn");
  const close = () => { assert.equal(t.api.isHelpOpen(), false); assert.equal(t.dom.byClass(t.doc.body, "shortcuts-dialog").length, 0); assert.equal(t.doc.activeElement, opener, "focus restored"); };
  const open = () => { opener.focus(); t.press(ctrl("/")); assert.equal(t.api.isHelpOpen(), true); };

  open(); t.press(key("Escape")); close();
  open(); t.press(ctrl("/")); close();
  open(); t.dom.byClass(t.doc.body, "lh-btn")[0].click(); close();
  open(); t.dom.byClass(t.doc.body, "lh-dialog-backdrop")[0].dispatch("mousedown"); close();
});

test("the help is modal: other shortcuts are ignored, Tab stays on its button, and it never opens twice", () => {
  const t = setup();
  t.press(ctrl("/"));
  t.api.openHelp();
  assert.equal(t.dom.byClass(t.doc.body, "shortcuts-dialog").length, 1);
  t.press(ctrl("n"));
  t.press(ctrl("2"));
  assert.deepEqual(t.clicks, []);
  assert.deepEqual(t.opened, []);
  const tab = t.press(key("Tab"));
  assert.equal(tab.defaultPrevented, true);
  assert.equal(t.doc.activeElement, t.dom.byClass(t.doc.body, "lh-btn")[0]);
});

test("the '...' menu item opens the same dialog", () => {
  const t = setup();
  t.doc.getElementById("shortcuts-btn").click();
  assert.equal(t.api.isHelpOpen(), true);
});

test("Esc also stops read-aloud and dictation, without cancelling anything else", () => {
  const t = setup();
  const e = t.press(key("Escape"));
  assert.equal(t.calls.stopSpeaking, 1);
  assert.equal(t.calls.stop, 1);
  assert.equal(e.defaultPrevented, false);
  const handled = key("Escape");
  handled.defaultPrevented = true;
  t.press(handled);
  assert.equal(t.calls.stopSpeaking, 1, "an Escape someone else used is not ours");
});

test("the table and the matcher agree: every non-external shortcut in the help is a working action", () => {
  const ids = [];
  Shortcuts.SECTIONS.forEach((s) => s.items.forEach((i) => { if (!i.external) ids.push(i); }));
  assert.ok(ids.length >= 9);
  const toEvent = (combo) => {
    const k = combo[combo.length - 1];
    return ctrl(k.length === 1 ? k : k, { shiftKey: combo.includes("Shift") });
  };
  ids.forEach((item) => {
    item.keys.forEach((combo) => {
      const action = Shortcuts.actionFor(toEvent(combo), false);
      const expected = item.id === "new-chat" ? "new-chat" : item.id === "mode-general" ? "mode-general" : item.id;
      assert.equal(action, expected, item.id + " " + combo.join("+"));
    });
  });
  const external = Shortcuts.SECTIONS.flatMap((s) => s.items).filter((i) => i.external).map((i) => i.id);
  assert.ok(external.includes("search") && external.includes("escape"));
});

test("wiring: the script and the menu item are in index.html; Ctrl+K is still owned by the search palette", () => {
  const html = WWW("index.html");
  assert.match(html, /<script src="shortcuts\.js"><\/script>/);
  assert.ok(html.indexOf('<script src="shortcuts.js"></script>') < html.indexOf('<script src="app.js"></script>'));
  const menu = html.slice(html.indexOf('id="chat-menu-list"'), html.indexOf("</div>", html.indexOf('id="chat-menu-list"')));
  assert.match(menu, /<button id="shortcuts-btn" type="button" class="chat-menu-item" role="menuitem">Keyboard shortcuts<\/button>/);
  assert.match(WWW("search-palette.js"), /event\.key === "k"/);
  assert.match(WWW("styles.css"), /\.shortcuts-combo kbd\{[^}]*var\(--surface-2\)/);
});
