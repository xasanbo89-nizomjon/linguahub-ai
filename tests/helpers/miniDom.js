"use strict";

// A small DOM for the www/*.js screens that build their own markup: elements
// with attributes, classList, text, selectors by class/tag, events that bubble
// up to the document (so "click outside" handlers work), focus tracking, and
// no createElementNS (so SVG icons take their documented text fallbacks).

function createDom() {
  const docListeners = {};
  const byId = {};

  class El {
    constructor(tag) {
      this.tag = tag;
      this.children = [];
      this.attrs = {};
      this.className = "";
      this.hidden = false;
      this.disabled = false;
      this.value = "";
      this.files = null;
      this.parentNode = null;
      this.style = {};
      this._l = {};
      this._text = "";
      this.nodeType = 1;
    }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === "id") byId[v] = this; if (k === "class") this.className = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    removeAttribute(k) { delete this.attrs[k]; }
    set id(v) { this.attrs.id = String(v); byId[v] = this; }
    get id() { return this.attrs.id || ""; }
    get classList() {
      const self = this;
      const tokens = () => String(self.className).split(/\s+/).filter(Boolean);
      return {
        add(...c) { const t = tokens(); c.forEach((x) => { if (t.indexOf(x) === -1) t.push(x); }); self.className = t.join(" "); },
        remove(...c) { self.className = tokens().filter((x) => c.indexOf(x) === -1).join(" "); },
        contains(c) { return tokens().indexOf(c) !== -1; },
        toggle(c, force) {
          const has = tokens().indexOf(c) !== -1;
          const want = typeof force === "boolean" ? force : !has;
          if (want && !has) this.add(c); else if (!want && has) this.remove(c);
          return want;
        }
      };
    }
    appendChild(c) {
      if (c.parentNode && c.parentNode.removeChild) c.parentNode.removeChild(c);
      c.parentNode = this;
      this.children.push(c);
      return c;
    }
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i !== -1) this.children.splice(i, 1);
      c.parentNode = null;
      return c;
    }
    insertBefore(c, ref) {
      if (c.parentNode && c.parentNode.removeChild) c.parentNode.removeChild(c);
      const i = ref ? this.children.indexOf(ref) : -1;
      c.parentNode = this;
      if (i === -1) this.children.push(c); else this.children.splice(i, 0, c);
      return c;
    }
    contains(o) {
      if (o === this) return true;
      return this.children.some((c) => c.contains && c.contains(o));
    }
    addEventListener(type, h) { (this._l[type] = this._l[type] || []).push(h); }
    removeEventListener(type, h) { this._l[type] = (this._l[type] || []).filter((x) => x !== h); }
    dispatch(type, extra) {
      const ev = Object.assign({ type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this._stop = true; } }, extra || {});
      let node = this;
      while (node && !ev._stop) {
        (node._l[type] || []).slice().forEach((h) => h(ev));
        node = node.parentNode;
      }
      if (!ev._stop) (docListeners[type] || []).slice().forEach((h) => h(ev));
      return ev;
    }
    dispatchEvent(ev) { return this.dispatch(ev.type, ev); }
    click() { if (!this.disabled) this.dispatch("click"); }
    focus() { document.activeElement = this; }
    blur() { if (document.activeElement === this) document.activeElement = null; }
    set textContent(v) { this._text = String(v); this.children = []; }
    get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join("") : this._text; }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    matches(sel) {
      if (sel.startsWith(".")) return String(this.className).split(/\s+/).indexOf(sel.slice(1)) !== -1;
      return this.tag === sel;
    }
    closest(sel) { let n = this; while (n) { if (n.matches && n.matches(sel)) return n; n = n.parentNode; } return null; }
    querySelectorAll(sel) {
      const out = [];
      const selectors = sel.split(",").map((s) => s.trim());
      (function walk(n) {
        n.children.forEach((c) => {
          if (c.nodeType === 1) {
            if (selectors.some((s) => c.matches(s))) out.push(c);
            walk(c);
          }
        });
      })(this);
      return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    scrollIntoView() {}
    getBoundingClientRect() { return { left: 100, right: 160, top: 100, bottom: 120, width: 60, height: 20 }; }
  }

  const body = new El("body");
  const document = {
    body,
    activeElement: null,
    hidden: false,
    createElement: (tag) => new El(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text), parentNode: null, children: [], contains: () => false }),
    getElementById: (id) => byId[id] || null,
    addEventListener(type, h) { (docListeners[type] = docListeners[type] || []).push(h); },
    removeEventListener(type, h) { docListeners[type] = (docListeners[type] || []).filter((x) => x !== h); },
    dispatchEvent(ev) { (docListeners[ev.type] || []).slice().forEach((h) => h(ev)); return true; },
    querySelector: () => null
  };

  // every element under `root` (depth first, including root)
  function all(root) {
    const out = [];
    (function walk(n) { out.push(n); (n.children || []).forEach(walk); })(root);
    return out;
  }
  const byClass = (root, cls) => all(root).filter((n) => n.nodeType === 1 && n.matches && n.matches("." + cls));
  const byTag = (root, tag) => all(root).filter((n) => n.nodeType === 1 && n.tag === tag);

  return { document, El, all, byClass, byTag, docListeners };
}

module.exports = { createDom };
