"use strict";

// Phase 5, step 0: the first-sign-in "upload what is on this device?" dialog
// covers guest vocabulary words as well as guest chats.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const Vocab = require("../www/vocab-store.js");
const ChatSync = require("../www/chat-sync.js");

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)); }, removeItem: (k) => { map.delete(k); }, map };
}

test("guest words stay readable after signing in, and are never changed by reading them", () => {
  const storage = memoryStorage();
  const store = Vocab.create({ storage });
  store.add({ word: "book", translation: "kitob", lang: "en" });
  store.add({ word: "cat", translation: "mushuk", lang: "en" });
  const before = storage.getItem("linguahub-ai:vocab:guest");
  store.setUserId("u1");
  assert.equal(store.list({}).length, 0, "the account starts with its own (empty) list");
  assert.equal(store.listGuestWords().length, 2);
  assert.equal(storage.getItem("linguahub-ai:vocab:guest"), before);
});

test("mergeWords copies guest words into the account with their schedule, once", () => {
  const storage = memoryStorage();
  const store = Vocab.create({ storage });
  const w = store.add({ word: "book", translation: "kitob", lang: "en" }).word;
  store.review(w.id, "good");
  store.setUserId("u1");
  const events = [];
  store.subscribe((e) => events.push(e.type));
  const result = store.mergeWords(store.listGuestWords());
  assert.deepEqual({ ok: result.ok, added: result.added, skipped: result.skipped }, { ok: true, added: 1, skipped: 0 });
  const merged = store.get(w.id);
  assert.equal(merged.word, "book");
  assert.equal(merged.srs.reps, 1, "review progress comes along");
  assert.ok(events.includes("changed"), "screens and sync are told");
  const again = store.mergeWords(store.listGuestWords());
  assert.equal(again.added, 0);
  assert.equal(again.skipped, 1);
  assert.equal(store.list({}).length, 1);
});

test("mergeWords skips words the account already has (same language and spelling), keeps the account's version, and drops junk", () => {
  const storage = memoryStorage();
  const store = Vocab.create({ storage });
  store.add({ word: "Book", translation: "kitob (guest)", lang: "en" });
  store.add({ word: "cat", translation: "mushuk", lang: "en" });
  store.setUserId("u1");
  const mine = store.add({ word: "book", translation: "kitob (account)", lang: "en" }).word;
  const result = store.mergeWords(store.listGuestWords().concat([null, 5, { word: "", translation: "x", lang: "en" }, { word: "x", translation: "y" }]));
  assert.equal(result.added, 1, "only 'cat' is new");
  assert.equal(store.get(mine.id).translation, "kitob (account)");
  assert.equal(store.list({}).length, 2);
});

test("mergeWords respects the word limit and never removes anything", () => {
  const storage = memoryStorage();
  const store = Vocab.create({ storage });
  store.setUserId("u1");
  const many = [];
  for (let i = 0; i < Vocab.LIMITS.maxWords + 5; i += 1) many.push({ word: "w" + i, translation: "t", lang: "en" });
  const result = store.mergeWords(many);
  assert.equal(result.added, Vocab.LIMITS.maxWords);
  assert.equal(result.skipped, 5);
  assert.equal(store.mergeWords([{ word: "extra", translation: "t", lang: "en" }]).added, 0);
  assert.equal(store.list({}).length, Vocab.LIMITS.maxWords);
});

test("a failed write reports an error and leaves the list as it was", () => {
  const storage = memoryStorage();
  const store = Vocab.create({ storage });
  store.add({ word: "keep", translation: "saqla", lang: "en" });
  store.setUserId("u1");
  const failing = { getItem: storage.getItem, setItem() { throw new Error("quota"); } };
  const broken = Vocab.create({ storage: failing });
  broken.setUserId("u1");
  const result = broken.mergeWords([{ word: "a", translation: "b", lang: "en" }]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "storage-error");
  assert.equal(store.listGuestWords().length, 1);
});

test("dialog wording: chats only, words only, or both - singular and plural", () => {
  const offer = ChatSync.uploadOffer;
  assert.equal(offer(2, 0).title, "Upload your chats?");
  assert.match(offer(2, 0).message, /You have 2 chats on this device.*Upload them.*they appear/);
  assert.equal(offer(1, 0).message.includes("1 chat on"), true);
  assert.match(offer(1, 0).message, /Upload it .*it appears/);
  assert.equal(offer(0, 3).title, "Upload your words?");
  assert.match(offer(0, 3).message, /You have 3 saved words on this device/);
  const both = offer(2, 5);
  assert.equal(both.title, "Upload your chats and words?");
  assert.match(both.message, /You have 2 chats and 5 saved words on this device/);
  assert.match(both.message, /Upload them/);
  assert.equal(offer(1, 1).message.includes("Upload them"), true, "two things -> them");
  assert.equal(both.confirmLabel, "Yes, upload");
  assert.equal(both.cancelLabel, "No");
});

test("toast wording reports exactly what was uploaded", () => {
  assert.equal(ChatSync.uploadedToast(2, 0), "Uploaded 2 chats to your account.");
  assert.equal(ChatSync.uploadedToast(0, 1), "Uploaded 1 word to your account.");
  assert.equal(ChatSync.uploadedToast(1, 4), "Uploaded 1 chat and 4 words to your account.");
  assert.equal(ChatSync.uploadedToast(0, 0), "");
});

test("app.js asks once for both, records the decision, and merges chats and words only on Yes", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "www", "app.js"), "utf8");
  const start = app.indexOf("async function offerGuestUpload(user)");
  const body = app.slice(start, app.indexOf("async function handleSyncUser", start));
  assert.match(body, /listGuestWords\(\)/);
  assert.match(body, /if \(!guestChats\.length && !guestWords\.length\) return;/);
  assert.match(body, /LinguaHubChatSync\.uploadOffer\(guestChats\.length, guestWords\.length\)/);
  assert.ok(body.indexOf("recordUploadDecision") < body.indexOf("if (!upload) return;"));
  assert.ok(body.indexOf("if (!upload) return;") < body.indexOf("mergeConversations"));
  assert.ok(body.indexOf("if (!upload) return;") < body.indexOf("mergeWords"));
  assert.doesNotMatch(app, /localStorage\./, "app.js never touches storage directly");
});
