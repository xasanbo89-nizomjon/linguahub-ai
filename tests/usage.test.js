"use strict";

// The daily free limit and the premium plan: day boundaries, atomic counting, expiry.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const usage = require("../lib/usage.js");
const { createFakeFirestore } = require("./helpers/aiAuth.js");

const at = (iso) => new Date(iso);
const LIMIT = 10;

// ---- the day ends at midnight in Tashkent -------------------------------------------------------------------------

test("dayKey: the day is the Tashkent calendar day (UTC+5), not the UTC day", () => {
  assert.equal(usage.dayKey(at("2026-03-10T00:00:00Z")), "2026-03-10");
  assert.equal(usage.dayKey(at("2026-03-10T18:59:59Z")), "2026-03-10", "23:59:59 in Tashkent is still the 10th");
  assert.equal(usage.dayKey(at("2026-03-10T19:00:00Z")), "2026-03-11", "00:00:00 in Tashkent is the 11th - while UTC is still the 10th");
  assert.equal(usage.dayKey(at("2026-03-10T23:59:59Z")), "2026-03-11");
  assert.equal(usage.dayKey(at("2026-12-31T19:00:00Z")), "2027-01-01", "across New Year");
  assert.equal(usage.dayKey(at("2028-02-28T19:00:00Z")), "2028-02-29", "leap day");
});

test("nextResetAt: the next midnight in Tashkent (19:00 UTC), always in the future and at most a day away", () => {
  assert.equal(usage.nextResetAt(at("2026-03-10T10:00:00Z")), "2026-03-10T19:00:00.000Z");
  assert.equal(usage.nextResetAt(at("2026-03-10T18:59:59Z")), "2026-03-10T19:00:00.000Z");
  assert.equal(usage.nextResetAt(at("2026-03-10T19:00:00Z")), "2026-03-11T19:00:00.000Z", "right at midnight the next reset is a day away");
  assert.equal(usage.nextResetAt(at("2026-12-31T20:00:00Z")), "2027-01-01T19:00:00.000Z");
  for (const iso of ["2026-01-01T00:00:00Z", "2026-06-15T12:34:56Z", "2026-10-15T18:59:59Z", "2026-10-15T19:00:00Z"]) {
    const delta = Date.parse(usage.nextResetAt(at(iso))) - Date.parse(iso);
    assert.ok(delta > 0 && delta <= 24 * 3600 * 1000, iso);
  }
});

test("consume: the allowance resets exactly at Tashkent midnight - used up before it, available again after it", async () => {
  const db = createFakeFirestore();
  const before = at("2026-03-10T18:59:00Z");
  for (let i = 0; i < LIMIT; i += 1) assert.equal((await usage.consume({ db, uid: "u1", limit: LIMIT, now: before })).allowed, true);
  const denied = await usage.consume({ db, uid: "u1", limit: LIMIT, now: at("2026-03-10T18:59:59Z") });
  assert.equal(denied.allowed, false);
  assert.equal(denied.remaining, 0);
  assert.equal(denied.resetAt, "2026-03-10T19:00:00.000Z");
  const after = await usage.consume({ db, uid: "u1", limit: LIMIT, now: at("2026-03-10T19:00:00Z") });
  assert.equal(after.allowed, true, "a new Tashkent day");
  assert.equal(after.remaining, LIMIT - 1);
  assert.equal(db.read("u1").usageDate, "2026-03-11");
  assert.equal(db.read("u1").usageCount, 1);
});

test("consume: UTC midnight is NOT a reset (4 hours of the Tashkent day remain after it)", async () => {
  const db = createFakeFirestore();
  for (let i = 0; i < LIMIT; i += 1) await usage.consume({ db, uid: "u1", limit: LIMIT, now: at("2026-03-10T21:00:00Z") });
  const afterUtcMidnight = await usage.consume({ db, uid: "u1", limit: LIMIT, now: at("2026-03-11T01:00:00Z") });
  assert.equal(afterUtcMidnight.allowed, false, "01:00 UTC is 06:00 Tashkent on the 11th... a new day there");
});

// ---- counting -----------------------------------------------------------------------------------------------------------

test("consume: counts one per request, tells how many are left, and refuses the (limit+1)th", async () => {
  const db = createFakeFirestore();
  const now = at("2026-03-10T10:00:00Z");
  const remaining = [];
  for (let i = 0; i < LIMIT; i += 1) remaining.push((await usage.consume({ db, uid: "u1", limit: LIMIT, now })).remaining);
  assert.deepEqual(remaining, [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
  const denied = await usage.consume({ db, uid: "u1", limit: LIMIT, now });
  assert.deepEqual([denied.allowed, denied.remaining, denied.used, denied.limit], [false, 0, 10, 10]);
  assert.equal(db.read("u1").usageCount, 10, "a refused request does not push the count past the limit");
  assert.equal(denied.plan, "free");
});

test("consume: every user has their own count", async () => {
  const db = createFakeFirestore();
  const now = at("2026-03-10T10:00:00Z");
  for (let i = 0; i < LIMIT; i += 1) await usage.consume({ db, uid: "alice", limit: LIMIT, now });
  assert.equal((await usage.consume({ db, uid: "alice", limit: LIMIT, now })).allowed, false);
  assert.equal((await usage.consume({ db, uid: "bob", limit: LIMIT, now })).allowed, true);
});

test("consume: a custom limit is honoured, and it keeps the other fields of the user document", async () => {
  const db = createFakeFirestore({ "users/u1": { displayName: "Ada", plan: "free" } });
  const now = at("2026-03-10T10:00:00Z");
  assert.equal((await usage.consume({ db, uid: "u1", limit: 2, now })).allowed, true);
  assert.equal((await usage.consume({ db, uid: "u1", limit: 2, now })).allowed, true);
  assert.equal((await usage.consume({ db, uid: "u1", limit: 2, now })).allowed, false);
  assert.equal(db.read("u1").displayName, "Ada");
  assert.equal(db.read("u1").plan, "free");
});

test("consume: damaged usage fields count as zero (they can only be written by the server, but never trust a stored value)", async () => {
  for (const bad of [{ usageCount: -5 }, { usageCount: "9" }, { usageCount: NaN }, { usageCount: 2.5 }, { usageCount: null }]) {
    const db = createFakeFirestore({ "users/u1": Object.assign({ usageDate: "2026-03-10" }, bad) });
    const result = await usage.consume({ db, uid: "u1", limit: LIMIT, now: at("2026-03-10T10:00:00Z") });
    assert.equal(result.allowed, true, JSON.stringify(bad));
    assert.equal(db.read("u1").usageCount, 1);
  }
});

// ---- concurrency ---------------------------------------------------------------------------------------------------------

test("concurrent requests never exceed the limit: 40 at once against a limit of 10 -> exactly 10 are allowed", async () => {
  const db = createFakeFirestore();
  const now = at("2026-03-10T10:00:00Z");
  const results = await Promise.all(Array.from({ length: 40 }, () => usage.consume({ db, uid: "u1", limit: LIMIT, now })));
  assert.equal(results.filter((r) => r.allowed).length, LIMIT);
  assert.equal(results.filter((r) => !r.allowed).length, 30);
  assert.equal(db.read("u1").usageCount, LIMIT);
  assert.ok(db.log.retries > 0, "the transactions really did collide and retry");
  const remainders = results.filter((r) => r.allowed).map((r) => r.remaining).sort((a, b) => b - a);
  assert.deepEqual(remainders, [9, 8, 7, 6, 5, 4, 3, 2, 1, 0], "each allowed request saw a different count");
});

test("concurrent requests race for the LAST slot: only one of many wins", async () => {
  const db = createFakeFirestore({ "users/u1": { usageDate: "2026-03-10", usageCount: LIMIT - 1 } });
  const now = at("2026-03-10T10:00:00Z");
  const results = await Promise.all(Array.from({ length: 25 }, () => usage.consume({ db, uid: "u1", limit: LIMIT, now })));
  assert.equal(results.filter((r) => r.allowed).length, 1);
  assert.equal(db.read("u1").usageCount, LIMIT);
});

test("separate server instances (separate callers sharing only Firestore) cannot exceed the limit either - nothing is held in memory", async () => {
  const db = createFakeFirestore();
  const now = at("2026-03-10T10:00:00Z");
  const instanceA = () => usage.consume({ db, uid: "u1", limit: 6, now });
  const instanceB = () => usage.consume({ db, uid: "u1", limit: 6, now });
  const results = await Promise.all([].concat(Array.from({ length: 10 }, instanceA), Array.from({ length: 10 }, instanceB)));
  assert.equal(results.filter((r) => r.allowed).length, 6);
  assert.equal(db.read("u1").usageCount, 6);
});

test("concurrent requests across the midnight boundary each use the day they arrived in", async () => {
  const db = createFakeFirestore({ "users/u1": { usageDate: "2026-03-10", usageCount: LIMIT } });
  const results = await Promise.all([
    usage.consume({ db, uid: "u1", limit: LIMIT, now: at("2026-03-10T18:59:59Z") }),
    usage.consume({ db, uid: "u1", limit: LIMIT, now: at("2026-03-10T19:00:01Z") })
  ]);
  assert.equal(results[0].allowed, false);
  assert.equal(results[1].allowed, true);
});

// ---- premium --------------------------------------------------------------------------------------------------------------

const NOW = at("2026-03-10T10:00:00Z");
const future = new Date(NOW.getTime() + 7 * 86400000);
const past = new Date(NOW.getTime() - 1000);

test("isPremium: needs plan 'premium' AND a premiumUntil in the future, in any stored form", () => {
  const stamp = (d) => ({ toMillis: () => d.getTime() });
  assert.equal(usage.isPremium({ plan: "premium", premiumUntil: stamp(future) }, NOW), true);
  assert.equal(usage.isPremium({ plan: "premium", premiumUntil: future }, NOW), true);
  assert.equal(usage.isPremium({ plan: "premium", premiumUntil: future.toISOString() }, NOW), true);
  assert.equal(usage.isPremium({ plan: "premium", premiumUntil: future.getTime() }, NOW), true);
  assert.equal(usage.isPremium({ plan: "premium", premiumUntil: { seconds: Math.floor(future.getTime() / 1000), nanoseconds: 0 } }, NOW), true);
  assert.equal(usage.isPremium({ plan: "premium", premiumUntil: stamp(past) }, NOW), false, "expired");
  assert.equal(usage.isPremium({ plan: "premium", premiumUntil: NOW }, NOW), false, "expires at that very moment");
});

test("isPremium: free plans, missing or garbage dates and non-documents are never premium", () => {
  assert.equal(usage.isPremium({ plan: "free", premiumUntil: future }, NOW), false, "a date alone is not premium");
  assert.equal(usage.isPremium({ plan: "premium" }, NOW), false, "no end date");
  for (const bad of [null, undefined, "tomorrow", {}, [], NaN, "", true]) assert.equal(usage.isPremium({ plan: "premium", premiumUntil: bad }, NOW), false, String(bad));
  assert.equal(usage.isPremium({ plan: "PREMIUM", premiumUntil: future }, NOW), false, "exact plan name only");
  assert.equal(usage.isPremium(null, NOW), false);
  assert.equal(usage.isPremium(undefined, NOW), false);
  assert.equal(usage.isPremium({}, NOW), false);
});

test("premium users are never limited and nothing is written for them", async () => {
  const db = createFakeFirestore({ "users/vip": { plan: "premium", premiumUntil: { toMillis: () => future.getTime() }, usageDate: "2026-03-10", usageCount: 999 } });
  const before = db.log.writes;
  for (let i = 0; i < 200; i += 1) {
    const r = await usage.consume({ db, uid: "vip", limit: LIMIT, now: NOW });
    assert.deepEqual([r.allowed, r.premium, r.plan, r.remaining, r.limit], [true, true, "premium", null, null]);
  }
  assert.equal(db.log.writes, before);
});

test("an EXPIRED premium plan counts as free automatically, with its own usage", async () => {
  const db = createFakeFirestore({ "users/lapsed": { plan: "premium", premiumUntil: past } });
  const results = [];
  for (let i = 0; i < LIMIT + 2; i += 1) results.push(await usage.consume({ db, uid: "lapsed", limit: LIMIT, now: NOW }));
  assert.equal(results.filter((r) => r.allowed).length, LIMIT);
  assert.equal(results[0].plan, "free");
  assert.equal(results[0].premium, false);
  assert.equal(db.read("lapsed").plan, "premium", "the document itself is untouched; expiry is decided from the date");
});

test("premium that expires between two requests: the next one is counted", async () => {
  const until = new Date(NOW.getTime() + 60 * 1000);
  const db = createFakeFirestore({ "users/u1": { plan: "premium", premiumUntil: until } });
  assert.equal((await usage.consume({ db, uid: "u1", limit: 1, now: NOW })).premium, true);
  const later = new Date(until.getTime() + 1);
  assert.equal((await usage.consume({ db, uid: "u1", limit: 1, now: later })).premium, false);
  assert.equal((await usage.consume({ db, uid: "u1", limit: 1, now: later })).allowed, false);
});

// ---- peek and release -------------------------------------------------------------------------------------------------------

test("peek: reports plan, used, remaining and the reset time without counting", async () => {
  const db = createFakeFirestore({ "users/u1": { usageDate: "2026-03-10", usageCount: 3 } });
  const snap = await usage.peek({ db, uid: "u1", limit: LIMIT, now: NOW });
  assert.deepEqual([snap.plan, snap.used, snap.remaining, snap.limit], ["free", 3, 7, 10]);
  assert.equal(snap.resetAt, "2026-03-10T19:00:00.000Z");
  assert.equal(db.read("u1").usageCount, 3);
  const nothing = await usage.peek({ db, uid: "new-user", limit: LIMIT, now: NOW });
  assert.deepEqual([nothing.used, nothing.remaining], [0, 10]);
  assert.equal(db.records.has("users/new-user"), false, "reading does not create a document");
  const yesterday = await usage.peek({ db: createFakeFirestore({ "users/u1": { usageDate: "2026-03-09", usageCount: 10 } }), uid: "u1", limit: LIMIT, now: NOW });
  assert.equal(yesterday.remaining, 10, "yesterday's count is not today's");
  const vip = await usage.peek({ db: createFakeFirestore({ "users/v": { plan: "premium", premiumUntil: future } }), uid: "v", limit: LIMIT, now: NOW });
  assert.deepEqual([vip.premium, vip.remaining, vip.limit], [true, null, null]);
  assert.equal(vip.premiumUntil, future.toISOString());
});

test("release: gives one request back for the same day, never below zero, never across days", async () => {
  const db = createFakeFirestore();
  const dateKey = usage.dayKey(NOW);
  await usage.consume({ db, uid: "u1", limit: LIMIT, now: NOW });
  await usage.consume({ db, uid: "u1", limit: LIMIT, now: NOW });
  assert.equal(await usage.release({ db, uid: "u1", dateKey }), true);
  assert.equal(db.read("u1").usageCount, 1);
  assert.equal(await usage.release({ db, uid: "u1", dateKey }), true);
  assert.equal(await usage.release({ db, uid: "u1", dateKey }), false, "already zero");
  assert.equal(db.read("u1").usageCount, 0);
  await usage.consume({ db, uid: "u1", limit: LIMIT, now: NOW });
  assert.equal(await usage.release({ db, uid: "u1", dateKey: "2026-03-09" }), false, "a request from yesterday cannot refund today");
  assert.equal(db.read("u1").usageCount, 1);
  assert.equal(await usage.release({ db, uid: "nobody", dateKey }), false);
});
