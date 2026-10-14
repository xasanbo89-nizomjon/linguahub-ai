"use strict";

// Phase 4, step 4: saved words mirrored to Firestore (conversation_metadata,
// kind "vocab"), last write wins, tombstones for deletes, no rules change.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const Vocab = require("../www/vocab-store.js");
const Sync = require("../www/vocab-sync.js");

const tick = (ms) => new Promise((r) => setTimeout(r, ms === undefined ? 20 : ms));

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)); }, removeItem: (k) => { map.delete(k); } };
}

// keyed by wordId (the doc id is built by the Firestore adapter, tested separately)
function fakeRemote() {
  const docs = new Map();
  let listener = null;
  let failWrites = false;
  const remote = {
    docs,
    writes: [],
    available: () => true,
    listen(uid, onDocs) {
      listener = onDocs;
      Promise.resolve().then(() => onDocs(Array.from(docs.values()), true));
      return () => { listener = null; };
    },
    async write(uid, wordId, data) {
      if (failWrites) throw new Error("offline");
      remote.writes.push({ uid, wordId, data });
      docs.set(wordId, JSON.parse(JSON.stringify(data)));
    },
    arrive(doc) { if (doc) docs.set(doc.wordId, doc); if (listener) listener([doc], false); },
    isListening: () => listener !== null,
    failWrites(v) { failWrites = v; }
  };
  return remote;
}

function setup({ online = true, remote = fakeRemote(), storage = memoryStorage(), uid = "u1", now } = {}) {
  const store = Vocab.create({ storage, now });
  store.setUserId(uid);
  const state = { online };
  const sync = Sync.create({ store, remote, storage, isOnline: () => state.online, flushDebounceMs: 1 });
  const events = [];
  store.subscribe((e) => events.push(e.type));
  return { store, remote, storage, sync, state, events };
}

const WORD = { word: "book", translation: "kitob", lang: "en", example: "I read a book." };

async function settled(sync) { await tick(); await sync.idle(); await tick(); await sync.idle(); }

test("docs: ids and fields follow the chat-sync convention, in the same collection, with their own kind", () => {
  assert.equal(Sync.COLLECTION, "conversation_metadata");
  assert.equal(Sync.docId("u1", "w_abc"), "u1__vocab_w_abc");
  const { store } = setup();
  const added = store.add(WORD).word;
  const doc = Sync.toRemote("u1", added);
  assert.equal(doc.userId, "u1");
  assert.equal(doc.kind, "vocab");
  assert.equal(doc.wordId, added.id);
  assert.equal(doc.deleted, false);
  assert.equal(doc.srs.reps, 0);
  assert.equal(JSON.stringify(Sync.fromRemote(doc).id), JSON.stringify(added.id));
});

test("firestore adapter: queries only this user's vocab docs and writes to the id <uid>__vocab_<wordId>", async () => {
  const calls = [];
  const db = {
    collection(name) {
      calls.push(["collection", name]);
      const q = {
        where(field, op, value) { calls.push(["where", field, op, value]); return q; },
        onSnapshot(cb) { calls.push(["onSnapshot"]); cb({ forEach: (fn) => [{ data: () => ({ wordId: "w_1" }) }].forEach(fn), docChanges: () => [] }); return () => {}; },
        doc(id) { calls.push(["doc", id]); return { set: async (data) => { calls.push(["set", data.kind]); } }; }
      };
      return q;
    }
  };
  const remote = Sync.createFirestoreRemote(() => db);
  assert.equal(remote.available(), true);
  const received = [];
  remote.listen("u1", (docs, initial) => received.push([docs.length, initial]), () => {});
  assert.deepEqual(received, [[1, true]]);
  assert.ok(calls.some((c) => c[0] === "where" && c[1] === "userId" && c[3] === "u1"));
  assert.ok(calls.some((c) => c[0] === "where" && c[1] === "kind" && c[3] === "vocab"));
  await remote.write("u1", "w_1", { kind: "vocab" });
  assert.ok(calls.some((c) => c[0] === "doc" && c[1] === "u1__vocab_w_1"));
  assert.equal(Sync.createFirestoreRemote(() => null).available(), false);
  await assert.rejects(Sync.createFirestoreRemote(() => null).write("u", "w", {}));
});

test("rules: no firestore.rules change - the existing owner-only rule on conversation_metadata covers vocab docs", () => {
  const rules = fs.readFileSync(path.join(__dirname, "..", "firestore.rules"), "utf8");
  assert.match(rules, /match \/conversation_metadata\/\{conversationId\}/);
  assert.doesNotMatch(rules, /vocab/i);
  assert.match(rules, /resource\.data\.userId == request\.auth\.uid/);
});

test("first sign-in: words already on this device are uploaded", async () => {
  const t = setup();
  const a = t.store.add(WORD).word;
  t.store.add({ word: "cat", translation: "mushuk", lang: "en" });
  t.sync.start({ uid: "u1" });
  await settled(t.sync);
  assert.equal(t.remote.docs.size, 2);
  assert.equal(t.remote.docs.get(a.id).kind, "vocab");
  assert.equal(t.remote.docs.get(a.id).userId, "u1");
  assert.equal(t.sync.getStatus(), "synced");
});

test("new device: the account's words arrive, the list redraws, and nothing is uploaded back", async () => {
  const remote = fakeRemote();
  const first = setup({ remote });
  const w = first.store.add(WORD).word;
  first.store.review(w.id, "good");
  first.sync.start({ uid: "u1" });
  await settled(first.sync);
  first.sync.stop();

  const second = setup({ remote });
  remote.writes.length = 0;
  second.sync.start({ uid: "u1" });
  await settled(second.sync);
  const got = second.store.get(w.id);
  assert.equal(got.word, "book");
  assert.equal(got.srs.reps, 1, "the review schedule travels with the word");
  assert.ok(second.events.includes("remote"), "the screens are told to redraw");
  assert.equal(remote.writes.length, 0);
});

test("changes made here are pushed after a short pause (adding, reviewing)", async () => {
  const t = setup();
  t.sync.start({ uid: "u1" });
  await settled(t.sync);
  const w = t.store.add(WORD).word;
  await settled(t.sync);
  assert.equal(t.remote.docs.get(w.id).word, "book");
  t.store.review(w.id, "easy");
  await settled(t.sync);
  assert.equal(t.remote.docs.get(w.id).srs.reps, 1);
  assert.equal(t.remote.docs.get(w.id).updatedAt, t.store.get(w.id).updatedAt);
});

test("last write wins: a newer remote copy replaces the local one; a newer local copy is pushed", async () => {
  const remote = fakeRemote();
  const t = setup({ remote });
  const w = t.store.add(WORD).word;
  t.sync.start({ uid: "u1" });
  await settled(t.sync);

  const newerRemote = Object.assign({}, remote.docs.get(w.id), { updatedAt: w.updatedAt + 5000, translation: "kitob (remote)", srs: Object.assign({}, w.srs, { reps: 3, interval: 6 }) });
  remote.arrive(newerRemote);
  await settled(t.sync);
  assert.equal(t.store.get(w.id).translation, "kitob (remote)");
  assert.equal(t.store.get(w.id).srs.reps, 3);

  const staleRemote = Object.assign({}, remote.docs.get(w.id), { updatedAt: 1, translation: "stale" });
  remote.writes.length = 0;
  remote.arrive(staleRemote);
  await settled(t.sync);
  assert.equal(t.store.get(w.id).translation, "kitob (remote)", "older copies never win");
  assert.equal(remote.writes.length, 1, "the newer local copy is pushed back");
});

test("deleting: a tombstone is written; deleting twice or while offline is safe", async () => {
  const t = setup();
  const w = t.store.add(WORD).word;
  t.sync.start({ uid: "u1" });
  await settled(t.sync);
  t.store.remove(w.id);
  await settled(t.sync);
  const doc = t.remote.docs.get(w.id);
  assert.equal(doc.deleted, true);
  assert.equal(doc.kind, "vocab");
  assert.equal(doc.userId, "u1");
  assert.equal(doc.word, "", "no content is kept in a tombstone");
  assert.equal(t.sync._state().pendingDeletes.length, 0);
});

test("a delete made offline is remembered and published when the connection returns", async () => {
  const t = setup();
  const w = t.store.add(WORD).word;
  t.sync.start({ uid: "u1" });
  await settled(t.sync);
  t.state.online = false;
  t.remote.failWrites(true);
  t.store.remove(w.id);
  await settled(t.sync);
  assert.equal(t.remote.docs.get(w.id).deleted, false, "not published yet");
  assert.deepEqual(JSON.parse(t.storage.getItem("linguahub-ai:vocab-sync:u1")).pendingDeletes, [w.id], "remembered across restarts");
  t.state.online = true;
  t.remote.failWrites(false);
  t.sync.connectivityChanged();
  await settled(t.sync);
  assert.equal(t.remote.docs.get(w.id).deleted, true);
});

test("a tombstone from another device removes an unchanged local word", async () => {
  const remote = fakeRemote();
  const t = setup({ remote });
  const w = t.store.add(WORD).word;
  t.sync.start({ uid: "u1" });
  await settled(t.sync);
  remote.arrive({ userId: "u1", kind: "vocab", wordId: w.id, deleted: true, updatedAt: Date.now() + 1000 });
  await settled(t.sync);
  assert.equal(t.store.get(w.id), null);
  assert.equal(remote.docs.get(w.id).deleted, true, "the tombstone stays");
  assert.ok(t.events.includes("remote"));
});

test("a tombstone never destroys a word that was changed here after the last sync - it is brought back instead", async () => {
  const remote = fakeRemote();
  const t = setup({ remote });
  const w = t.store.add(WORD).word;
  t.sync.start({ uid: "u1" });
  await settled(t.sync);
  t.state.online = false;
  t.store.review(w.id, "good"); // changed here, not yet pushed (offline)
  await tick(5);
  t.state.online = true;
  remote.arrive({ userId: "u1", kind: "vocab", wordId: w.id, deleted: true, updatedAt: Date.now() + 1000 });
  await settled(t.sync);
  assert.ok(t.store.get(w.id), "the local word survives");
  assert.equal(remote.docs.get(w.id).deleted, false, "and is uploaded again");
});

test("Undo after a delete cancels the pending tombstone and keeps the word and its schedule", async () => {
  const remote = fakeRemote();
  const t = setup({ remote });
  const w = t.store.add(WORD).word;
  t.store.review(w.id, "good");
  t.sync.start({ uid: "u1" });
  await settled(t.sync);
  t.state.online = false;
  const removed = t.store.remove(w.id).word;
  assert.equal(t.sync._state().pendingDeletes.length, 1);
  t.store.restore(removed);
  assert.equal(t.sync._state().pendingDeletes.length, 0, "the delete was undone");
  t.state.online = true;
  t.sync.connectivityChanged();
  await settled(t.sync);
  const doc = remote.docs.get(w.id);
  assert.equal(doc.deleted, false);
  assert.equal(doc.srs.reps, 1);
  assert.equal(t.store.get(w.id).srs.reps, 1);
});

test("a word that merely vanished locally is not treated as a deletion and is not resurrected or deleted remotely", async () => {
  const remote = fakeRemote();
  const t = setup({ remote });
  const w = t.store.add(WORD).word;
  t.sync.start({ uid: "u1" });
  await settled(t.sync);
  t.store.removeSilently(w.id);
  remote.writes.length = 0;
  remote.arrive(Object.assign({}, remote.docs.get(w.id)));
  await settled(t.sync);
  assert.equal(t.store.get(w.id), null, "not resurrected");
  assert.equal(remote.writes.length, 0, "no tombstone written");
});

test("signing out or switching accounts stops sync and never pushes another list under the old uid", async () => {
  const remote = fakeRemote();
  const t = setup({ remote });
  t.sync.start({ uid: "u1" });
  await settled(t.sync);
  remote.writes.length = 0;
  t.store.setUserId(null); // sign-out: guest list
  t.store.add({ word: "secret", translation: "x", lang: "en" });
  await settled(t.sync);
  assert.equal(t.sync.getStatus(), "signed-out");
  assert.equal(remote.isListening(), false);
  assert.equal(remote.writes.length, 0);
  assert.equal(remote.docs.size, 0);
});

test("offline at start: nothing is contacted until the connection returns", async () => {
  const t = setup({ online: false });
  t.store.add(WORD);
  t.sync.start({ uid: "u1" });
  await settled(t.sync);
  assert.equal(t.sync.getStatus(), "offline");
  assert.equal(t.remote.isListening(), false);
  t.state.online = true;
  t.sync.connectivityChanged();
  await settled(t.sync);
  assert.equal(t.remote.docs.size, 1);
  assert.equal(t.sync.getStatus(), "synced");
});

test("a failing upload shows an error status and retries; nothing is lost", async () => {
  let timers = [];
  const remote = fakeRemote();
  const storage = memoryStorage();
  const store = Vocab.create({ storage });
  store.setUserId("u1");
  const sync = Sync.create({ store, remote, storage, isOnline: () => true, flushDebounceMs: 1, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {} });
  const w = store.add(WORD).word;
  remote.failWrites(true);
  sync.start({ uid: "u1" });
  await tick(); await sync.idle(); await tick();
  assert.equal(sync.getStatus(), "error");
  assert.ok(timers.some((t) => t.ms === 30000), "a retry is scheduled");
  assert.ok(store.get(w.id), "the local word is untouched");
  remote.failWrites(false);
  timers.filter((t) => t.ms === 30000)[0].fn();
  await tick(); await sync.idle(); await tick();
  assert.equal(remote.docs.size, 1);
  assert.equal(sync.getStatus(), "synced");
});

test("remote data is untrusted: oversize text is cut, bad ids and junk documents are ignored", async () => {
  const remote = fakeRemote();
  const t = setup({ remote });
  t.sync.start({ uid: "u1" });
  await settled(t.sync);
  remote.arrive({ userId: "u1", kind: "vocab", wordId: "../../etc", word: "evil", translation: "x", lang: "en", updatedAt: Date.now() + 10 });
  remote.arrive({ userId: "u1", kind: "vocab", wordId: "w_big", word: "w".repeat(500), translation: "t".repeat(900), lang: "en", example: "e".repeat(2000), updatedAt: Date.now() + 10, srs: { ease: 99, interval: -4, reps: "x", due: "nonsense" } });
  remote.arrive({ userId: "u1", kind: "vocab", wordId: "w_nolang", word: "a", translation: "b", updatedAt: Date.now() + 10 });
  remote.arrive(null);
  await settled(t.sync);
  assert.equal(t.store.all().some((w) => w.word === "evil"), false);
  const big = t.store.get("w_big");
  assert.ok(big.word.length <= Vocab.LIMITS.word);
  assert.ok(big.translation.length <= Vocab.LIMITS.translation);
  assert.ok(big.example.length <= Vocab.LIMITS.example);
  assert.equal(big.srs.ease, 2.5);
  assert.equal(big.srs.interval, 0);
  assert.equal(t.store.get("w_nolang"), null, "a word without a language is rejected");
});

test("status listeners hear about changes and can unsubscribe", async () => {
  const t = setup();
  const seen = [];
  const off = t.sync.onStatusChange((s) => seen.push(s));
  t.sync.start({ uid: "u1" });
  await settled(t.sync);
  assert.ok(seen.includes("syncing") && seen.includes("synced"));
  off();
  const before = seen.length;
  t.sync.stop();
  assert.equal(seen.length, before);
});

test("wiring: scripts load in order, sync is started and stopped with the account, and app.js never touches storage directly", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "www", "index.html"), "utf8");
  const at = (n) => html.indexOf('<script src="' + n + '"></script>');
  assert.ok(at("vocab-store.js") > -1 && at("vocab-store.js") < at("vocab-sync.js"));
  assert.equal(at("ws-vocab.js"), -1, "the Vocabulary screen is loaded on first use, not at startup");
  assert.ok(at("vocab-store.js") < at("home-ui.js"));
  const app = fs.readFileSync(path.join(__dirname, "..", "www", "app.js"), "utf8");
  assert.match(app, /LinguaHubVocabSync\.create\(\{\s*store: window\.linguahubVocab,/);
  assert.match(app, /async function handleSyncUser\(user\) \{\s*if \(vocabSync\) \{\s*if \(user\) vocabSync\.start\(user\);\s*else vocabSync\.stop\(\);/);
  assert.match(app, /window\.linguahubVocab\.setUserId\(user && user\.uid \? user\.uid : null\);\s*\n?\s*handleSyncUser\(user\);/);
});
