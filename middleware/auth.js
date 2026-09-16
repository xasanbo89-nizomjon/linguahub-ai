"use strict";

// LinguaHub AI - Firebase ID token authentication middleware.
//
// Two flavors:
//   - authenticateRequired: 401 if no valid token is present. Used for
//     routes whose entire purpose is returning the verified identity
//     (e.g. GET /api/auth/me).
//   - authenticateOptional: never rejects the request. Populates req.user
//     when a valid token is present, otherwise req.user is null and the
//     request proceeds as a guest. Used for the chat routes, which remain
//     usable without login (see docs/phase-02-authentication.md for the
//     access-policy rationale).
//
// The frontend-supplied identity is never trusted: req.user is only ever
// populated from claims returned by firebaseAdmin.verifyIdToken (i.e. a
// token cryptographically verified by Firebase), never from the request
// body/query/headers directly.

const firebaseAdmin = require("../lib/firebaseAdmin");

function extractBearerToken(req) {
  const header = req.headers.authorization;
  if (!header || typeof header !== "string") return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function toSafeUser(decodedToken) {
  return {
    uid: decodedToken.uid,
    email: decodedToken.email || null,
    name: decodedToken.name || null,
    picture: decodedToken.picture || null,
    emailVerified: Boolean(decodedToken.email_verified)
  };
}

function mapVerifyError(error) {
  if (error && error.code === "auth/admin-not-configured") {
    return { status: 503, reply: "❌ Authentication service is not configured." };
  }
  // Every other Firebase verification failure (expired, malformed, revoked,
  // wrong project, network error fetching Google's public keys, ...) is
  // reported generically - the raw Firebase error is never sent to the client.
  return { status: 401, reply: "❌ Invalid or expired authentication token." };
}

async function authenticateRequired(req, res, next) {
  const token = extractBearerToken(req);
  if (!token) {
    return res.status(401).json({ reply: "❌ Authentication required." });
  }

  try {
    const decoded = await firebaseAdmin.verifyIdToken(token);
    req.user = toSafeUser(decoded);
    return next();
  } catch (error) {
    console.warn("[auth] token verification failed:", error?.code || "unknown_error");
    const mapped = mapVerifyError(error);
    return res.status(mapped.status).json({ reply: mapped.reply });
  }
}

async function authenticateOptional(req, res, next) {
  const token = extractBearerToken(req);
  if (!token) {
    req.user = null;
    return next();
  }

  try {
    const decoded = await firebaseAdmin.verifyIdToken(token);
    req.user = toSafeUser(decoded);
  } catch (error) {
    // Guest-allowed routes must keep working even with a bad/expired token
    // or an unconfigured Admin SDK - fail open to guest, not to an error.
    req.user = null;
  }

  return next();
}

module.exports = {
  authenticateRequired,
  authenticateOptional,
  extractBearerToken,
  toSafeUser
};
