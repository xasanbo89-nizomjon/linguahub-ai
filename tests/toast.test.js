"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const TOAST_SRC = fs.readFileSync(path.join(__dirname, "..", "www", "toast.js"), "utf8");

function createFakeElement(tag) {
  return {
    tag,
    _listeners: {},
    _attrs: {},
    children: [],
    textContent: "",
    className: "",
    parentNode: null,
    setAttribute(name, v) { this._attrs[name] = v; },
    getAttribute(name) { return this._attrs[name]; },
    addEventListener(event, handler) { (this._listeners[event] = this._listeners[event] || []).push(handler); },
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    removeChild(child) {
      this.children = this.children.filter((c) => c !== child);
      child.parentNode = null;
    },
    contains(el) { return this.children.includes(el); },
    click() { (this._listeners.click || []).forEach((h) => h()); }
  };
}

function buildSandbox() {
  const body = createFakeElement("body");
  const documentStub = {
    getElementById: () => null,
    createElement: (tag) => createFakeElement(tag),
    body
  };
  const sandbox = { console, setTimeout, clearTimeout, document: documentStub };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(TOAST_SRC, sandbox, { filename: "toast.js" });
  return { sandbox, documentStub, body };
}

test("show() renders a toast with the message text and correct type class", () => {
  const { sandbox, body } = buildSandbox();
  sandbox.LinguaHubToast.show({ type: "success", message: "Exported." });
  const region = body.children[0];
  const toastEl = region.children[0];
  assert.equal(toastEl.className, "lh-toast lh-toast-success");
  assert.equal(toastEl.children[0].textContent, "Exported.");
});

test("an invalid/unknown type falls back to 'info' rather than crashing", () => {
  const { sandbox, body } = buildSandbox();
  sandbox.LinguaHubToast.show({ type: "bogus", message: "hi" });
  const toastEl = body.children[0].children[0];
  assert.equal(toastEl.className, "lh-toast lh-toast-info");
});

test("dismiss() removes the toast from the DOM", () => {
  const { sandbox, body } = buildSandbox();
  const dismiss = sandbox.LinguaHubToast.show({ type: "info", message: "hi", duration: 0 });
  const region = body.children[0];
  assert.equal(region.children.length, 1);
  dismiss();
  assert.equal(region.children.length, 0);
});

test("clicking the close button dismisses the toast", () => {
  const { sandbox, body } = buildSandbox();
  sandbox.LinguaHubToast.show({ type: "info", message: "hi", duration: 0 });
  const region = body.children[0];
  const toastEl = region.children[0];
  const closeBtn = toastEl.children[1];
  closeBtn.click();
  assert.equal(region.children.length, 0);
});

test("a toast auto-dismisses after its duration", async () => {
  const { sandbox, body } = buildSandbox();
  sandbox.LinguaHubToast.show({ type: "info", message: "hi", duration: 20 });
  const region = body.children[0];
  assert.equal(region.children.length, 1);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(region.children.length, 0);
});

test("duration: 0 means the toast is never auto-dismissed", async () => {
  const { sandbox, body } = buildSandbox();
  sandbox.LinguaHubToast.show({ type: "info", message: "persistent", duration: 0 });
  await new Promise((r) => setTimeout(r, 20));
  const region = body.children[0];
  assert.equal(region.children.length, 1);
});

test("no stacking overflow: showing more than the visible cap evicts the oldest toast", () => {
  const { sandbox, body } = buildSandbox();
  sandbox.LinguaHubToast.show({ type: "info", message: "one", duration: 0 });
  sandbox.LinguaHubToast.show({ type: "info", message: "two", duration: 0 });
  sandbox.LinguaHubToast.show({ type: "info", message: "three", duration: 0 });
  sandbox.LinguaHubToast.show({ type: "info", message: "four", duration: 0 });

  const region = body.children[0];
  assert.ok(region.children.length <= 3, "no more than the max-visible cap should be shown at once");
  const messages = region.children.map((t) => t.children[0].textContent);
  assert.equal(messages.includes("one"), false, "the oldest toast should have been evicted");
  assert.equal(messages.includes("four"), true);
});

test("the toast region has aria-live=polite for screen-reader announcements", () => {
  const { sandbox, body } = buildSandbox();
  sandbox.LinguaHubToast.show({ type: "info", message: "hi" });
  const region = body.children[0];
  assert.equal(region.getAttribute("aria-live"), "polite");
});
