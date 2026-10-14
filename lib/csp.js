"use strict";

// LinguaHub AI - the Content-Security-Policy, in one place.
//
// server.js hands `cspDirectives` to helmet (Express serves the page and the
// API). On Vercel the page is a plain static file that never passes through
// Express, so vercel.json must send the very same policy as a header: a test
// compares vercel.json with cspHeaderValue() so the two can never drift apart.
//
// Scoped to what the app really loads: same-origin scripts/styles/fonts, the
// Firebase Web SDK from Google's CDN, the Firebase Auth endpoints used by
// Google sign-in, and Google profile photos. No inline script or style.
// Microphone recordings are uploaded to our own origin (/api/transcribe).

const cspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'", "https://www.gstatic.com"],
  scriptSrcAttr: ["'none'"],
  styleSrc: ["'self'"],
  imgSrc: ["'self'", "data:", "https://*.googleusercontent.com"],
  connectSrc: [
    "'self'",
    "https://identitytoolkit.googleapis.com",
    "https://securetoken.googleapis.com"
  ],
  frameSrc: ["https://*.firebaseapp.com", "https://accounts.google.com"],
  fontSrc: ["'self'"],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  frameAncestors: ["'self'"]
};

function kebab(name) {
  return name.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
}

// "default-src 'self'; script-src 'self' https://www.gstatic.com; ..."
function cspHeaderValue() {
  return Object.keys(cspDirectives).map((name) => kebab(name) + " " + cspDirectives[name].join(" ")).join("; ");
}

module.exports = { cspDirectives, cspHeaderValue };
