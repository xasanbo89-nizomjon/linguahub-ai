"use strict";

// Google sign-in on the web and in the installed app: the Content-Security-Policy lets
// Firebase Auth work (and nothing more), the auth domain follows the host, installed web
// apps sign in by redirect, and failures are logged with their real code.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { cspDirectives, cspHeaderValue, projectId, readProjectId } = require("../lib/csp.js");

const root = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");
const AUTH_SRC = read("www", "auth.js");
const vercel = JSON.parse(read("vercel.json"));

// ---- the policy -----------------------------------------------------------------------------------------------------

test("the project id comes from www/firebase-config.js, the one place it is defined", () => {
  const configured = /projectId:\s*"([^"]+)"/.exec(read("www", "firebase-config.js"))[1];
  assert.equal(projectId, configured);
  assert.equal(readProjectId(), configured);
});

test("script-src: this site, Google's sign-in loader and the Firebase SDK - nothing else", () => {
  assert.deepEqual(cspDirectives.scriptSrc, ["'self'", "https://apis.google.com", "https://www.gstatic.com"]);
});

test("frame-src: Firebase Auth's iframe on this origin and on the project's firebaseapp.com, Google's account chooser and apis.google.com", () => {
  assert.deepEqual(cspDirectives.frameSrc, ["'self'", "https://accounts.google.com", "https://apis.google.com", "https://" + projectId + ".firebaseapp.com"]);
  assert.ok(!cspDirectives.frameSrc.some((s) => s.includes("*")), "no wildcard: only this project's domain");
});

test("connect-src: exactly the Firebase / Google endpoints the SDK calls, plus gstatic for source maps", () => {
  assert.deepEqual(cspDirectives.connectSrc, [
    "'self'",
    "https://identitytoolkit.googleapis.com",
    "https://securetoken.googleapis.com",
    "https://firestore.googleapis.com",
    "https://firebaseinstallations.googleapis.com",
    "https://www.googleapis.com",
    "https://apis.google.com",
    "https://www.gstatic.com"
  ]);
});

test("img-src: this site, data: URLs (thumbnails) and Google avatars (lh3.googleusercontent.com)", () => {
  assert.deepEqual(cspDirectives.imgSrc, ["'self'", "data:", "https://lh3.googleusercontent.com"]);
});

test("everything else stays as strict as before: no inline script or style, no eval, no wildcard hosts, objects and base URI locked", () => {
  assert.deepEqual(cspDirectives.defaultSrc, ["'self'"]);
  assert.deepEqual(cspDirectives.scriptSrcAttr, ["'none'"]);
  assert.deepEqual(cspDirectives.styleSrc, ["'self'"]);
  assert.deepEqual(cspDirectives.fontSrc, ["'self'"]);
  assert.deepEqual(cspDirectives.objectSrc, ["'none'"]);
  assert.deepEqual(cspDirectives.baseUri, ["'self'"]);
  assert.deepEqual(cspDirectives.formAction, ["'self'"]);
  assert.deepEqual(cspDirectives.frameAncestors, ["'self'"]);
  const header = cspHeaderValue();
  assert.doesNotMatch(header, /unsafe-inline|unsafe-eval|unsafe-hashes|\*|\shttps:[;\s]|\shttp:/);
  assert.equal(Object.keys(cspDirectives).length, 12, "no directive was added or dropped");
});

test("the header text is the directives, in the standard form", () => {
  const header = cspHeaderValue();
  assert.match(header, /^default-src 'self'; script-src 'self' https:\/\/apis\.google\.com https:\/\/www\.gstatic\.com; script-src-attr 'none'; style-src 'self'; img-src 'self' data: https:\/\/lh3\.googleusercontent\.com; connect-src /);
  assert.match(header, /frame-src 'self' https:\/\/accounts\.google\.com https:\/\/apis\.google\.com https:\/\/linguahub-ai\.firebaseapp\.com;/);
  assert.match(header, /frame-ancestors 'self'$/);
});

// ---- defined in one place, sent everywhere it is needed --------------------------------------------------------------------

test("the policy is defined once (lib/csp.js): Express (helmet) and vercel.json send the same text", async () => {
  const header = vercel.headers[0].headers.find((h) => h.key === "Content-Security-Policy").value;
  assert.equal(header, cspHeaderValue());
  assert.match(read("server.js"), /directives: cspDirectives/);
  const express = require("express");
  const helmet = require("helmet");
  const app = express();
  app.use(helmet({ contentSecurityPolicy: { useDefaults: false, directives: cspDirectives } }));
  app.get("/", (req, res) => res.send("ok"));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const response = await fetch("http://127.0.0.1:" + server.address().port + "/");
    const sent = response.headers.get("content-security-policy").split(";").map((d) => d.trim()).filter(Boolean);
    assert.deepEqual(sent, cspHeaderValue().split(";").map((d) => d.trim()).filter(Boolean));
  } finally { await new Promise((r) => { server.close(r); server.closeAllConnections && server.closeAllConnections(); }); }
});

test("no other CSP exists: no <meta> policy in any page, and the desktop app loads file:// pages without one", () => {
  ["index.html"].forEach((f) => assert.doesNotMatch(read("www", f), /http-equiv=["']?Content-Security-Policy/i, f));
  assert.doesNotMatch(read("index.html"), /Content-Security-Policy/i);
  const main = read("main.js");
  assert.match(main, /loadFile\(path\.join\(__dirname, "www", "index\.html"\)\)/);
  assert.doesNotMatch(main, /Content-Security-Policy|onHeadersReceived/, "Electron adds no policy of its own");
  const code = read("server.js").split(/\r?\n/).filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.equal((code.match(/contentSecurityPolicy/g) || []).length, 1, "one helmet CSP in the server");
});

test("every external script the page loads comes from an origin script-src allows", () => {
  const html = read("www", "index.html");
  const origins = new Set();
  html.replace(/<script[^>]+src="(https:\/\/[^"]+)"/g, (m, url) => { origins.add(new URL(url).origin); return m; });
  assert.ok(origins.size >= 1);
  origins.forEach((origin) => assert.ok(cspDirectives.scriptSrc.includes(origin), origin + " is allowed by script-src"));
});

// ---- the Vercel host forwards Firebase's sign-in pages -----------------------------------------------------------------------

test("vercel.json: /__/auth/* is forwarded to the project's firebaseapp.com, ahead of the API rewrites", () => {
  assert.deepEqual(vercel.rewrites[0], { source: "/__/auth/:path*", destination: "https://" + projectId + ".firebaseapp.com/__/auth/:path*" });
  assert.ok(vercel.rewrites.some((r) => r.source === "/api/:path*"), "the API rewrites are still there");
});

test("vercel.json: Firebase's own pages keep their own headers (our policy is not stamped on them); everything else gets ours", () => {
  const source = vercel.headers[0].source;
  const re = new RegExp("^" + source.replace(/\//g, "\\/") + "$");
  assert.equal(re.test("/__/auth/handler"), false);
  assert.equal(re.test("/__/auth/iframe"), false);
  assert.equal(re.test("/api/chat"), false);
  assert.equal(re.test("/index.html"), true);
  assert.equal(re.test("/auth.js"), true);
  assert.equal(re.test("/chat-search.js"), true);
});

test("vercel.json: the API function ships www/firebase-config.js (lib/csp.js reads the project id from it)", () => {
  assert.equal(vercel.functions["api/index.js"].includeFiles, "www/firebase-config.js");
  assert.doesNotMatch(read(".vercelignore"), /^www$/m);
});

// ---- www/auth.js ------------------------------------------------------------------------------------------------------------------

function build(options) {
  const o = options || {};
  const logs = { error: [], warn: [] };
  const calls = { popup: 0, redirect: 0, init: [] };
  const authInstance = {
    currentUser: null,
    onAuthStateChanged(cb) { cb(null); return () => {}; },
    signInWithPopup: async () => { calls.popup += 1; if (o.popupError) throw Object.assign(new Error("popup raw message"), { code: o.popupError }); return { user: { uid: "u1" } }; },
    signInWithRedirect: async () => { calls.redirect += 1; if (o.redirectError) throw Object.assign(new Error("redirect raw"), { code: o.redirectError }); },
    getRedirectResult: async () => { if (o.redirectResultError) throw Object.assign(new Error("result raw"), { code: o.redirectResultError }); return { user: o.redirectUser || null }; },
    signOut: async () => {}
  };
  const authFn = () => authInstance;
  authFn.GoogleAuthProvider = function GoogleAuthProvider() {};
  const firebase = { apps: [], initializeApp(config) { calls.init.push(config); firebase.apps.push({}); }, auth: authFn };
  const sandbox = {
    console: { error: (...a) => logs.error.push(a), warn: (...a) => logs.warn.push(a), log() {} },
    setTimeout, clearTimeout, firebase,
    LINGUAHUB_CONFIG: { FIREBASE: { apiKey: "k", authDomain: "linguahub-ai.firebaseapp.com", projectId: "linguahub-ai", appId: "a" } }
  };
  sandbox.window = sandbox;
  if (o.location) sandbox.location = o.location;
  if (o.standalone !== undefined) sandbox.matchMedia = (q) => ({ matches: q === "(display-mode: standalone)" && o.standalone });
  if (o.iosStandalone) sandbox.navigator = { standalone: true };
  if (o.desktop) sandbox.linguahubDesktop = { platform: "win32" };
  vm.createContext(sandbox);
  vm.runInContext(AUTH_SRC, sandbox, { filename: "auth.js" });
  return { auth: sandbox.LinguaHubAuth, calls, logs, sandbox };
}

const loc = (url) => { const u = new URL(url); return { protocol: u.protocol, hostname: u.hostname, host: u.host }; };

test("authDomain: on a real https web host it is the page's own host (proxied by Vercel)", () => {
  const t = build({ location: loc("https://linguahub-ai-tau.vercel.app/") });
  assert.equal(t.calls.init[0].authDomain, "linguahub-ai-tau.vercel.app");
  assert.equal(t.calls.init[0].projectId, "linguahub-ai", "the rest of the configuration is untouched");
  const custom = build({ location: loc("https://learn.example.com/") });
  assert.equal(custom.calls.init[0].authDomain, "learn.example.com");
});

test("authDomain: desktop (file://), localhost, 127.0.0.1, plain http and the Android webview keep <projectId>.firebaseapp.com", () => {
  for (const location of [{ protocol: "file:", hostname: "", host: "" }, loc("http://localhost:3000/"), loc("https://localhost/"), loc("http://127.0.0.1:5500/"), loc("https://127.0.0.1:8443/"), loc("http://linguahub-ai-tau.vercel.app/"), loc("http://[::1]:3000/"), loc("capacitor://localhost/")]) {
    const t = build({ location });
    assert.equal(t.calls.init[0].authDomain, "linguahub-ai.firebaseapp.com", JSON.stringify(location));
  }
  const none = build({});
  assert.equal(none.calls.init[0].authDomain, "linguahub-ai.firebaseapp.com", "no location at all");
  assert.equal(build({ location: loc("https://x.vercel.app/") }).sandbox.LINGUAHUB_CONFIG.FIREBASE.authDomain, "linguahub-ai.firebaseapp.com", "the shared config object itself is not modified");
});

test("authDomain: resolveAuthDomain is a pure helper", () => {
  const { auth } = build({});
  assert.equal(auth.resolveAuthDomain({ authDomain: "p.firebaseapp.com" }, loc("https://site.vercel.app:8443/")), "site.vercel.app:8443");
  assert.equal(auth.resolveAuthDomain({ authDomain: "p.firebaseapp.com" }, loc("http://localhost:3000/")), "p.firebaseapp.com");
  assert.equal(auth.resolveAuthDomain({ authDomain: "p.firebaseapp.com" }, undefined), "p.firebaseapp.com");
});

test("normal browsers sign in with the popup", async () => {
  const t = build({ standalone: false });
  const user = await t.auth.signInWithGoogle();
  assert.equal(user.uid, "u1");
  assert.deepEqual([t.calls.popup, t.calls.redirect], [1, 0]);
  const unknown = build({});
  await unknown.auth.signInWithGoogle();
  assert.equal(unknown.calls.popup, 1, "no matchMedia (an old webview) behaves like a browser");
});

test("an installed web app (display-mode: standalone, or an iOS home-screen app) signs in with a redirect, never a popup", async () => {
  for (const options of [{ standalone: true }, { iosStandalone: true }]) {
    const t = build(options);
    assert.equal(t.auth.isInstalledWebApp(), true);
    const result = await t.auth.signInWithGoogle();
    assert.equal(result, null, "the page is about to leave for Google");
    assert.deepEqual([t.calls.popup, t.calls.redirect], [0, 1]);
  }
});

test("the desktop app keeps the popup even if the window reports standalone", async () => {
  const t = build({ standalone: true, desktop: true });
  assert.equal(t.auth.isInstalledWebApp(), false);
  await t.auth.signInWithGoogle();
  assert.deepEqual([t.calls.popup, t.calls.redirect], [1, 0]);
});

test("a blocked popup, or a place that cannot do popups, falls back to the redirect", async () => {
  for (const code of ["auth/popup-blocked", "auth/operation-not-supported-in-this-environment"]) {
    const t = build({ popupError: code });
    const result = await t.auth.signInWithGoogle();
    assert.equal(result, null, code);
    assert.deepEqual([t.calls.popup, t.calls.redirect], [1, 1], code);
  }
});

test("a popup the person closed is a cancellation - no redirect behind their back, and a friendly message", async () => {
  for (const code of ["auth/popup-closed-by-user", "auth/cancelled-popup-request"]) {
    const t = build({ popupError: code });
    await assert.rejects(t.auth.signInWithGoogle(), (err) => err.code === code && /cancelled/.test(err.message));
    assert.equal(t.calls.redirect, 0, code);
  }
});

test("the REAL Firebase error code is logged to the console on every failure, while the person only sees the friendly message", async () => {
  const t = build({ popupError: "auth/unauthorized-domain" });
  await assert.rejects(t.auth.signInWithGoogle(), (err) => {
    assert.equal(err.code, "auth/unauthorized-domain");
    assert.match(err.message, /not authorized for Google sign-in/);
    assert.doesNotMatch(err.message, /popup raw message/, "the raw Firebase text never reaches the UI");
    return true;
  });
  assert.equal(t.logs.error.length, 1);
  assert.equal(t.logs.error[0][1], "auth/unauthorized-domain");
  assert.match(String(t.logs.error[0][0]), /Google sign-in failed/);

  const odd = build({ popupError: "auth/some-new-code" });
  await assert.rejects(odd.auth.signInWithGoogle(), (err) => err.message === "Sign-in failed. Please try again.");
  assert.equal(odd.logs.error[0][1], "auth/some-new-code");
  const none = build({ popupError: undefined });
  none.sandbox.firebase.auth().signInWithPopup = async () => { throw new Error("no code at all"); };
  await assert.rejects(none.auth.signInWithGoogle());
  assert.equal(none.logs.error[0][1], "unknown");
});

test("failures of the redirect itself are logged with their code too (installed app and the blocked-popup fallback)", async () => {
  const installed = build({ standalone: true, redirectError: "auth/network-request-failed" });
  await assert.rejects(installed.auth.signInWithGoogle(), (err) => err.code === "auth/network-request-failed" && /Network error/.test(err.message));
  assert.equal(installed.logs.error[0][1], "auth/network-request-failed");
  const fallback = build({ popupError: "auth/popup-blocked", redirectError: "auth/unauthorized-domain" });
  await assert.rejects(fallback.auth.signInWithGoogle(), (err) => err.code === "auth/unauthorized-domain");
  assert.ok(fallback.logs.error.some((e) => e[1] === "auth/unauthorized-domain"));
});

test("no token, e-mail or user data goes into the error log", async () => {
  const t = build({ popupError: "auth/internal-error" });
  await assert.rejects(t.auth.signInWithGoogle());
  const logged = JSON.stringify(t.logs.error);
  assert.doesNotMatch(logged, /apiKey|idToken|refreshToken|accessToken|Bearer/i);
});

test("on load the redirect result is picked up: a signed-in user is returned", async () => {
  const t = build({ redirectUser: { uid: "back-from-google" } });
  const user = await t.auth.completeRedirectSignIn();
  assert.equal(user.uid, "back-from-google");
  assert.equal(t.auth.getLastRedirectError(), null);
});

test("on load a failed redirect is logged with its code and remembered as a friendly message for the page to show", async () => {
  const t = build({ redirectResultError: "auth/unauthorized-domain" });
  const user = await t.auth.completeRedirectSignIn();
  assert.equal(user, null);
  assert.equal(t.logs.error[0][1], "auth/unauthorized-domain");
  const failure = t.auth.getLastRedirectError();
  assert.equal(failure.code, "auth/unauthorized-domain");
  assert.match(failure.message, /not authorized for Google sign-in/);
  const fine = build({});
  await fine.auth.completeRedirectSignIn();
  assert.equal(fine.auth.getLastRedirectError(), null, "a normal load has no error");
});

test("app.js calls getRedirectResult on load and shows a failed redirect's friendly message", () => {
  const app = read("www", "app.js");
  assert.match(app, /Promise\.resolve\(LinguaHubAuth\.completeRedirectSignIn\(\)\)\.then\(\(redirectedUser\) => \{[\s\S]*?getLastRedirectError[\s\S]*?setAuthStatus\(failure\.message\);/);
  assert.doesNotMatch(app, /localStorage\./, "app.js never touches storage directly");
});

test("there is no service worker or web manifest in this project, so there is no PWA cache to bump (static files are served revalidated)", () => {
  const files = fs.readdirSync(path.join(root, "www"));
  assert.ok(!files.some((f) => /^sw\.js$|service-worker|\.webmanifest$|^manifest\.json$/i.test(f)));
  assert.doesNotMatch(read("www", "index.html"), /rel="manifest"|serviceWorker/);
  assert.match(read("server.js"), /max-age=300, must-revalidate/);
});
