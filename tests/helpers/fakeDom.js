"use strict";

// Shared minimal fake-DOM element for the www/*.js vm-executed tests
// (no jsdom for these - jsdom is used only where a real HTML parser is
// required, e.g. tests/markdown.test.js). Supports just enough of the real
// DOM API for these files' actual usage: attributes, classList, a simple
// single-class-or-tag-name selector engine for querySelector/closest, and
// real event *bubbling* on click() so a single delegated listener (as
// www/app.js now uses for message actions) behaves the same way it does
// in a real browser.

function hasClass(el, cls) {
  // Production code in this project sets `.className = "a b c"` as a plain
  // string far more often than it calls `.classList.add(...)` - a real
  // browser keeps className/classList in sync automatically, so this fake
  // must check both to match that behavior instead of only the classList
  // Set (which stays empty unless .classList.add was called directly).
  if (el.classList && el.classList.contains(cls)) return true;
  var className = typeof el.className === "string" ? el.className : "";
  return className.split(/\s+/).indexOf(cls) !== -1;
}

function matchesSelector(el, selector) {
  if (!el || !selector) return false;
  return selector.split(",").map((s) => s.trim()).some((sel) => {
    if (sel.startsWith(".")) {
      return hasClass(el, sel.slice(1));
    }
    return el.tag === sel;
  });
}

function findInTree(root, selector, single) {
  const results = [];
  function walk(node) {
    for (const child of node.children) {
      if (matchesSelector(child, selector)) {
        results.push(child);
        if (single) return true;
      }
      if (walk(child)) return true;
    }
    return false;
  }
  walk(root);
  return single ? (results[0] || null) : results;
}

function createFakeElement(tag) {
  const el = {
    tag: tag || "div",
    _listeners: {},
    _attrs: {},
    _text: "",
    dataset: {},
    value: "",
    disabled: false,
    hidden: false,
    innerHTML: "",
    className: "",
    style: {},
    src: "",
    alt: "",
    href: "",
    download: "",
    files: null,
    maxLength: 0,
    options: [],
    children: [],
    parentNode: null,
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    id: "",
    tabIndex: 0,
    addEventListener(event, handler) {
      (this._listeners[event] = this._listeners[event] || []).push(handler);
    },
    removeEventListener(event, handler) {
      this._listeners[event] = (this._listeners[event] || []).filter((h) => h !== handler);
    },
    setAttribute(name, value) { this._attrs[name] = value; },
    getAttribute(name) { return this._attrs[name]; },
    removeAttribute(name) { delete this._attrs[name]; if (name === "src") this.src = ""; },
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    insertBefore(newNode, referenceNode) {
      newNode.parentNode = this;
      if (!referenceNode) { this.children.push(newNode); return newNode; }
      const idx = this.children.indexOf(referenceNode);
      if (idx === -1) this.children.push(newNode);
      else this.children.splice(idx, 0, newNode);
      return newNode;
    },
    remove() {
      if (this.parentNode) {
        this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
        this.parentNode = null;
      }
    },
    querySelector(selector) { return findInTree(this, selector, true); },
    querySelectorAll(selector) { return findInTree(this, selector, false); },
    closest(selector) {
      let node = this;
      while (node) {
        if (matchesSelector(node, selector)) return node;
        node = node.parentNode;
      }
      return null;
    },
    focus() { this._focused = true; },
    select() {},
    setSelectionRange() {},
    // Simulates real bubbling: fires listeners on this element, then walks
    // up parentNode calling ancestor click listeners too, exactly what a
    // single delegated listener on a container (e.g. #chat-box) relies on.
    click() {
      const event = { type: "click", target: el, _stopped: false, preventDefault() {}, stopPropagation() { event._stopped = true; } };
      let node = el;
      while (node && !event._stopped) {
        (node._listeners.click || []).slice().forEach((h) => h(event));
        node = node.parentNode;
      }
    },
    dispatch(eventName, evt) {
      (this._listeners[eventName] || []).forEach((h) => h(evt || {}));
    }
  };
  el.classList = {
    _set: new Set(),
    add(c) { this._set.add(c); },
    remove(c) { this._set.delete(c); },
    contains(c) { return this._set.has(c); },
    toggle(c, force) {
      const shouldAdd = typeof force === "boolean" ? force : !this._set.has(c);
      if (shouldAdd) this._set.add(c); else this._set.delete(c);
      return shouldAdd;
    }
  };
  // Matches real DOM: setting .textContent removes all existing child
  // nodes (e.g. a previously-appended typing-indicator element) and
  // replaces them with a single text node - production code relies on
  // this (see www/app.js's typing indicator).
  Object.defineProperty(el, "textContent", {
    get() { return this._text; },
    set(value) {
      this._text = value == null ? "" : String(value);
      this.children.forEach((child) => { child.parentNode = null; });
      this.children = [];
    },
    enumerable: true,
    configurable: true
  });
  return el;
}

module.exports = { createFakeElement, matchesSelector, findInTree };
