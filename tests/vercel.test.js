"use strict";

// Phase 5, step 6: Vercel readiness - static www/, one serverless function for
// the Express app, streaming and transcription working, no local disk writes,
// desktop-only code skipped in a browser, every environment variable documented.

const { test } = require("node:test");
const assert = require("node:assert/strict");
// Since Phase 6A every AI route needs a verified sign-in (lib/aiGate.js). This file is about
// other things, so it runs as a signed-in premium user: see tests/helpers/aiAuth.js.
require("./helpers/aiAuth.js").installLegacy();
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const OpenAI = require("openai");
const { cspHeaderValue, cspDirectives } = require("../lib/csp.js");
const { validateEnv } = require("../lib/env.js");

const root = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");
const vercel = JSON.parse(read("vercel.json"));

// ---- the Vercel project ---------------------------------------------------------------------------------------------

test("vercel.json: static files from www/, no build step, production dependencies only (Electron and test tooling are never installed)", () => {
  assert.equal(vercel.outputDirectory, "www");
  assert.equal(vercel.buildCommand, null);
  assert.equal(vercel.framework, null);
  assert.equal(vercel.installCommand, "npm ci --omit=dev");
  assert.ok(fs.existsSync(path.join(root, "www", "index.html")));
});

test("vercel.json: the API runs as one function, with a duration limit the app's own generation cap stays under", () => {
  const fn = vercel.functions["api/index.js"];
  assert.ok(fn && fn.maxDuration >= 30);
  assert.ok(fs.existsSync(path.join(root, "api", "index.js")));
  assert.deepEqual(fs.readdirSync(path.join(root, "api")), ["index.js"], "every file in api/ becomes a function: only one");
  assert.ok(validateEnv({ VERCEL: "1" }).maxGenerationMs < fn.maxDuration * 1000, "the cap leaves a margin below maxDuration");
});

test("vercel.json: every route the Express app defines is rewritten to the function", () => {
  const server = read("server.js");
  const routes = [];
  server.replace(/app\.(?:get|post)\(\s*"([^"]+)"/g, (m, p) => { routes.push(p); return m; });
  assert.ok(routes.includes("/api/chat/stream") && routes.includes("/api/transcribe") && routes.includes("/health") && routes.includes("/chat"));
  const sources = vercel.rewrites.map((r) => r.source);
  routes.forEach((route) => {
    const covered = sources.some((s) => s === route || (s === "/api/:path*" && route.startsWith("/api/")));
    assert.ok(covered, route + " is rewritten to the function");
  });
  // the one other rewrite forwards Firebase's sign-in pages (/__/auth/*) to firebaseapp.com (see tests/auth-csp.test.js)
  vercel.rewrites.filter((r) => !r.source.startsWith("/__/auth/")).forEach((r) => assert.equal(r.destination, "/api"));
  assert.equal(sources.includes("/(.*)"), false, "no catch-all: static files stay static");
});

test("api/index.js is the very same Express app that `node server.js` runs, and loading it starts no server", () => {
  const fromApi = require("../api/index.js");
  const fromServer = require("../server.js");
  assert.equal(fromApi, fromServer);
  assert.equal(typeof fromApi, "function", "an (req, res) handler, which is what Vercel calls");
  assert.match(read("server.js"), /if \(require\.main === module\) \{/, "listen() only when run directly");
});

test("vercel.json: static files carry the same security headers the Express app sends (CSP, COOP, nosniff...)", () => {
  const block = vercel.headers[0];
  assert.equal(new RegExp("^" + block.source.replace(/\//g, "\\/") + "$").test("/index.html"), true);
  assert.equal(new RegExp("^" + block.source.replace(/\//g, "\\/") + "$").test("/chat-search.js"), true, "assets whose name starts with 'chat' are not mistaken for the API");
  assert.equal(new RegExp("^" + block.source.replace(/\//g, "\\/") + "$").test("/api/chat"), false, "API responses get their headers from helmet instead");
  const headers = Object.fromEntries(block.headers.map((h) => [h.key, h.value]));
  assert.equal(headers["Content-Security-Policy"], cspHeaderValue());
  assert.equal(headers["Cross-Origin-Opener-Policy"], "same-origin-allow-popups");
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.equal(headers["Referrer-Policy"], "no-referrer");
  assert.match(headers["Permissions-Policy"], /microphone=\(self\)/);
  assert.match(headers["Permissions-Policy"], /camera=\(\)/);
  assert.match(headers["Strict-Transport-Security"], /max-age=\d+/);
});

test("the CSP is defined once: the Express app (helmet) sends exactly the policy vercel.json sends", async () => {
  await withServer(async (base) => {
    const response = await fetch(base + "/health");
    const sent = response.headers.get("content-security-policy").split(";").map((d) => d.trim()).filter(Boolean);
    const expected = cspHeaderValue().split(";").map((d) => d.trim()).filter(Boolean);
    assert.deepEqual(sent, expected);
    assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin-allow-popups");
  });
  assert.match(read("server.js"), /directives: cspDirectives/);
  assert.ok(cspDirectives.scriptSrc.includes("https://www.gstatic.com"));
  assert.ok(!JSON.stringify(cspDirectives).includes("unsafe-inline"), "no inline script or style allowed");
});

test(".vercelignore keeps the desktop shell, tests, tooling and any secrets out of the deployment", () => {
  const ignore = read(".vercelignore").split(/\r?\n/).filter((l) => l && !l.startsWith("#"));
  [".env", "node_modules", "android", "dist", "e2e", "tests", "main.js", "preload.js", "*serviceAccount*.json"].forEach((entry) => assert.ok(ignore.includes(entry), entry));
  assert.ok(!ignore.includes("www") && !ignore.includes("lib") && !ignore.includes("api") && !ignore.includes("middleware") && !ignore.includes("server.js"), "everything the web version needs is kept");
  assert.equal(JSON.parse(read("package.json")).engines.node, ">=22");
});

// ---- the app behaves on a serverless platform --------------------------------------------------------------------------

async function withServer(fn, env) {
  const saved = {};
  Object.keys(env || {}).forEach((k) => { saved[k] = process.env[k]; process.env[k] = env[k]; });
  delete require.cache[require.resolve("../server.js")];
  const app = require("../server.js");
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try { await fn("http://127.0.0.1:" + server.address().port); }
  finally {
    await new Promise((r) => { server.close(r); server.closeAllConnections && server.closeAllConnections(); });
    Object.keys(saved).forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
    delete require.cache[require.resolve("../server.js")];
  }
}

function patchProvider(handlers) {
  const originals = {
    chat: OpenAI.Chat.Completions.prototype.create,
    transcribe: OpenAI.Audio.Transcriptions.prototype.create
  };
  if (handlers.chat) OpenAI.Chat.Completions.prototype.create = handlers.chat;
  if (handlers.transcribe) OpenAI.Audio.Transcriptions.prototype.create = handlers.transcribe;
  return () => { OpenAI.Chat.Completions.prototype.create = originals.chat; OpenAI.Audio.Transcriptions.prototype.create = originals.transcribe; };
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const chatBody = (mode) => JSON.stringify({ mode: mode || "general", messages: [{ role: "user", content: "hello" }] });

test("streaming chat: chunks reach the client as the provider produces them (nothing in the app buffers the reply)", async () => {
  let providerFinished = false;
  const restore = patchProvider({
    chat: async (body) => {
      assert.equal(body.stream, true);
      return (async function* () {
        yield { model: "m", choices: [{ delta: { content: "Hel" } }], usage: null };
        await delay(400);
        yield { model: "m", choices: [{ delta: { content: "lo" } }], usage: null };
        providerFinished = true;
        yield { model: "m", choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } };
      })();
    }
  });
  try {
    await withServer(async (base) => {
      const response = await fetch(base + "/api/chat/stream", { method: "POST", headers: { "Content-Type": "application/json" }, body: chatBody() });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /text\/event-stream/);
      assert.equal(response.headers.get("cache-control"), "no-cache");
      assert.equal(response.headers.get("x-accel-buffering"), "no");
      const reader = response.body.getReader();
      const first = await reader.read();
      assert.match(new TextDecoder().decode(first.value), /"delta":"Hel"/);
      assert.equal(providerFinished, false, "the first chunk arrived while the provider was still generating");
      let rest = "";
      for (;;) { const { done, value } = await reader.read(); if (done) break; rest += new TextDecoder().decode(value); }
      assert.match(rest, /"delta":"lo"/);
      assert.match(rest, /"type":"done"/);
      assert.match(rest, /\[DONE\]/);
    });
  } finally { restore(); }
});

test("generation cap: a reply that outlasts MAX_GENERATION_MS ends with the app's own message, not a dropped connection", async () => {
  const restore = patchProvider({
    chat: async (body, options) => (async function* () {
      yield { model: "m", choices: [{ delta: { content: "slow" } }], usage: null };
      await new Promise((resolve, reject) => { options.signal.addEventListener("abort", () => reject(new Error("aborted"))); });
    })()
  });
  try {
    await withServer(async (base) => {
      const started = Date.now();
      const response = await fetch(base + "/api/chat/stream", { method: "POST", headers: { "Content-Type": "application/json" }, body: chatBody() });
      const text = await response.text();
      assert.match(text, /The request took too long and was stopped/);
      assert.ok(Date.now() - started < 5000, "stopped by the 300 ms cap, not the mode's 60 s budget");
    }, { MAX_GENERATION_MS: "300" });
  } finally { restore(); }
});

test("non-streaming chat also uses the cap and returns JSON", async () => {
  const seen = [];
  const restore = patchProvider({ chat: async (body, options) => { seen.push(options.timeout); return { model: "m", choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }; } });
  try {
    await withServer(async (base) => {
      const response = await fetch(base + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: chatBody() });
      assert.equal((await response.json()).reply, "hi");
      assert.equal(seen[0], 300);
    }, { MAX_GENERATION_MS: "300" });
  } finally { restore(); }
});

test("transcription route end to end: a recording goes in, text comes out, nothing is written to disk", async () => {
  const seen = [];
  const restore = patchProvider({ transcribe: async (params) => { seen.push({ name: params.file.name, language: params.language, model: params.model }); return { text: " hello world " }; } });
  const writes = [];
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = function (...args) { writes.push(String(args[0])); return realWrite.apply(this, args); };
  try {
    await withServer(async (base) => {
      const response = await fetch(base + "/api/transcribe?lang=uz", { method: "POST", headers: { "Content-Type": "audio/webm;codecs=opus" }, body: Buffer.alloc(5000, 7) });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { text: "hello world" });
    });
    assert.deepEqual(seen, [{ name: "speech.webm", language: "uz", model: "whisper-1" }]);
    assert.deepEqual(writes, [], "no file was written");
  } finally { fs.writeFileSync = realWrite; restore(); }
});

test("behind Vercel's proxy the real client address is used (TRUST_PROXY defaults to 1); an explicit value still wins", () => {
  assert.equal(validateEnv({ VERCEL: "1" }).trustProxy, 1);
  assert.equal(validateEnv({}).trustProxy, 0, "elsewhere nothing is trusted unless configured");
  assert.equal(validateEnv({ VERCEL: "1", TRUST_PROXY: "2" }).trustProxy, 2);
  assert.equal(validateEnv({ VERCEL: "1", TRUST_PROXY: "0" }).trustProxy, 0);
  assert.equal(validateEnv({ VERCEL: "1", TRUST_PROXY: "nonsense" }).ok, false);
});

test("MAX_GENERATION_MS: 55 s on Vercel, none elsewhere, configurable, validated", () => {
  assert.equal(validateEnv({ VERCEL: "1" }).maxGenerationMs, 55000);
  assert.equal(validateEnv({}).maxGenerationMs, 0);
  assert.equal(validateEnv({ VERCEL: "1", MAX_GENERATION_MS: "120000" }).maxGenerationMs, 120000);
  const bad = validateEnv({ MAX_GENERATION_MS: "-5" });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(" "), /MAX_GENERATION_MS/);
});

test("the server code never writes to the local disk (Vercel's file system is read-only)", () => {
  const files = ["server.js"].concat(fs.readdirSync(path.join(root, "lib")).filter((f) => !["themePref.js", "electronSecurity.js", "updater.js"].includes(f)).map((f) => "lib/" + f), fs.readdirSync(path.join(root, "middleware")).map((f) => "middleware/" + f));
  files.forEach((f) => assert.doesNotMatch(read(f), /writeFile|appendFile|createWriteStream|mkdirSync|\.mkdir\(|unlinkSync|rmSync|mkdtemp/, f));
  assert.doesNotMatch(read("server.js"), /themePref|require\("fs"\)/, "the desktop-only theme file code is not part of the server");
});

// ---- desktop-only code in a browser ---------------------------------------------------------------------------------------

function runTitlebar(desktop) {
  const attrs = {};
  const doc = {
    readyState: "complete",
    documentElement: { setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; } },
    getElementById: () => null,
    addEventListener() {}
  };
  const sandbox = { window: {}, document: doc };
  if (desktop) sandbox.window.linguahubDesktop = { platform: "win32", isMaximized: () => Promise.resolve(false), onMaximizeChange() {}, minimize() {}, toggleMaximize() {}, close() {} };
  sandbox.window.document = doc;
  vm.createContext(sandbox);
  vm.runInContext(read("www", "titlebar.js"), sandbox);
  return attrs;
}

test("in a browser the title bar script does nothing (no error, no desktop marker); in Electron it marks the page", () => {
  assert.deepEqual(runTitlebar(false), {});
  assert.equal(runTitlebar(true)["data-desktop"], "win32");
});

test("every use of the desktop bridge in the page code is guarded, so a plain browser never touches it", () => {
  const uses = [];
  fs.readdirSync(path.join(root, "www")).filter((f) => f.endsWith(".js")).forEach((f) => {
    read("www", f).split(/\r?\n/).forEach((line, i) => { if (/linguahubDesktop/.test(line) && !/^\s*(\/\/|\*)/.test(line)) uses.push({ f, i: i + 1, line: line.trim() }); });
  });
  assert.ok(uses.length >= 3);
  uses.forEach(({ f, line }) => {
    const guarded = /if \(!api\) return/.test(line) || /window\.linguahubDesktop && /.test(line) || /Boolean\(win && win\.linguahubDesktop\)/.test(line) || /var api = window\.linguahubDesktop;/.test(line) || /if \(window\.linguahubDesktop\) return false;/.test(line) || /window\.linguahubDesktop\.setTheme\(mode\);/.test(line);
    assert.ok(guarded, f + ": " + line);
  });
  const titlebar = read("www", "titlebar.js");
  assert.ok(titlebar.indexOf("if (!api) return;") < titlebar.indexOf("api.minimize"), "titlebar.js returns before using the bridge");
  assert.match(read("www", "theme.js"), /if \(window\.linguahubDesktop && typeof window\.linguahubDesktop\.setTheme === "function"\)/);
});

test("the auto-updater and window controls live only in Electron's main process, never in code the web deployment runs", () => {
  const code = (source) => source.split(/\r?\n/).filter((line) => !/^\s*\/\//.test(line)).join("\n");
  assert.doesNotMatch(code(read("server.js")), /electron/i, "no Electron code in the server (comments aside)");
  assert.doesNotMatch(code(read("api", "index.js")), /electron/i);
  assert.ok(read(".vercelignore").includes("main.js"));
});

// ---- documentation ----------------------------------------------------------------------------------------------------------

test("README: the Deploy to Vercel section lists every environment variable the server reads (names only)", () => {
  const readme = read("README.md");
  const section = readme.slice(readme.indexOf("## Deploy to Vercel"), readme.indexOf("## Running tests"));
  assert.ok(section.length > 500);
  const names = new Set();
  const scan = ["server.js"].concat(fs.readdirSync(path.join(root, "lib")).filter((f) => !["themePref.js", "electronSecurity.js", "updater.js"].includes(f)).map((f) => "lib/" + f), fs.readdirSync(path.join(root, "middleware")).map((f) => "middleware/" + f));
  scan.forEach((f) => read(f).replace(/(?:process\.env|\benv)\.([A-Z][A-Z0-9_]{2,})/g, (m, n) => { names.add(n); return m; }));
  names.delete("VERCEL"); // set by the platform itself
  assert.ok(names.size >= 20, "found " + names.size + " variables");
  names.forEach((name) => assert.ok(section.includes("`" + name + "`"), name + " is documented"));
  assert.match(section, /Required\*\*/);
});

test("README: no values anywhere in the Vercel section - no keys, no assignments", () => {
  const readme = read("README.md");
  const section = readme.slice(readme.indexOf("## Deploy to Vercel"), readme.indexOf("## Running tests"));
  assert.doesNotMatch(section, /sk-[A-Za-z0-9]/);
  assert.doesNotMatch(section, /BEGIN [A-Z ]*PRIVATE KEY/);
  assert.doesNotMatch(section, /`[A-Z][A-Z0-9_]{3,}=\S+`/, "no NAME=value assignments");
  assert.match(section, /Authorized domains/);
});
