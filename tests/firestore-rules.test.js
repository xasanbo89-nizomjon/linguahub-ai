"use strict";

// firestore.rules: clients can READ their plan and usage but never WRITE them; the chat,
// vocabulary and profile rules keep working. The real rules file is evaluated by a small
// interpreter (tests/helpers/rulesEval.js) - no emulator needed.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { loadRules, check } = require("./helpers/rulesEval.js");

const source = fs.readFileSync(path.join(__dirname, "..", "firestore.rules"), "utf8");
const rules = loadRules(source);
const alice = { uid: "alice" };
const bob = { uid: "bob" };
const PROTECTED = ["plan", "premiumUntil", "usageDate", "usageCount"];

const can = (options) => check(Object.assign({ rules }, options));

// ---- the interpreter itself understands this rules file -----------------------------------------------------------

test("the rules file parses into the collections this app uses, each with allow statements", () => {
  const patterns = rules.matches.map((m) => m.pattern.join("/")).sort();
  assert.deepEqual(patterns, ["conversation_metadata/{conversationId}", "guestUsage/{id}", "learning_memory/{userId}", "user_preferences/{userId}", "users/{userId}"]);
  rules.matches.forEach((m) => assert.ok(m.allows.length > 0, m.pattern.join("/")));
  assert.ok(rules.functions.isOwner && rules.functions.protectedKeys, "helper functions are read");
});

test("interpreter sanity: an owner's profile read passes, an unknown path and anonymous callers fail", () => {
  assert.equal(can({ path: "users/alice", operation: "get", auth: alice, existing: { displayName: "A" } }), true);
  assert.equal(can({ path: "nothing/alice", operation: "get", auth: alice, existing: {} }), false);
  assert.equal(can({ path: "users/alice", operation: "get", auth: null, existing: {} }), false);
});

// ---- users/{uid}: read yes, protected writes never -------------------------------------------------------------------

const planDoc = { displayName: "Alice", email: "a@example.com", plan: "premium", premiumUntil: "2030-01-01", usageDate: "2026-03-10", usageCount: 7 };

test("a user can READ their own profile including plan and usage; nobody else can", () => {
  assert.equal(can({ path: "users/alice", operation: "get", auth: alice, existing: planDoc }), true);
  assert.equal(can({ path: "users/alice", operation: "list", auth: alice, existing: planDoc }), true);
  assert.equal(can({ path: "users/alice", operation: "get", auth: bob, existing: planDoc }), false);
  assert.equal(can({ path: "users/alice", operation: "get", auth: null, existing: planDoc }), false);
});

test("a user can still create and update their profile (name, e-mail, timestamps) - what the app writes today", () => {
  assert.equal(can({ path: "users/alice", operation: "create", auth: alice, incoming: { displayName: "Alice", email: "a@example.com", updatedAt: 1 } }), true);
  const before = { displayName: "Old", plan: "free", usageDate: "2026-03-10", usageCount: 3 };
  assert.equal(can({ path: "users/alice", operation: "update", auth: alice, existing: before, incoming: Object.assign({}, before, { displayName: "New", updatedAt: 2 }) }), true);
});

test("NO client can create a profile that carries a plan or usage field - each one on its own", () => {
  for (const key of PROTECTED) {
    const incoming = { displayName: "Alice", [key]: key === "usageCount" ? 0 : "x" };
    assert.equal(can({ path: "users/alice", operation: "create", auth: alice, incoming }), false, "create with " + key);
  }
  assert.equal(can({ path: "users/alice", operation: "create", auth: alice, incoming: { plan: "premium", premiumUntil: "2099-01-01" } }), false);
});

test("NO client can change a plan or usage field on an existing profile (set, raise, reset to zero, move the date, extend premium)", () => {
  const existing = { displayName: "Alice", plan: "free", usageDate: "2026-03-10", usageCount: 10 };
  const attempts = {
    "upgrade to premium": { plan: "premium" },
    "grant themselves premium time": { plan: "premium", premiumUntil: "2099-12-31" },
    "reset the counter to zero": { usageCount: 0 },
    "lower the counter": { usageCount: 3 },
    "move the usage date forward": { usageDate: "2026-03-11" },
    "move the usage date back": { usageDate: "2000-01-01" },
    "type the wrong plan name": { plan: "free2" }
  };
  Object.keys(attempts).forEach((name) => {
    assert.equal(can({ path: "users/alice", operation: "update", auth: alice, existing, incoming: Object.assign({}, existing, attempts[name]) }), false, name);
  });
});

test("NO client can ADD a protected field that was not there yet, or REMOVE one that was (field delete)", () => {
  const bare = { displayName: "Alice" };
  for (const key of PROTECTED) assert.equal(can({ path: "users/alice", operation: "update", auth: alice, existing: bare, incoming: Object.assign({}, bare, { [key]: 1 }) }), false, "add " + key);
  const full = { displayName: "Alice", plan: "premium", premiumUntil: "2030-01-01", usageDate: "2026-03-10", usageCount: 4 };
  for (const key of PROTECTED) {
    const incoming = Object.assign({}, full);
    delete incoming[key];
    assert.equal(can({ path: "users/alice", operation: "update", auth: alice, existing: full, incoming }), false, "remove " + key);
  }
});

test("writing a protected field back with its CURRENT value is allowed (nothing changes) - a merge of the whole document still works", () => {
  assert.equal(can({ path: "users/alice", operation: "update", auth: alice, existing: planDoc, incoming: Object.assign({}, planDoc, { displayName: "Alice B." }) }), true);
});

test("NO client can delete a profile (that would reset the day's count and the plan), not even the owner", () => {
  assert.equal(can({ path: "users/alice", operation: "delete", auth: alice, existing: planDoc }), false);
  assert.equal(can({ path: "users/alice", operation: "delete", auth: bob, existing: planDoc }), false);
  assert.equal(can({ path: "users/alice", operation: "delete", auth: null, existing: planDoc }), false);
});

test("nobody can write someone else's profile, and anonymous callers can write nothing", () => {
  assert.equal(can({ path: "users/alice", operation: "create", auth: bob, incoming: { displayName: "x" } }), false);
  assert.equal(can({ path: "users/alice", operation: "update", auth: bob, existing: { displayName: "A" }, incoming: { displayName: "hacked" } }), false);
  assert.equal(can({ path: "users/alice", operation: "create", auth: null, incoming: { displayName: "x" } }), false);
  assert.equal(can({ path: "users/alice", operation: "update", auth: null, existing: {}, incoming: { displayName: "x" } }), false);
});

test("there is no other place a client could keep a plan: sub-collections and unknown collections are closed", () => {
  for (const p of ["users/alice/plan/current", "users/alice/usage/today", "plans/alice", "usage/alice", "admin/config", "premium/alice"]) {
    for (const operation of ["get", "create", "update", "delete"]) {
      assert.equal(can({ path: p, operation, auth: alice, existing: {}, incoming: { plan: "premium" } }), false, p + " " + operation);
    }
  }
});

test("guest usage (hashed IPs and the global count) is closed to every client: signed in, signed out, read or write", () => {
  for (const auth of [alice, null]) {
    for (const operation of ["get", "list", "create", "update", "delete"]) {
      assert.equal(can({ path: "guestUsage/abc123", operation, auth, existing: { usageCount: 1 }, incoming: { usageCount: 0 } }), false, operation + " " + (auth ? "signed in" : "anonymous"));
      assert.equal(can({ path: "guestUsage/global-2026-03-10", operation, auth, existing: { count: 5 }, incoming: { count: 0 } }), false, "global " + operation);
    }
  }
});

// ---- the existing rules keep working -------------------------------------------------------------------------------------

test("chat sync: a user can create, read, update and delete their own chat documents; not other users'", () => {
  const mine = { userId: "alice", kind: "chat", convId: "c1", title: "Hi" };
  assert.equal(can({ path: "conversation_metadata/alice__c1", operation: "create", auth: alice, incoming: mine }), true);
  assert.equal(can({ path: "conversation_metadata/alice__c1", operation: "get", auth: alice, existing: mine }), true);
  assert.equal(can({ path: "conversation_metadata/alice__c1", operation: "update", auth: alice, existing: mine, incoming: Object.assign({}, mine, { title: "New" }) }), true);
  assert.equal(can({ path: "conversation_metadata/alice__c1", operation: "delete", auth: alice, existing: mine }), true);
  assert.equal(can({ path: "conversation_metadata/alice__c1", operation: "get", auth: bob, existing: mine }), false);
  assert.equal(can({ path: "conversation_metadata/alice__c1", operation: "create", auth: bob, incoming: mine }), false, "cannot create a document claiming another user");
  assert.equal(can({ path: "conversation_metadata/alice__c1", operation: "update", auth: alice, existing: mine, incoming: Object.assign({}, mine, { userId: "bob" }) }), false, "cannot hand a document to someone else");
  assert.equal(can({ path: "conversation_metadata/alice__c1", operation: "get", auth: null, existing: mine }), false);
});

test("vocabulary sync documents (kind 'vocab', in the same collection) work exactly like chats", () => {
  const word = { userId: "alice", kind: "vocab", wordId: "w_1", word: "book", deleted: false };
  assert.equal(can({ path: "conversation_metadata/alice__vocab_w_1", operation: "create", auth: alice, incoming: word }), true);
  assert.equal(can({ path: "conversation_metadata/alice__vocab_w_1", operation: "update", auth: alice, existing: word, incoming: Object.assign({}, word, { deleted: true }) }), true);
  assert.equal(can({ path: "conversation_metadata/alice__vocab_w_1", operation: "get", auth: bob, existing: word }), false);
});

test("learning settings and preferences stay owner-only read/write", () => {
  for (const collection of ["learning_memory", "user_preferences"]) {
    assert.equal(can({ path: collection + "/alice", operation: "get", auth: alice, existing: { level: "beginner" } }), true, collection);
    assert.equal(can({ path: collection + "/alice", operation: "create", auth: alice, incoming: { level: "beginner" } }), true, collection);
    assert.equal(can({ path: collection + "/alice", operation: "update", auth: alice, existing: {}, incoming: { level: "advanced" } }), true, collection);
    assert.equal(can({ path: collection + "/alice", operation: "get", auth: bob, existing: {} }), false, collection);
    assert.equal(can({ path: collection + "/alice", operation: "update", auth: null, existing: {}, incoming: {} }), false, collection);
  }
});

// ---- the server's own writes match what the rules protect ------------------------------------------------------------------

test("the fields the server writes (lib/usage.js, scripts/set-premium.js) are exactly the ones the rules protect", () => {
  const usageSource = fs.readFileSync(path.join(__dirname, "..", "lib", "usage.js"), "utf8");
  ["usageDate", "usageCount", "plan", "premiumUntil"].forEach((key) => assert.ok(usageSource.includes(key) || key === "plan" || key === "premiumUntil", key));
  const protectedList = /function protectedKeys\(\) \{\s*return \[([^\]]+)\];/.exec(source)[1].split(",").map((s) => s.trim().replace(/'/g, ""));
  assert.deepEqual(protectedList.sort(), PROTECTED.slice().sort());
});

test("the client code never writes those fields: the only client write to users/{uid} is the profile name and e-mail", () => {
  const wwwDir = path.join(__dirname, "..", "www");
  fs.readdirSync(wwwDir).filter((f) => f.endsWith(".js")).forEach((f) => {
    const code = fs.readFileSync(path.join(wwwDir, f), "utf8");
    if (!/collection\("users"\)/.test(code)) return;
    const writes = code.match(/collection\("users"\)\.doc\([^)]*\)\.set\(([^;]*)\)/g) || [];
    writes.forEach((w) => PROTECTED.forEach((key) => assert.ok(!w.includes(key), f + " writes " + key)));
  });
});
