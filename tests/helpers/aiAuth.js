"use strict";

// Test plumbing for the AI routes, which now need a verified Firebase sign-in and
// a usage record (lib/aiGate.js): a fake Firestore with real transaction semantics,
// and a stand-in for lib/firebaseAdmin.js (the same require.cache technique the
// auth tests use - no real Firebase project is involved).

const path = require("node:path");

const ADMIN_PATH = require.resolve("../../lib/firebaseAdmin.js");
const AUTH_PATH = require.resolve("../../middleware/auth.js");
const SERVER_PATH = require.resolve("../../server.js");

// A microtask hop: every transaction that has started reads before any of them commits,
// which is exactly the interleaving that makes optimistic transactions collide.
const yieldTurn = () => new Promise((resolve) => queueMicrotask(resolve));

// A Firestore stand-in: documents keyed by "collection/id", optimistic transactions
// that retry on conflict (like the Admin SDK), reads that yield so concurrent
// transactions really interleave.
function createFakeFirestore(initial) {
  const records = new Map(); // path -> { data, version }
  Object.keys(initial || {}).forEach((p) => records.set(p, { data: Object.assign({}, initial[p]), version: 1 }));
  const log = { transactions: 0, retries: 0, writes: 0 };

  function snapshot(record) {
    return { exists: Boolean(record), data: () => (record ? Object.assign({}, record.data) : undefined) };
  }
  function reference(collection, id) {
    const p = collection + "/" + id;
    return {
      path: p,
      id,
      async get() { await yieldTurn(); return snapshot(records.get(p)); },
      async set(data, options) { apply(p, data, options); }
    };
  }
  function apply(p, data, options) {
    const current = records.get(p);
    const next = options && options.merge && current ? Object.assign({}, current.data, data) : Object.assign({}, data);
    records.set(p, { data: next, version: current ? current.version + 1 : 1 });
    log.writes += 1;
  }

  const db = {
    log,
    records,
    failNext: null, // set to an Error to make the next operation fail
    collection(name) { return { doc: (id) => reference(name, id) }; },
    async runTransaction(fn) {
      if (db.failNext) { const error = db.failNext; db.failNext = null; throw error; }
      log.transactions += 1;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const reads = new Map();
        const writes = [];
        const tx = {
          async get(ref) {
            await yieldTurn();
            const record = records.get(ref.path);
            reads.set(ref.path, record ? record.version : 0);
            return snapshot(record);
          },
          set(ref, data, options) { writes.push([ref.path, data, options]); }
        };
        const result = await fn(tx);
        // commit: nothing it read may have changed in the meantime
        let conflict = false;
        reads.forEach((version, p) => { const record = records.get(p); if ((record ? record.version : 0) !== version) conflict = true; });
        if (!conflict) { writes.forEach(([p, data, options]) => apply(p, data, options)); return result; }
        log.retries += 1;
      }
      throw new Error("transaction kept conflicting");
    },
    read(uid) { const r = records.get("users/" + uid); return r ? r.data : undefined; }
  };
  return db;
}

// users: { "<token>": { uid, email } } ; the token string is all the fake needs
function installFirebaseAdmin(options) {
  const o = options || {};
  const db = o.db || createFakeFirestore();
  const users = o.users || { "test-token": { uid: "test-user", email: "test@example.com" } };
  const fake = {
    isConfigured: () => o.configured !== false,
    async verifyIdToken(token) {
      if (o.configured === false) { const e = new Error("not configured"); e.code = "auth/admin-not-configured"; throw e; }
      if (!users[token]) { const e = new Error("bad token"); e.code = "auth/argument-error"; throw e; }
      return Object.assign({ email_verified: true }, users[token]);
    },
    getFirestore() { if (o.configured === false) { const e = new Error("not configured"); e.code = "auth/admin-not-configured"; throw e; } return db; },
    getAuth() { return o.auth; },
    timestampFromDate(date) { return { toMillis: () => date.getTime(), toDate: () => date }; }
  };
  require.cache[ADMIN_PATH] = { id: ADMIN_PATH, filename: ADMIN_PATH, loaded: true, exports: fake };
  delete require.cache[AUTH_PATH];
  delete require.cache[SERVER_PATH];
  return { db, fake, users };
}

function uninstallFirebaseAdmin() {
  delete require.cache[ADMIN_PATH];
  delete require.cache[AUTH_PATH];
  delete require.cache[SERVER_PATH];
}

const PREMIUM_FOREVER = { plan: "premium", premiumUntil: { seconds: 4102444800, nanoseconds: 0 } }; // 2100

// For the older server tests that exercise the AI routes themselves (not the limit):
// a signed-in premium user, and every fetch to an AI route carries the token.
function installLegacy() {
  const db = createFakeFirestore({ "users/test-user": PREMIUM_FOREVER });
  installFirebaseAdmin({ db });
  if (!global.fetch.__aiAuthWrapped) {
    const original = global.fetch;
    const wrapped = function (url, init) {
      const target = String(url);
      if (/\/(api\/chat(\/stream)?|chat|api\/transcribe)(\?|$)/.test(target.replace(/^https?:\/\/[^/]+/, ""))) {
        const options = Object.assign({}, init);
        const headers = Object.assign({}, options.headers);
        const has = Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
        if (!has) headers.Authorization = "Bearer test-token";
        options.headers = headers;
        return original(url, options);
      }
      return original(url, init);
    };
    wrapped.__aiAuthWrapped = true;
    global.fetch = wrapped;
  }
  return db;
}

module.exports = { createFakeFirestore, installFirebaseAdmin, uninstallFirebaseAdmin, installLegacy, PREMIUM_FOREVER, ADMIN_PATH, SERVER_PATH };
