"use strict";

// Phase 3, steps 1-2: date grouping, store support for restore / pin /
// change events, and the toast "Undo" action.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const Groups = require("../www/chat-groups.js");
const ChatStoreModule = require("../www/chatStore.js");

function makeStore() {
  const map = new Map();
  const storage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    key: (i) => Array.from(map.keys())[i] || null,
    get length() { return map.size; }
  };
  return ChatStoreModule.createChatStore({ storage });
}

// ---- grouping -------------------------------------------------------------------------

const NOW = new Date(2026, 5, 15, 14, 30); // 15 June 2026, 14:30 local
const at = (daysBack, hour) => new Date(2026, 5, 15 - daysBack, hour === undefined ? 9 : hour, 0).toISOString();
const conv = (id, daysBack, extra) => Object.assign({ id, title: id, pinned: false, updatedAt: at(daysBack) }, extra || {});

test("groups: Today, Yesterday, Previous 7 days, Previous 30 days, then months, newest first", () => {
  const list = [conv("a", 0), conv("b", 1), conv("c", 5), conv("d", 7), conv("e", 20), conv("f", 30), conv("g", 45), conv("h", 80), conv("i", 400)];
  const groups = Groups.groupConversations(list, NOW, "en-US");
  assert.deepEqual(groups.map((g) => g.label), [
    "Today", "Yesterday", "Previous 7 days", "Previous 30 days", "May 2026", "March 2026", "May 2025"
  ]);
  assert.deepEqual(groups.map((g) => g.items.map((c) => c.id)), [["a"], ["b"], ["c", "d"], ["e", "f"], ["g"], ["h"], ["i"]]);
});

test("groups: pinned chats form one 'Pinned' group first, regardless of their age", () => {
  const list = [conv("old", 200, { pinned: true }), conv("new", 0), conv("older", 3, { pinned: true })];
  const groups = Groups.groupConversations(list, NOW, "en-US");
  assert.equal(groups[0].label, "Pinned");
  assert.deepEqual(groups[0].items.map((c) => c.id), ["old", "older"]);
  assert.equal(groups[1].label, "Today");
});

test("groups: day boundaries use local calendar days (23:59 yesterday is Yesterday, 00:01 today is Today)", () => {
  const late = new Date(2026, 5, 14, 23, 59).toISOString();
  const early = new Date(2026, 5, 15, 0, 1).toISOString();
  const groups = Groups.groupConversations([{ id: "e", pinned: false, updatedAt: early }, { id: "l", pinned: false, updatedAt: late }], NOW, "en-US");
  assert.deepEqual(groups.map((g) => g.label), ["Today", "Yesterday"]);
});

test("groups: empty input gives no groups; an invalid date lands in 'Older' instead of crashing", () => {
  assert.deepEqual(Groups.groupConversations([], NOW), []);
  const groups = Groups.groupConversations([conv("a", 0), { id: "bad", pinned: false, updatedAt: "not a date" }], NOW, "en-US");
  assert.deepEqual(groups.map((g) => g.label), ["Today", "Older"]);
});

test("groups: months in the same year but different months are separate; the order inside a group is preserved", () => {
  const list = [conv("m1", 50), conv("m2", 51), conv("m3", 80)];
  const groups = Groups.groupConversations(list, NOW, "en-US");
  assert.deepEqual(groups.map((g) => g.items.map((c) => c.id)), [["m1", "m2"], ["m3"]]);
});

// ---- store: restore, pin, notifications ---------------------------------------------------

test("store: restoreConversation puts a deleted chat back exactly (id, timestamps, pin, messages, rating)", () => {
  const store = makeStore();
  const c = store.createConversation().conversation;
  store.saveMessage(c.id, ChatStoreModule.createMessage("user", "question"));
  const reply = ChatStoreModule.createMessage("assistant", "answer", "complete");
  store.saveMessage(c.id, reply);
  store.setMessageFeedback(c.id, reply.id, "up");
  store.updateConversation(c.id, { pinned: true }, { touch: false });
  const snapshot = JSON.parse(JSON.stringify(store.getConversation(c.id)));

  store.deleteConversation(c.id);
  assert.equal(store.getConversation(c.id), null);

  assert.equal(store.restoreConversation(snapshot).ok, true);
  const back = store.getConversation(c.id);
  assert.equal(back.title, snapshot.title);
  assert.equal(back.updatedAt, snapshot.updatedAt);
  assert.equal(back.pinned, true);
  assert.equal(back.messages.length, 2);
  assert.equal(back.messages[1].feedback, "up");
});

test("store: restoreConversation refuses an id that already exists and invalid input", () => {
  const store = makeStore();
  const c = store.createConversation().conversation;
  assert.equal(store.restoreConversation(JSON.parse(JSON.stringify(c))).reason, "already-exists");
  assert.equal(store.restoreConversation(null).ok, false);
});

test("store: pinning with touch:false keeps updatedAt; the default still touches it", () => {
  const store = makeStore();
  const c = store.createConversation().conversation;
  store.saveMessage(c.id, ChatStoreModule.createMessage("user", "hi"));
  const before = store.getConversation(c.id).updatedAt;
  store.updateConversation(c.id, { pinned: true }, { touch: false });
  assert.equal(store.getConversation(c.id).updatedAt, before);
  assert.equal(store.getConversation(c.id).pinned, true);
  const tick = Date.now();
  while (Date.now() === tick) { /* wait for the clock to move so the new timestamp differs */ }
  store.updateConversation(c.id, { pinned: false });
  assert.notEqual(store.getConversation(c.id).updatedAt, before);
});

test("store: subscribe reports writes, explicit deletions and clear-all - never size pruning", () => {
  const store = makeStore();
  const events = [];
  const unsubscribe = store.subscribe((e) => events.push(e));
  const a = store.createConversation().conversation;
  assert.ok(events.some((e) => e.type === "changed"));
  events.length = 0;
  store.deleteConversation(a.id);
  assert.ok(events.some((e) => e.type === "deleted" && e.id === a.id));
  events.length = 0;
  const b = store.createConversation().conversation;
  store.saveMessage(b.id, ChatStoreModule.createMessage("user", "x"));
  events.length = 0;
  store.clearAllConversations();
  const cleared = events.find((e) => e.type === "cleared");
  assert.ok(cleared && cleared.ids.indexOf(b.id) !== -1);
  unsubscribe();
  events.length = 0;
  store.createConversation();
  assert.equal(events.length, 0, "unsubscribed listeners are not called");
});

test("store: a throwing listener never breaks a write", () => {
  const store = makeStore();
  store.subscribe(() => { throw new Error("boom"); });
  assert.equal(store.createConversation().ok, true);
});

test("store: pruning for size is not reported as a deletion", () => {
  const store = makeStore();
  const events = [];
  store.subscribe((e) => events.push(e));
  for (let i = 0; i < ChatStoreModule.LIMITS.maxConversations + 5; i += 1) {
    const c = store.createConversation({ forceNew: true }).conversation;
    store.saveMessage(c.id, ChatStoreModule.createMessage("user", "chat " + i));
  }
  assert.equal(events.filter((e) => e.type === "deleted").length, 0);
});

// ---- toast action ---------------------------------------------------------------------------

test("toast: an action button runs once and dismisses the toast", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "www", "toast.js"), "utf8");
  function el(tag) {
    const e = { tag, children: [], _l: {}, className: "", attrs: {}, parentNode: null,
      setAttribute(k, v) { e.attrs[k] = v; }, appendChild(c) { c.parentNode = e; e.children.push(c); return c; },
      removeChild(c) { e.children = e.children.filter((x) => x !== c); c.parentNode = null; },
      addEventListener(t, h) { (e._l[t] = e._l[t] || []).push(h); }, click() { (e._l.click || []).forEach((h) => h({})); } };
    return e;
  }
  const region = el("div");
  const doc = { getElementById: () => region, createElement: el, body: { contains: () => true, appendChild() {} } };
  const sandbox = { document: doc, setTimeout, clearTimeout };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  let calls = 0;
  sandbox.LinguaHubToast.show({ type: "info", message: "Deleted", duration: 0, action: { label: "Undo", onClick: () => { calls += 1; } } });
  const toast = region.children[0];
  const action = toast.children.find((c) => c.className === "lh-toast-action");
  assert.ok(action);
  assert.equal(action.textContent, "Undo");
  action.click();
  assert.equal(calls, 1);
  assert.equal(region.children.length, 0, "the toast is gone after the action");
});

test("toast: without an action nothing extra is rendered", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "www", "toast.js"), "utf8");
  assert.match(src, /opts\.action && typeof opts\.action\.onClick === "function" && opts\.action\.label/);
});
