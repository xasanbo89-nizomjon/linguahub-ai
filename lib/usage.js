"use strict";

// LinguaHub AI - the daily free limit and the premium plan (server side).
//
// Everything lives on the user's own document in Firestore, users/{uid}:
//   plan          "free" | "premium"
//   premiumUntil  Timestamp - premium counts only while this is in the future
//   usageDate     "YYYY-MM-DD" in Asia/Tashkent - the day usageCount belongs to
//   usageCount    AI requests used on usageDate
// Only this server (Firebase Admin, which bypasses the rules) ever writes
// those four fields - firestore.rules forbids clients from touching them.
//
// A request is counted with ONE Firestore transaction (read the document,
// decide, write the new count), so two requests arriving together can never
// both take the last free slot - and nothing is counted in memory, because
// serverless instances do not share memory.
//
// The free day ends at midnight in Asia/Tashkent (UTC+5, no daylight saving).

const TIME_ZONE = "Asia/Tashkent";
const DEFAULT_FREE_DAILY_LIMIT = 10;
const COLLECTION = "users";
const DAY_MS = 24 * 60 * 60 * 1000;

function toDate(now) {
  return now instanceof Date ? now : new Date(typeof now === "number" ? now : Date.now());
}

// The calendar day in Tashkent, as YYYY-MM-DD.
function dayKey(now) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(toDate(now));
  const get = (type) => parts.find((p) => p.type === type).value;
  return get("year") + "-" + get("month") + "-" + get("day");
}

// How far Tashkent's clock is ahead of UTC at this moment, in ms.
function offsetMs(now) {
  const date = toDate(now);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// The next midnight in Tashkent (when the free requests renew), as an ISO string.
function nextResetAt(now) {
  const date = toDate(now);
  const offset = offsetMs(date);
  const localMs = date.getTime() + offset;
  const nextLocalMidnight = Math.floor(localMs / DAY_MS) * DAY_MS + DAY_MS;
  return new Date(nextLocalMidnight - offset).toISOString();
}

// Firestore Timestamp, Date, epoch ms or ISO string -> epoch ms (NaN when it is none of them).
function toMillis(value) {
  if (value === null || value === undefined) return NaN;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") return Date.parse(value);
  if (typeof value === "object" && typeof value.seconds === "number") return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
  return NaN;
}

// Premium only while plan is "premium" AND premiumUntil is in the future; an
// expired premium plan counts as free without anyone having to reset it.
function isPremium(data, now) {
  if (!data || data.plan !== "premium") return false;
  const until = toMillis(data.premiumUntil);
  return Number.isFinite(until) && until > toDate(now).getTime();
}

function usedToday(data, today) {
  if (!data || data.usageDate !== today) return 0;
  return Number.isInteger(data.usageCount) && data.usageCount > 0 ? data.usageCount : 0;
}

function snapshotOf(data, now, limit) {
  const today = dayKey(now);
  const premium = isPremium(data, now);
  const used = usedToday(data, today);
  return {
    plan: premium ? "premium" : "free",
    premium,
    premiumUntil: premium ? new Date(toMillis(data.premiumUntil)).toISOString() : null,
    limit: premium ? null : limit,
    used: premium ? null : used,
    remaining: premium ? null : Math.max(0, limit - used),
    resetAt: nextResetAt(now),
    dateKey: today
  };
}

// Reads the current state without counting anything.
async function peek({ db, uid, limit, now }) {
  const snap = await db.collection(COLLECTION).doc(uid).get();
  return snapshotOf(snap.exists ? snap.data() : {}, now, limit);
}

// Counts ONE request, atomically. -> { allowed, ...snapshot (after counting) }
async function consume({ db, uid, limit, now }) {
  const moment = toDate(now);
  return db.runTransaction(async (tx) => {
    const ref = db.collection(COLLECTION).doc(uid);
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : {};
    if (isPremium(data, moment)) return Object.assign(snapshotOf(data, moment, limit), { allowed: true });
    const today = dayKey(moment);
    const used = usedToday(data, today);
    if (used >= limit) return Object.assign(snapshotOf(data, moment, limit), { allowed: false });
    tx.set(ref, { usageDate: today, usageCount: used + 1 }, { merge: true });
    return Object.assign(snapshotOf({ ...data, usageDate: today, usageCount: used + 1 }, moment, limit), { allowed: true });
  });
}

// Gives one request back (the request turned out to be invalid, or the AI
// provider failed before answering). Only ever for the same Tashkent day.
async function release({ db, uid, dateKey }) {
  return db.runTransaction(async (tx) => {
    const ref = db.collection(COLLECTION).doc(uid);
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : {};
    if (data.usageDate !== dateKey || !(Number.isInteger(data.usageCount) && data.usageCount > 0)) return false;
    tx.set(ref, { usageCount: data.usageCount - 1 }, { merge: true });
    return true;
  });
}

// ---- guests (REQUIRE_SIGN_IN=false): counted per hashed IP address -----------------------------------------------------

const GUEST_COLLECTION = "guestUsage";
const DEFAULT_SALT = "linguahub-guest-v1";

// What identifies a guest: their network address, hashed with a server-side secret. The raw address is
// never stored anywhere (not in Firestore, not in logs). An IPv6 address counts as its /64 network
// (one household can reach 2^64 addresses; counting each would give them unlimited guests), an
// IPv4-mapped IPv6 address as the IPv4 address inside it.
function normalizeIp(ip) {
  let value = String(ip || "").trim().toLowerCase();
  if (!value) return "unknown";
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (mapped) return mapped[1];
  if (value.indexOf(":") === -1) return value;
  value = value.replace(/%.*$/, "");
  let groups;
  if (value.indexOf("::") !== -1) {
    const parts = value.split("::");
    const head = parts[0] ? parts[0].split(":") : [];
    const tail = parts[1] ? parts[1].split(":") : [];
    groups = head.concat(new Array(Math.max(0, 8 - head.length - tail.length)).fill("0"), tail);
  } else groups = value.split(":");
  return groups.slice(0, 4).map((g) => (g || "0").replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

function guestKey(ip, salt) {
  return require("crypto").createHash("sha256").update((salt || DEFAULT_SALT) + ":" + normalizeIp(ip)).digest("hex");
}

function guestSnapshot(data, now, limits, extra) {
  const today = dayKey(now);
  const used = usedToday(data, today);
  const images = data && data.usageDate === today && Number.isInteger(data.imageCount) && data.imageCount > 0 ? data.imageCount : 0;
  return Object.assign({
    plan: "free",
    premium: false,
    guest: true,
    premiumUntil: null,
    limit: limits.limit,
    used,
    remaining: Math.max(0, limits.limit - used),
    imageLimit: limits.imageLimit,
    imagesRemaining: Math.max(0, limits.imageLimit - images),
    resetAt: nextResetAt(now),
    dateKey: today
  }, extra || {});
}

function globalCountOf(snap, today) {
  const data = snap.exists ? snap.data() : {};
  return data && data.date === today && Number.isInteger(data.count) && data.count > 0 ? data.count : 0;
}

// Counts ONE guest request, atomically: the guest's own count and the global count of all guests
// together, in one transaction. Checked in this order: the guest's own daily limit, the picture limit
// (when the request carries pictures), the global cap.
// -> { allowed, reason: "limit" | "images" | "cap" (when refused), ...snapshot after counting }
async function consumeGuest({ db, ipHash, limit, imageLimit, globalCap, images, now }) {
  const moment = toDate(now);
  const today = dayKey(moment);
  const limits = { limit, imageLimit };
  return db.runTransaction(async (tx) => {
    const ref = db.collection(GUEST_COLLECTION).doc(ipHash);
    const globalRef = db.collection(GUEST_COLLECTION).doc("global-" + today);
    const snap = await tx.get(ref);
    const globalSnap = await tx.get(globalRef);
    const data = snap.exists ? snap.data() : {};
    const used = usedToday(data, today);
    const imagesUsed = data.usageDate === today && Number.isInteger(data.imageCount) && data.imageCount > 0 ? data.imageCount : 0;
    const globalCount = globalCountOf(globalSnap, today);
    if (used >= limit) return Object.assign(guestSnapshot(data, moment, limits), { allowed: false, reason: "limit" });
    if (images > 0 && imagesUsed >= imageLimit) return Object.assign(guestSnapshot(data, moment, limits), { allowed: false, reason: "images" });
    if (globalCount >= globalCap) return Object.assign(guestSnapshot(data, moment, limits), { allowed: false, reason: "cap" });
    const next = { usageDate: today, usageCount: used + 1, imageCount: imagesUsed + (images > 0 ? 1 : 0) };
    tx.set(ref, next, { merge: true });
    tx.set(globalRef, { date: today, count: globalCount + 1 }, { merge: true });
    return Object.assign(guestSnapshot(next, moment, limits), { allowed: true });
  });
}

// Gives a guest request back (invalid request / the AI failed before answering), same day only.
async function releaseGuest({ db, ipHash, dateKey, images }) {
  return db.runTransaction(async (tx) => {
    const ref = db.collection(GUEST_COLLECTION).doc(ipHash);
    const globalRef = db.collection(GUEST_COLLECTION).doc("global-" + dateKey);
    const snap = await tx.get(ref);
    const globalSnap = await tx.get(globalRef);
    const data = snap.exists ? snap.data() : {};
    if (data.usageDate !== dateKey || !(Number.isInteger(data.usageCount) && data.usageCount > 0)) return false;
    const patch = { usageCount: data.usageCount - 1 };
    if (images > 0 && Number.isInteger(data.imageCount) && data.imageCount > 0) patch.imageCount = data.imageCount - 1;
    tx.set(ref, patch, { merge: true });
    const globalCount = globalCountOf(globalSnap, dateKey);
    if (globalCount > 0) tx.set(globalRef, { date: dateKey, count: globalCount - 1 }, { merge: true });
    return true;
  });
}

// Reads a guest's state without counting.
async function peekGuest({ db, ipHash, limit, imageLimit, globalCap, now }) {
  const moment = toDate(now);
  const today = dayKey(moment);
  const snap = await db.collection(GUEST_COLLECTION).doc(ipHash).get();
  const globalSnap = await db.collection(GUEST_COLLECTION).doc("global-" + today).get();
  return guestSnapshot(snap.exists ? snap.data() : {}, moment, { limit, imageLimit }, { capReached: globalCountOf(globalSnap, today) >= globalCap });
}

module.exports = {
  GUEST_COLLECTION,
  DEFAULT_SALT,
  normalizeIp,
  guestKey,
  consumeGuest,
  releaseGuest,
  peekGuest,
  TIME_ZONE,
  DEFAULT_FREE_DAILY_LIMIT,
  COLLECTION,
  dayKey,
  nextResetAt,
  toMillis,
  isPremium,
  snapshotOf,
  peek,
  consume,
  release
};
