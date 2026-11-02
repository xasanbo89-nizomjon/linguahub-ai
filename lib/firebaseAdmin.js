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

function getCertFunction() {
  if (admin && admin.credential && typeof admin.credential.cert === "function") {
    return admin.credential.cert;
  }
  if (admin && typeof admin.cert === "function") {
    return admin.cert;
  }
  try {
    const { cert } = require("firebase-admin/app");
    if (typeof cert === "function") return cert;
  } catch (e) {
    // fallback
  }
  return null;
}

function getAppDefaultFunction() {
  if (admin && admin.credential && typeof admin.credential.applicationDefault === "function") {
    return admin.credential.applicationDefault;
  }
  if (admin && typeof admin.applicationDefault === "function") {
    return admin.applicationDefault;
  }
  try {
    const { applicationDefault } = require("firebase-admin/app");
    if (typeof applicationDefault === "function") return applicationDefault;
  } catch (e) {
    // fallback
  }
  return null;
}

function loadCredential() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const appDefault = getAppDefaultFunction();
    return appDefault ? appDefault() : null;
  }

  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.project_id;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL || process.env.client_email;
  const privateKey = normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY || process.env.private_key);

  if (projectId && clientEmail && privateKey) {
    const certFn = getCertFunction();
    if (certFn) {
      return certFn({ projectId, clientEmail, privateKey });
    }
  }

  return null;
}

let configured = false;

try {
  const credential = loadCredential();
  if (credential) {
    if (!admin.apps || !admin.apps.length) {
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
    "Every AI request needs a verified sign-in, so the AI routes respond 503 until it is configured."
  );
}

const CHECK_REVOKED = process.env.FIREBASE_CHECK_REVOKED === "true";

function requireConfigured() {
  if (!configured) {
    const error = new Error("Firebase Admin is not configured.");
    error.code = "auth/admin-not-configured";
    throw error;
  }
}

function getAuth() {
  requireConfigured();
  if (typeof admin.auth === "function") return admin.auth();
  try {
    const { getAuth: modularAuth } = require("firebase-admin/auth");
    return modularAuth();
  } catch (e) {
    return admin.auth();
  }
}

async function verifyIdToken(idToken) {
  if (!configured) {
    const error = new Error("Firebase Admin is not configured.");
    error.code = "auth/admin-not-configured";
    throw error;
  }
  const authInstance = getAuth();
  return authInstance.verifyIdToken(idToken, CHECK_REVOKED);
}

// Firestore through the Admin SDK (bypasses the security rules: only server code
// may use it). Used for the daily usage count and the premium plan (lib/usage.js).
function getFirestore() {
  requireConfigured();
  if (typeof admin.firestore === "function") return admin.firestore();
  try {
    const { getFirestore: modularFirestore } = require("firebase-admin/firestore");
    return modularFirestore();
  } catch (e) {
    return admin.firestore();
  }
}

function timestampFromDate(date) {
  requireConfigured();
  if (admin.firestore && admin.firestore.Timestamp && typeof admin.firestore.Timestamp.fromDate === "function") {
    return admin.firestore.Timestamp.fromDate(date);
  }
  try {
    const { Timestamp } = require("firebase-admin/firestore");
    return Timestamp.fromDate(date);
  } catch (e) {
    return { toMillis: () => date.getTime(), toDate: () => date };
  }
}

module.exports = {
  isConfigured: () => configured,
  verifyIdToken,
  getFirestore,
  getAuth,
  timestampFromDate
};
