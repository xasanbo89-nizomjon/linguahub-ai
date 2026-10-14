"use strict";

// Phase 3, step 4: chat sync between devices, with a fake Firestore shared by
// two simulated devices (each with its own localStorage and chat store).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const Sync = require("../www/chat-sync.js");
const Store = require("../www/chatStore.js");

const UID = "user-1";

function makeServer() {
  const docs = new Map();
  const listeners = [];
  const server = {
    docs, failWrites: false, writes: [],
    remoteFor() {
      return {
        available: () => true,
        listen(uid, onDocs) {
          const l = { uid, onDocs };
          listeners.push(l);
          const initial = [...docs.values()].filter((d) => d.userId === uid);
          Promise.resolve().then(() => onDocs(JSON.parse(JSON.stringify(initial)), true));
          return () => { const i = listeners.indexOf(l); if (i !== -1) listeners.splice(i, 1); };
        },
        write(uid, convId, data) {
          return Promise.resolve().then(() => {
            if (server.failWrites) throw new Error("offline write failed");
            const copy = JSON.parse(JSON.stringify(data));
            docs.set(uid + "__" + convId, copy);
            server.writes.push({ convId, deleted: copy.deleted === true });
            listeners.filter((l) => l.uid === uid).forEach((l) => Promise.resolve().then(() => l.onDocs([JSON.parse(JSON.stringify(copy))], false)));
          });
        }
      };
    }
  };
  return server;
}

function makeDevice(server, overrides) {
  const map = new Map();
  const storage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    key: (i) => Array.from(map.keys())[i] || null,
    get length() { return map.size; }
  };
  const store = Store.createChatStore({ storage });
  store.setUserId(UID);
  const device = { storage, store, online: true, changes: [], statuses: [] };
  device.sync = Sync.create(Object.assign({
    store, storage,
    remote: server.remoteFor(),
    isOnline: () => device.online,
    flushDebounceMs: 0,
    onRemoteChange: (ids) => device.changes.push(ids)
  }, overrides || {}));
  device.sync.onStatusChange((s) => device.statuses.push(s));
  return device;
}

async function quiesce(...devices) {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
    for (const d of devices) await d.sync.idle();
  }
}

function addChat(device, title, text) {
  const c = device.store.createConversation().conversation;
  device.store.saveMessage(c.id, Store.createMessage("user", text || title));
  device.store.saveMessage(c.id, Store.createMessage("assistant", "reply to " + (text || title), "complete"));
  device.store.renameConversation(c.id, title);
  return c.id;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const titles = (device) => device.store.listConversations().map((c) => c.title).sort();

// ---- basics -------------------------------------------------------------------------------

test("sync: a chat made on device A appears on device B", async () => {
  const server = makeServer();
  const a = makeDevice(server);
  const id = addChat(a, "Verbs");
  a.sync.start({ uid: UID });
  await quiesce(a);
  assert.ok(server.docs.has(UID + "__" + id), "uploaded");

  const b = makeDevice(server);
  b.sync.start({ uid: UID });
  await quiesce(a, b);
  const got = b.store.getConversation(id);
  assert.ok(got, "downloaded");
  assert.equal(got.title, "Verbs");
  assert.equal(got.messages.length, 2);
  assert.deepEqual(b.changes.flat(), [id], "the UI is told which chat arrived");
});

test("sync: edits flow live to the other device (new message, rename, pin)", async () => {
  const server = makeServer();
  const a = makeDevice(server); const b = makeDevice(server);
  const id = addChat(a, "Live chat");
  a.sync.start({ uid: UID }); b.sync.start({ uid: UID });
  await quiesce(a, b);
  assert.ok(b.store.getConversation(id));

  a.store.saveMessage(id, Store.createMessage("user", "a brand new question"));
  await quiesce(a, b);
  assert.equal(b.store.getConversation(id).messages.length, 3);

  a.store.renameConversation(id, "Renamed on A");
  await quiesce(a, b);
  assert.equal(b.store.getConversation(id).title, "Renamed on A");

  a.store.updateConversation(id, { pinned: true }, { touch: false });
  await quiesce(a, b);
  assert.equal(b.store.getConversation(id).pinned, true, "a pin change syncs even though updatedAt did not move");
});

test("sync: signature ignores ratings, and ratings are never uploaded", async () => {
  const server = makeServer();
  const a = makeDevice(server);
  const id = addChat(a, "Rated");
  a.sync.start({ uid: UID });
  await quiesce(a);
  const before = server.writes.length;
  const reply = a.store.getConversation(id).messages[1];
  a.store.setMessageFeedback(id, reply.id, "up");
  await quiesce(a);
  assert.equal(server.writes.length, before, "rating a reply is not a sync-worthy change");
  assert.doesNotMatch(JSON.stringify([...server.docs.values()]), /feedback/);
});

test("sync: applying a remote update keeps this device's own ratings", async () => {
  const server = makeServer();
  const a = makeDevice(server); const b = makeDevice(server);
  const id = addChat(a, "Ratings stay");
  a.sync.start({ uid: UID }); b.sync.start({ uid: UID });
  await quiesce(a, b);
  const reply = b.store.getConversation(id).messages[1];
  b.store.setMessageFeedback(id, reply.id, "down");
  a.store.saveMessage(id, Store.createMessage("user", "more"));
  await quiesce(a, b);
  assert.equal(b.store.getConversation(id).messages.length, 3);
  assert.equal(b.store.getConversation(id).messages[1].feedback, "down");
});

// ---- deletions ------------------------------------------------------------------------------

test("sync: deleting on A removes the chat on B (tombstone), when B has not changed it", async () => {
  const server = makeServer();
  const a = makeDevice(server); const b = makeDevice(server);
  const id = addChat(a, "Doomed");
  a.sync.start({ uid: UID }); b.sync.start({ uid: UID });
  await quiesce(a, b);
  assert.ok(b.store.getConversation(id));

  a.store.deleteConversation(id);
  await quiesce(a, b);
  assert.equal(b.store.getConversation(id), null);
  assert.equal(server.docs.get(UID + "__" + id).deleted, true);
  assert.equal(server.docs.get(UID + "__" + id).messages, "[]", "no content is kept in a tombstone");
});

test("sync: a chat edited on B after the last sync survives a delete on A and is restored everywhere", async () => {
  const server = makeServer();
  const a = makeDevice(server); const b = makeDevice(server);
  const id = addChat(a, "Contested");
  a.sync.start({ uid: UID }); b.sync.start({ uid: UID });
  await quiesce(a, b);

  b.online = false; // B edits while disconnected from the delete
  b.sync.stop();
  b.store.saveMessage(id, Store.createMessage("user", "important late edit"));
  a.store.deleteConversation(id);
  await quiesce(a);
  assert.equal(server.docs.get(UID + "__" + id).deleted, true);

  b.online = true;
  b.sync.start({ uid: UID });
  await quiesce(a, b);
  assert.ok(b.store.getConversation(id), "B keeps its edited copy");
  assert.equal(server.docs.get(UID + "__" + id).deleted, false, "and uploads it again");
  await quiesce(a, b);
  assert.ok(a.store.getConversation(id), "A gets it back");
  assert.equal(a.store.getConversation(id).messages.length, 3);
});

test("sync: a delete made while offline is published when the device comes back", async () => {
  const server = makeServer();
  const a = makeDevice(server);
  const id = addChat(a, "Offline delete");
  a.sync.start({ uid: UID });
  await quiesce(a);

  a.online = false;
  a.store.deleteConversation(id);
  await quiesce(a);
  assert.equal(server.docs.get(UID + "__" + id).deleted, false, "nothing sent while offline");
  assert.deepEqual(a.sync._state().pendingDeletes, [id]);

  a.online = true;
  a.sync.connectivityChanged();
  await quiesce(a);
  assert.equal(server.docs.get(UID + "__" + id).deleted, true);
  assert.deepEqual(a.sync._state().pendingDeletes, []);
});

test("sync: a chat that disappears locally WITHOUT an explicit delete (size pruning) is neither tombstoned nor resurrected", async () => {
  const server = makeServer();
  const a = makeDevice(server);
  const id = addChat(a, "Pruned away");
  a.sync.start({ uid: UID });
  await quiesce(a);

  // simulate pruning: remove it straight from storage, bypassing the store's delete path
  const key = a.storage.key(0);
  const namespaceKey = [...Array(a.storage.length).keys()].map((i) => a.storage.key(i)).find((k) => /user/.test(k) && !/sync/.test(k));
  const data = JSON.parse(a.storage.getItem(namespaceKey));
  data.conversations = data.conversations.filter((c) => c.id !== id);
  a.storage.setItem(namespaceKey, JSON.stringify(data));
  assert.equal(a.store.getConversation(id), null);

  a.sync.start({ uid: UID }); // fresh listener, full reconcile
  await quiesce(a);
  assert.equal(server.docs.get(UID + "__" + id).deleted, false, "remote copy is untouched");
  assert.equal(a.store.getConversation(id), null, "and it is not pulled back in either");
  assert.ok(key !== undefined);
});

// ---- conflicts / safety ------------------------------------------------------------------------

test("sync: when both devices changed the same chat, the newer update wins on both", async () => {
  const server = makeServer();
  const a = makeDevice(server); const b = makeDevice(server);
  const id = addChat(a, "Conflict");
  a.sync.start({ uid: UID }); b.sync.start({ uid: UID });
  await quiesce(a, b);

  b.sync.stop();
  b.store.saveMessage(id, Store.createMessage("user", "B wrote this first"));
  await wait(15);
  a.store.saveMessage(id, Store.createMessage("user", "A wrote this later"));
  await quiesce(a);

  b.sync.start({ uid: UID });
  await quiesce(a, b);
  const last = (d) => d.store.getConversation(id).messages.map((m) => m.content).join("|");
  assert.equal(last(a), last(b), "both devices converge");
  assert.match(last(b), /A wrote this later/);
});

test("sync: a chat that is still streaming is neither uploaded nor overwritten until it settles", async () => {
  const server = makeServer();
  const a = makeDevice(server);
  const c = a.store.createConversation().conversation;
  a.store.saveMessage(c.id, Store.createMessage("user", "question"));
  const streaming = Store.createMessage("assistant", "partial answ", "streaming");
  a.store.saveMessage(c.id, streaming);
  a.sync.setGenerating(c.id); // what app.js does while a reply is being written
  a.sync.start({ uid: UID });
  await quiesce(a);
  assert.equal(server.docs.has(UID + "__" + c.id), false, "in-flight chats are not uploaded");

  a.store.saveMessage(c.id, Object.assign({}, streaming, { content: "full answer", status: "complete" }));
  a.sync.setGenerating(null);
  await quiesce(a);
  assert.equal(JSON.parse(server.docs.get(UID + "__" + c.id).messages)[1].content, "full answer");
});

test("sync: a chat too large for one Firestore document is skipped, never truncated", async () => {
  const server = makeServer();
  const a = makeDevice(server);
  const c = a.store.createConversation().conversation;
  const big = "x".repeat(19000);
  for (let i = 0; i < 60; i += 1) a.store.saveMessage(c.id, Store.createMessage(i % 2 ? "assistant" : "user", big + i));
  const small = addChat(a, "Small one");
  a.sync.start({ uid: UID });
  await quiesce(a);
  assert.equal(server.docs.has(UID + "__" + c.id), false);
  assert.ok(server.docs.has(UID + "__" + small), "other chats still sync");
});

test("sync: documents are written under the user's id with the fields firestore.rules checks", async () => {
  const server = makeServer();
  const a = makeDevice(server);
  const id = addChat(a, "Rules check");
  a.sync.start({ uid: UID });
  await quiesce(a);
  const doc = server.docs.get(UID + "__" + id);
  assert.equal(doc.userId, UID);
  assert.equal(doc.kind, "chat");
  assert.equal(Sync.docId(UID, id), UID + "__" + id);
  const rules = fs.readFileSync(path.join(__dirname, "..", "firestore.rules"), "utf8");
  assert.match(rules, /match \/conversation_metadata\/\{conversationId\}/);
  assert.match(rules, /request\.resource\.data\.userId == request\.auth\.uid/);
});

test("sync: a corrupt remote payload becomes an empty chat instead of crashing", () => {
  const conv = Sync.fromRemote({ convId: "x", title: "T", messages: "{not json", mode: "general" });
  assert.deepEqual(conv.messages, []);
});

// ---- connectivity & status ------------------------------------------------------------------------

test("sync: starting offline waits, then connects and syncs when the device is back online", async () => {
  const server = makeServer();
  const a = makeDevice(server);
  const id = addChat(a, "Made offline");
  a.online = false;
  a.sync.start({ uid: UID });
  await quiesce(a);
  assert.equal(a.sync.getStatus(), "offline");
  assert.equal(server.docs.size, 0);

  a.online = true;
  a.sync.connectivityChanged();
  await quiesce(a);
  assert.ok(server.docs.has(UID + "__" + id));
  assert.equal(a.sync.getStatus(), "synced");
});

test("sync: status goes signed-out -> syncing -> synced, shows offline, and signed-out again after stop", async () => {
  const server = makeServer();
  const a = makeDevice(server);
  addChat(a, "Status chat");
  assert.equal(a.sync.getStatus(), "signed-out");
  a.sync.start({ uid: UID });
  assert.equal(a.sync.getStatus(), "syncing");
  await quiesce(a);
  assert.equal(a.sync.getStatus(), "synced");
  a.online = false;
  a.sync.connectivityChanged();
  assert.equal(a.sync.getStatus(), "offline");
  a.sync.stop();
  assert.equal(a.sync.getStatus(), "signed-out");
  assert.ok(a.statuses.indexOf("syncing") !== -1 && a.statuses.indexOf("synced") !== -1);
});

test("sync: a failed upload shows an error status, keeps the chat dirty, and retries successfully", async () => {
  const server = makeServer();
  const a = makeDevice(server);
  const id = addChat(a, "Flaky network");
  server.failWrites = true;
  a.sync.start({ uid: UID });
  await quiesce(a);
  assert.equal(a.sync.getStatus(), "error");
  assert.equal(server.docs.has(UID + "__" + id), false);

  server.failWrites = false;
  a.sync.connectivityChanged();
  await quiesce(a);
  assert.ok(server.docs.has(UID + "__" + id));
  assert.equal(a.sync.getStatus(), "synced");
});

test("sync: with no database available the status is 'unavailable' and chat keeps working", () => {
  const device = makeDevice(makeServer(), { remote: { available: () => false, listen() {}, write() {} } });
  device.sync.start({ uid: UID });
  assert.equal(device.sync.getStatus(), "unavailable");
  assert.equal(device.store.createConversation().ok, true);
});

test("sync: signing out stops syncing - later local changes are not uploaded", async () => {
  const server = makeServer();
  const a = makeDevice(server);
  a.sync.start({ uid: UID });
  await quiesce(a);
  a.sync.stop();
  const id = addChat(a, "After sign-out");
  await quiesce(a);
  assert.equal(server.docs.has(UID + "__" + id), false);
});

// ---- store helpers used by sync -----------------------------------------------------------------------

test("store: upsertConversation replaces or inserts one chat without touching which chat is active", () => {
  const map = new Map();
  const storage = { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)); }, removeItem: (k) => { map.delete(k); }, key: (i) => Array.from(map.keys())[i] || null, get length() { return map.size; } };
  const store = Store.createChatStore({ storage });
  const keep = store.createConversation().conversation;
  store.saveMessage(keep.id, Store.createMessage("user", "x"));
  const created = store.upsertConversation({ id: "remote-1", title: "From elsewhere", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", messages: [{ role: "user", content: "hi" }] });
  assert.equal(created.created, true);
  assert.equal(store.getActiveConversationId(), keep.id);
  assert.equal(store.getConversation("remote-1").updatedAt, "2026-01-02T00:00:00.000Z");
  const replaced = store.upsertConversation({ id: "remote-1", title: "Changed", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-03T00:00:00.000Z", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }] });
  assert.equal(replaced.created, false);
  assert.equal(store.getConversation("remote-1").messages.length, 2);
  assert.equal(store.upsertConversation(null).ok, false);
});

test("store: guest chats are listed from the guest history and can be merged into an account history without duplicates", () => {
  const map = new Map();
  const storage = { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)); }, removeItem: (k) => { map.delete(k); }, key: (i) => Array.from(map.keys())[i] || null, get length() { return map.size; } };
  const store = Store.createChatStore({ storage });
  const g1 = store.createConversation().conversation;
  store.saveMessage(g1.id, Store.createMessage("user", "guest question one"));
  store.createConversation(); // an empty one: not offered for upload
  const guestList = store.listGuestConversations();
  assert.equal(guestList.length, 1);

  store.setUserId("acct-1");
  assert.equal(store.listConversations().length, 0, "the account history starts empty");
  assert.equal(store.listGuestConversations().length, 1, "guest chats stay readable while signed in");
  const merged = store.mergeConversations(guestList);
  assert.equal(merged.added, 1);
  assert.equal(store.listConversations()[0].title, guestList[0].title);
  assert.equal(store.mergeConversations(guestList).added, 0, "merging twice adds nothing");
  store.setUserId(null);
  assert.equal(store.listConversations().filter((c) => c.messages.length).length, 1, "the guest history itself is untouched");
});

test("sync: the first-sign-in upload offer is remembered per account, so it is only asked once", () => {
  const device = makeDevice(makeServer());
  assert.equal(device.sync.shouldOfferUpload("acct-a"), true);
  device.sync.recordUploadDecision("acct-a", false);
  assert.equal(device.sync.shouldOfferUpload("acct-a"), false);
  assert.equal(device.sync.shouldOfferUpload("acct-b"), true, "another account is asked on its own first sign-in");
  device.sync.recordUploadDecision("acct-b", true);
  assert.equal(device.sync.shouldOfferUpload("acct-b"), false);
});

test("sync: every status has a plain-language label for the account menu", () => {
  assert.equal(Sync.statusText("synced"), "Synced");
  assert.match(Sync.statusText("syncing"), /^Syncing/);
  assert.match(Sync.statusText("offline"), /^Offline/);
  assert.match(Sync.statusText("error"), /will retry/);
  assert.equal(Sync.statusText("signed-out"), "");
  assert.equal(Sync.statusText("nonsense"), "");
});

test("account UI: guest card with a Sign in button, signed-in menu with sync status / Account / Sign out, all IDs app.js needs", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "www", "index.html"), "utf8");
  ["login-btn", "logout-btn", "user-profile", "user-avatar", "user-avatar-fallback", "user-name", "user-email", "account-menu-btn", "account-menu-list", "account-settings-btn", "sync-status", "sync-status-text"].forEach((id) => {
    assert.match(html, new RegExp('id="' + id + '"'), "missing #" + id);
  });
  assert.match(html, /<span class="sidebar-profile-name">Guest<\/span>/);
  assert.match(html, /id="account-menu-list"[^>]*role="menu"/);
  assert.match(html, /id="logout-btn"[^>]*role="menuitem"[^>]*>Sign out</);
  assert.ok(html.indexOf("chat-sync.js") > html.indexOf("history-ui.js") && html.indexOf("chat-sync.js") < html.indexOf('src="app.js"'));
});

test("account UI: app.js starts/stops sync with the signed-in user, offers the guest upload, and tells sync when a reply is generating", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "www", "app.js"), "utf8");
  assert.match(app, /historyUI\.setUser\(user\);\s*handleSyncUser\(user\);/);
  assert.match(app, /chatSync\.stop\(\);/);
  assert.match(app, /chatSync\.start\(user\);/);
  assert.match(app, /chatSync\.setGenerating\(conversationId\)/);
  assert.match(app, /chatSync\.setGenerating\(null\)/);
  assert.match(app, /confirmLabel: "Yes, upload",\s*cancelLabel: "No"/);
  assert.doesNotMatch(app, /localStorage\s*[.[]\s*(setItem|getItem)/, "app.js still never touches localStorage directly");
});

test("account UI: the account menu opens above its button (fixed) so the clipped sidebar cannot cut it off", () => {
  const menu = fs.readFileSync(path.join(__dirname, "..", "www", "chat-menu.js"), "utf8");
  assert.match(menu, /setupMenu\(\{ root: "user-profile", button: "account-menu-btn", list: "account-menu-list", fixedAbove: true \}\)/);
  assert.match(menu, /list\.style\.bottom = /);
});

test("sync: the size limit counts bytes, so a large Arabic chat (2 bytes per character) is skipped before Firestore would reject it", async () => {
  const server = makeServer();
  const a = makeDevice(server);
  const c = a.store.createConversation().conversation;
  const arabic = "\u0645\u0631\u062D\u0628\u0627 ".repeat(2900); // ~17k characters, ~31 KB in UTF-8
  for (let i = 0; i < 40; i += 1) a.store.saveMessage(c.id, Store.createMessage(i % 2 ? "assistant" : "user", arabic + i));
  const json = JSON.stringify(a.store.getConversation(c.id).messages);
  assert.ok(json.length < Sync.MAX_DOC_BYTES, "fewer characters than the limit...");
  assert.ok(new TextEncoder().encode(json).length > Sync.MAX_DOC_BYTES, "...but more bytes than the limit");
  a.sync.start({ uid: UID });
  await quiesce(a);
  assert.equal(server.docs.has(UID + "__" + c.id), false);
  assert.notEqual(a.sync.getStatus(), "error", "skipping an oversized chat is not an error");
});
