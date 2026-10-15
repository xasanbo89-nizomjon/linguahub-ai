"use strict";

// LinguaHub AI - the ONE gate every AI endpoint goes through.
//
// server.js builds each AI route as  aiChain(rateLimiters...)  =
//   [ authenticateRequired,  (a verified Firebase ID token, or 401)
//     ...rateLimiters,       (so a request refused for speed is never counted)
//     usageGate ]            (the daily free limit, below)
// and a test checks that every route that reaches the AI provider uses it, so
// no endpoint can be called around the limit. The only AI-related route
// outside it is the landing page's "try one correction", which has no sign-in
// by design and is limited per IP address instead.
//
// What counts as one request: every chat message (including Regenerate and an
// edited message sent again), Translate, Grammar, Speak turns, vocabulary
// suggestions and messages with pictures. NOT counted: tap-a-word lookups
// (mode "word-lookup", cached by the page) and the transcription of the
// learner's own voice (POST /api/transcribe) - both still need a signed-in
// user, they just do not use up the day's allowance.
//
// Fail closed: if the usage record cannot be read or written the request is
// refused (503), never let through unmetered.

const usage = require("./usage.js");

const UNCOUNTED_ROUTES = ["/api/transcribe"];
const UNCOUNTED_MODES = ["word-lookup"];
const EXPOSED_HEADERS = ["X-Usage-Plan", "X-Usage-Limit", "X-Usage-Remaining", "X-Usage-Reset"];

// options: { getAdmin() -> the lib/firebaseAdmin module, limit, now() -> Date, logger,
//            priceLabel, contactUrl }
function createAiGate(options) {
  const requireSignIn = options.requireSignIn !== false; // unless told otherwise, a sign-in is required (the stricter way)
  const guestLimit = options.guestLimit || 10;
  const guestImageLimit = options.guestImageLimit || 2;
  const guestGlobalCap = options.guestGlobalCap || 2000;
  const salt = options.salt || "";
  const getAdmin = options.getAdmin || (() => require("./firebaseAdmin.js"));
  const now = options.now || (() => new Date());
  const logger = options.logger || { warn() {}, error() {} };
  const limit = options.limit || usage.DEFAULT_FREE_DAILY_LIMIT;

  function isCounted(req) {
    if (UNCOUNTED_ROUTES.indexOf(req.path) !== -1) return false;
    const mode = req.body && req.body.mode;
    return !(typeof mode === "string" && UNCOUNTED_MODES.indexOf(mode) !== -1);
  }

  function database() {
    return getAdmin().getFirestore();
  }

  // the numbers every AI response carries, as headers (and as a "quota" field in JSON bodies)
  function quotaOf(snapshot) {
    return { plan: snapshot.plan, premium: snapshot.premium, limit: snapshot.limit, remaining: snapshot.remaining, resetAt: snapshot.resetAt };
  }

  function setHeaders(res, snapshot) {
    res.setHeader("X-Usage-Plan", snapshot.plan);
    res.setHeader("X-Usage-Limit", snapshot.premium ? "unlimited" : String(snapshot.limit));
    res.setHeader("X-Usage-Remaining", snapshot.premium ? "unlimited" : String(snapshot.remaining));
    res.setHeader("X-Usage-Reset", snapshot.resetAt);
  }

  // pictures on the final message (the server's own request check, lib/images.js, validates them later)
  function pictureCount(req) {
    const messages = req.body && Array.isArray(req.body.messages) ? req.body.messages : [];
    const last = messages[messages.length - 1];
    return last && last.role === "user" && Array.isArray(last.images) ? last.images.length : 0;
  }

  function guestHash(req) {
    return usage.guestKey(req.ip, salt);
  }

  // No sign-in, REQUIRE_SIGN_IN is false: the request is counted against the guest's hashed IP address.
  async function guestGate(req, res, next) {
    if (!isCounted(req)) return next();
    const ipHash = guestHash(req);
    const pictures = pictureCount(req);
    let result;
    try {
      result = await usage.consumeGuest({ db: database(), ipHash, limit: guestLimit, imageLimit: guestImageLimit, globalCap: guestGlobalCap, images: pictures, now: now() });
    } catch (error) {
      logger.error("guest usage check failed", { requestId: req.id, errorName: error && error.name, code: error && error.code });
      return res.status(503).json({ reply: "❌ Couldn't check your daily allowance right now. Please try again in a moment.", code: "USAGE_UNAVAILABLE", requestId: req.id });
    }
    setHeaders(res, result);
    if (!result.allowed) {
      const retry = Math.max(1, Math.ceil((Date.parse(result.resetAt) - now().getTime()) / 1000));
      res.setHeader("Retry-After", String(retry));
      const base = { remaining: 0, limit: result.limit, resetAt: result.resetAt, guest: true, requestId: req.id };
      if (result.reason === "cap") return res.status(429).json(Object.assign({ reply: "❌ Free use without an account is busy right now. Sign in to continue.", code: "GUEST_CAP_REACHED" }, base));
      if (result.reason === "images") return res.status(429).json(Object.assign({ reply: "❌ You've used today's free pictures. Sign in to send more.", code: "GUEST_IMAGE_LIMIT_REACHED" }, base));
      return res.status(429).json(Object.assign({ reply: "❌ You've used all your free requests for today.", code: "DAILY_LIMIT_REACHED", priceLabel: options.priceLabel || null, contactUrl: options.contactUrl || null }, base));
    }
    req.usage = { counted: true, guest: true, ipHash, dateKey: result.dateKey, pictures, quota: Object.assign(quotaOf(result), { guest: true }), refunded: false };
    return next();
  }

  async function usageGate(req, res, next) {
    const uid = req.user && req.user.uid;
    if (!uid) {
      if (requireSignIn) return res.status(401).json({ reply: "❌ Authentication required.", code: "AUTH_REQUIRED", requestId: req.id });
      return guestGate(req, res, next);
    }
    if (!isCounted(req)) return next();
    let result;
    try {
      result = await usage.consume({ db: database(), uid, limit, now: now() });
    } catch (error) {
      logger.error("usage check failed", { requestId: req.id, errorName: error && error.name, code: error && error.code });
      return res.status(503).json({ reply: "❌ Couldn't check your daily allowance right now. Please try again in a moment.", code: "USAGE_UNAVAILABLE", requestId: req.id });
    }
    setHeaders(res, result);
    if (!result.allowed) {
      const retry = Math.max(1, Math.ceil((Date.parse(result.resetAt) - now().getTime()) / 1000));
      res.setHeader("Retry-After", String(retry));
      return res.status(429).json({
        reply: "❌ You've used all your free requests for today.",
        code: "DAILY_LIMIT_REACHED",
        remaining: 0,
        limit: result.limit,
        resetAt: result.resetAt,
        priceLabel: options.priceLabel || null,
        contactUrl: options.contactUrl || null,
        requestId: req.id
      });
    }
    req.usage = { counted: true, dateKey: result.dateKey, uid, quota: quotaOf(result), refunded: false };
    return next();
  }

  // Gives the request back (it was invalid, or the AI provider failed before answering).
  async function refund(req) {
    const u = req.usage;
    if (!u || !u.counted || u.refunded) return false;
    u.refunded = true;
    try {
      if (u.guest) return await usage.releaseGuest({ db: database(), ipHash: u.ipHash, dateKey: u.dateKey, images: u.pictures });
      return await usage.release({ db: database(), uid: u.uid, dateKey: u.dateKey });
    } catch (error) {
      logger.warn("usage refund failed", { requestId: req.id });
      return false;
    }
  }

  // The "quota" field added to JSON replies: what is left after this request.
  function quotaFor(req) {
    return req.usage ? req.usage.quota : null;
  }

  // GET /api/usage: the current state, counting nothing.
  async function current(uid) {
    return usage.peek({ db: database(), uid, limit, now: now() });
  }

  async function currentGuest(req) {
    return usage.peekGuest({ db: database(), ipHash: guestHash(req), limit: guestLimit, imageLimit: guestImageLimit, globalCap: guestGlobalCap, now: now() });
  }

  return { usageGate, refund, quotaFor, current, currentGuest, isCounted, limit, requireSignIn };
}

module.exports = { createAiGate, UNCOUNTED_ROUTES, UNCOUNTED_MODES, EXPOSED_HEADERS };
