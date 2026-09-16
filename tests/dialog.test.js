"use strict";

// Executes the real www/dialog.js source inside a sandboxed vm context with
// a minimal fake DOM - no jsdom dependency.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const DIALOG_SRC = fs.readFileSync(path.join(__dirname, "..", "www", "dialog.js"), "utf8");

function createFakeElement(tag) {
  const el = {
    tag,
    _listeners: {},
    _attrs: {},
    children: [],
    textContent: "",
    className: "",
    tabIndex: 0,
    id: "",
    value: "",
    disabled: false,
    focus() { el._focused = true; },
    select() {},
    setAttribute(name, v) { this._attrs[name] = v; },
    getAttribute(name) { return this._attrs[name]; },
    addEventListener(event, handler) { (this._listeners[event] = this._listeners[event] || []).push(handler); },
    appendChild(child) { this.children.push(child); return child; },
    insertBefore(newNode, referenceNode) {
      if (!referenceNode) { this.children.push(newNode); return newNode; }
      const idx = this.children.indexOf(referenceNode);
      if (idx === -1) this.children.push(newNode);
      else this.children.splice(idx, 0, newNode);
      return newNode;
    },
    remove() { el._removed = true; },
    querySelector(sel) {
      if (sel === ".lh-dialog-actions") return el._actionsEl || null;
      return null;
    },
    querySelectorAll() {
      // Focus trap target list: cancel/confirm buttons (and the prompt
      // input, if present) in DOM order.
      return el._focusable || [];
    },
    click() { (this._listeners.click || []).forEach((h) => h({ target: el })); },
    dispatch(event, evt) { (this._listeners[event] || []).forEach((h) => h(evt)); }
  };
  return el;
}

function buildSandbox() {
  const body = createFakeElement("body");
  const createdElements = [];

  const documentStub = {
    createElement(tag) {
      const el = createFakeElement(tag);
      createdElements.push(el);
      return el;
    },
    body,
    activeElement: null,
    addEventListener(event, handler, useCapture) {
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

  const sandbox = { console, setTimeout, clearTimeout, document: documentStub };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(DIALOG_SRC, sandbox, { filename: "dialog.js" });

  return { sandbox, documentStub, createdElements };
}

// After LinguaHubDialog builds the DOM, wire up the fake focus-trap target
// list and locate the cancel/confirm buttons for the tests to click.
function locateButtons(dialogEl) {
  const actions = dialogEl.children[dialogEl.children.length - 1];
  const [cancelBtn, confirmBtn] = actions.children;
  return { cancelBtn, confirmBtn, actions };
}

test("confirm() resolves true when the confirm button is clicked", async () => {
  const { sandbox, documentStub } = buildSandbox();
  const promise = sandbox.LinguaHubDialog.confirm({ title: "Delete?", message: "Sure?" });
  const backdrop = documentStub.body.children[documentStub.body.children.length - 1];
  const dialogEl = backdrop.children[0];
  const { confirmBtn } = locateButtons(dialogEl);
  confirmBtn.click();
  assert.equal(await promise, true);
});

test("confirm() resolves false when the cancel button is clicked", async () => {
  const { sandbox, documentStub } = buildSandbox();
  const promise = sandbox.LinguaHubDialog.confirm({ title: "Delete?" });
  const backdrop = documentStub.body.children[0];
  const dialogEl = backdrop.children[0];
  const { cancelBtn } = locateButtons(dialogEl);
  cancelBtn.click();
  assert.equal(await promise, false);
});

test("confirm() resolves false on Escape", async () => {
  const { sandbox, documentStub } = buildSandbox();
  const promise = sandbox.LinguaHubDialog.confirm({ title: "Delete?" });
  documentStub.fireKeydown({ key: "Escape", preventDefault() {} });
  assert.equal(await promise, false);
});

test("confirm() resolves false when the backdrop itself is clicked (not the dialog box)", async () => {
  const { sandbox, documentStub } = buildSandbox();
  const promise = sandbox.LinguaHubDialog.confirm({ title: "Delete?" });
  const backdrop = documentStub.body.children[0];
  backdrop.dispatch("mousedown", { target: backdrop });
  assert.equal(await promise, false);
});

test("focus is restored to the previously focused element after closing", async () => {
  const { sandbox, documentStub } = buildSandbox();
  const trigger = createFakeElement("button");
  documentStub.activeElement = trigger;

  const promise = sandbox.LinguaHubDialog.confirm({ title: "Delete?" });
  documentStub.fireKeydown({ key: "Escape", preventDefault() {} });
  await promise;

  assert.equal(trigger._focused, true);
});

test("opening a second dialog while one is open cancels the first instead of stacking", async () => {
  const { sandbox, documentStub } = buildSandbox();
  const firstPromise = sandbox.LinguaHubDialog.confirm({ title: "First" });
  const secondPromise = sandbox.LinguaHubDialog.confirm({ title: "Second" });

  assert.equal(await firstPromise, null, "the superseded dialog resolves (not left pending forever)");

  const backdrops = documentStub.body.children.filter((c) => !c._removed);
  assert.equal(backdrops.length, 1, "only one dialog backdrop should remain in the DOM");

  const dialogEl = backdrops[0].children[0];
  const { confirmBtn } = locateButtons(dialogEl);
  confirmBtn.click();
  assert.equal(await secondPromise, true);
});

test("prompt() resolves the trimmed input value on confirm", async () => {
  const { sandbox, documentStub } = buildSandbox();
  const promise = sandbox.LinguaHubDialog.prompt({ title: "Rename", defaultValue: "Old" });
  const backdrop = documentStub.body.children[0];
  const dialogEl = backdrop.children[0];
  const fieldEl = dialogEl.children[dialogEl.children.length - 2]; // inserted before actions
  const input = fieldEl.children[0];
  input.value = "  New Title  ";
  const { confirmBtn } = locateButtons(dialogEl);
  confirmBtn.click();
  assert.equal(await promise, "New Title");
});

test("prompt() rejects an empty value with an inline error instead of resolving", async () => {
  const { sandbox, documentStub } = buildSandbox();
  const promise = sandbox.LinguaHubDialog.prompt({ title: "Rename", defaultValue: "" });
  const backdrop = documentStub.body.children[0];
  const dialogEl = backdrop.children[0];
  const fieldEl = dialogEl.children[dialogEl.children.length - 2];
  const [input, errorEl] = fieldEl.children;
  input.value = "   ";
  const { confirmBtn } = locateButtons(dialogEl);
  confirmBtn.click();

  assert.match(errorEl.textContent, /empty/i);

  input.value = "Real Title";
  confirmBtn.click();
  assert.equal(await promise, "Real Title");
});

test("prompt() resolves null when cancelled", async () => {
  const { sandbox, documentStub } = buildSandbox();
  const promise = sandbox.LinguaHubDialog.prompt({ title: "Rename", defaultValue: "X" });
  const backdrop = documentStub.body.children[0];
  const dialogEl = backdrop.children[0];
  const { cancelBtn } = locateButtons(dialogEl);
  cancelBtn.click();
  assert.equal(await promise, null);
});
