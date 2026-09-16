"use strict";

// LinguaHub AI - Firebase Admin SDK initialization (server-only).
//
// Credentials are never logged. Supports two initialization strategies,
// tried in this order:
//   1. GOOGLE_APPLICATION_CREDENTIALS (path to a service-account JSON file) -
//      the standard Google Cloud convention, picked up automatically by
//      admin.credential.applicationDefault().
//   2. Discrete env vars: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL,
//      FIREBASE_PRIVATE_KEY.
//
// If neither is present, Admin stays unconfigured: authenticated-required
// routes fail clearly with 503 (see middleware/auth.js) while guest-allowed
// routes keep working normally - the app never crashes or fakes a verified
// identity just because credentials are missing.

const admin = require("firebase-admin");

function normalizePrivateKey(key) {
  if (!key) return key;
  // .env files commonly store multi-line PEM keys with literal "\n".
  return key.includes("\\n") ? key.replace(/\\n/g, "\n") : key;
}

function loadCredential() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return admin.credential.applicationDefault();
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY);

  if (projectId && clientEmail && privateKey) {
    return admin.credential.cert({ projectId, clientEmail, privateKey });
  }

  return null;
}

let configured = false;

try {
  const credential = loadCredential();
  if (credential) {
    if (!admin.apps.length) {
      admin.initializeApp({ credential });
    }
    configured = true;
  }
} catch (error) {
  console.error("[firebase-admin] Failed to initialize:", error.message);
  configured = false;
}

if (!configured) {
  console.warn(
    "⚠️  Firebase Admin is not configured (set GOOGLE_APPLICATION_CREDENTIALS, or " +
    "FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY). " +
    "Authenticated-only routes will respond 503 until configured; guest chat is unaffected."
  );
}

const CHECK_REVOKED = process.env.FIREBASE_CHECK_REVOKED === "true";

async function verifyIdToken(idToken) {
  if (!configured) {
    const error = new Error("Firebase Admin is not configured.");
    error.code = "auth/admin-not-configured";
    throw error;
  }
  return admin.auth().verifyIdToken(idToken, CHECK_REVOKED);
}

module.exports = {
  isConfigured: () => configured,
  verifyIdToken
};
