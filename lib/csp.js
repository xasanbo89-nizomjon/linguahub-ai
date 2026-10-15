"use strict";

// LinguaHub AI - the Content-Security-Policy, in one place.
//
// server.js hands `cspDirectives` to helmet (Express serves the page and the
// API). On Vercel the page is a plain static file that never passes through
// Express, so vercel.json must send the very same policy as a header: a test
// compares vercel.json with cspHeaderValue() so the two can never drift apart.
// (The page has no <meta> CSP, and the desktop app loads file:// pages, which
// carry no CSP header at all.)
//
// Exactly what Firebase Authentication + Firestore + Google sign-in need, and
// nothing broader. No inline script or style anywhere.
//   script-src   Google's sign-in loader (apis.google.com/js/api.js) and the
//                Firebase SDK (www.gstatic.com).
//   frame-src    Firebase Auth's hidden iframe and sign-in handler: this very
//                origin (on the web the auth domain is the page's own host,
//                proxied by Vercel - see vercel.json), the project's
//                <projectId>.firebaseapp.com (desktop and localhost), Google's
//                account chooser and apis.google.com. The project id is read
//                from www/firebase-config.js, the one place it is defined.
//   connect-src  The Firebase endpoints the SDK calls (sign-in, tokens,
//                Firestore, installations, Google APIs) plus www.gstatic.com,
//                which the SDK fetches source maps from.
//   img-src      Google profile pictures (lh3.googleusercontent.com).
// Microphone recordings are uploaded to our own origin (/api/transcribe).

const fs = require("fs");
const path = require("path");

// A Firebase / Google Cloud project id: 6-30 chars, lowercase letters, digits, hyphens.
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

function readProjectId() {
  try {
    const source = fs.readFileSync(path.join(__dirname, "..", "www", "firebase-config.js"), "utf8");
    const match = /projectId:\s*"([^"]+)"/.exec(source);
    return match && PROJECT_ID.test(match[1]) ? match[1] : null;
  } catch (error) {
    return null;
  }
}

const projectId = readProjectId();

const cspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'", "https://apis.google.com", "https://www.gstatic.com"],
  scriptSrcAttr: ["'none'"],
  styleSrc: ["'self'"],
  imgSrc: ["'self'", "data:", "https://lh3.googleusercontent.com"],
  connectSrc: [
    "'self'",
    "https://identitytoolkit.googleapis.com",
    "https://securetoken.googleapis.com",
    "https://firestore.googleapis.com",
    "https://firebaseinstallations.googleapis.com",
    "https://www.googleapis.com",
    "https://apis.google.com",
    "https://www.gstatic.com"
  ],
  frameSrc: ["'self'", "https://accounts.google.com", "https://apis.google.com"].concat(projectId ? ["https://" + projectId + ".firebaseapp.com"] : []),
  fontSrc: ["'self'"],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  frameAncestors: ["'self'"]
};

function kebab(name) {
  return name.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
}

// "default-src 'self'; script-src 'self' https://apis.google.com ...; ..."
function cspHeaderValue() {
  return Object.keys(cspDirectives).map((name) => kebab(name) + " " + cspDirectives[name].join(" ")).join("; ");
}

module.exports = { cspDirectives, cspHeaderValue, projectId, readProjectId };
