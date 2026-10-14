"use strict";

// Phase 5, step 0: speech input where the Web Speech API is missing (Electron):
// MediaRecorder -> POST /api/transcribe -> SpeechRecognition-style events.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SI = require("../www/speech-input.js");
const { isPermissionAllowed } = require("../lib/electronSecurity.js");

function fakeClock() {
  let time = 0;
  let nextId = 1;
  const timeouts = new Map();
  const intervals = new Map();
  return {
    now: () => time,
    setTimeout(fn, ms) { const id = nextId++; timeouts.set(id, { fn, at: time + ms }); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    setInterval(fn, ms) { const id = nextId++; intervals.set(id, { fn, ms, next: time + ms }); return id; },
    clearInterval(id) { intervals.delete(id); },
    advance(ms) {
      const end = time + ms;
      for (;;) {
        let best = null;
        timeouts.forEach((t, id) => { if (t.at <= end && (!best || t.at < best.at)) best = { at: t.at, run: () => { timeouts.delete(id); t.fn(); } }; });
        intervals.forEach((t) => { if (t.next <= end && (!best || t.next < best.at)) best = { at: t.next, run: () => { t.next += t.ms; t.fn(); } }; });
        if (!best) break;
        time = best.at;
        best.run();
      }
      time = end;
    }
  };
}

function setup({ denied, noMic, audioContext = true, response, fetchError } = {}) {
  const clock = fakeClock();
  const level = { value: 0 };
  const log = { tracksStopped: 0, recorders: [], fetches: [], events: [] };
  class FakeRecorder {
    static isTypeSupported(type) { return type === "audio/webm;codecs=opus"; }
    constructor(stream, options) { this.stream = stream; this.options = options; this.state = "inactive"; this.mimeType = options && options.mimeType; log.recorders.push(this); }
    start() { this.state = "recording"; }
    stop() {
      this.state = "inactive";
      this.ondataavailable({ data: { size: 5000 } });
      if (this.onstop) this.onstop();
    }
  }
  const stream = { getTracks: () => [{ stop: () => { log.tracksStopped += 1; } }] };
  const mediaDevices = noMic ? undefined : {
    getUserMedia: () => (denied ? Promise.reject(Object.assign(new Error("x"), { name: denied })) : Promise.resolve(stream))
  };
  class FakeAudioContext {
    createMediaStreamSource() { return { connect() {} }; }
    createAnalyser() { return { fftSize: 1024, getFloatTimeDomainData(buf) { buf.fill(level.value); } }; }
    close() { log.audioClosed = true; }
  }
  const Recognition = SI.createCloudRecognition({
    mediaDevices,
    MediaRecorder: FakeRecorder,
    AudioContext: audioContext ? FakeAudioContext : null,
    fetch: async (url, init) => {
      log.fetches.push({ url, init });
      if (fetchError) throw new Error("offline");
      return response || { ok: true, status: 200, json: async () => ({ text: "hello there" }) };
    },
    apiUrl: (p) => "http://api.test" + p,
    getAuthHeaders: async () => ({ Authorization: "Bearer tok" }),
    Blob: class { constructor(parts, opts) { this.parts = parts; this.type = opts.type; } },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, setInterval: clock.setInterval, clearInterval: clock.clearInterval, now: clock.now
  });
  const rec = new Recognition();
  rec.onstart = () => log.events.push(["start"]);
  rec.onspeechstart = () => log.events.push(["speechstart"]);
  rec.onresult = (e) => log.events.push(["result", e.results[0][0].transcript, e.results[0].isFinal, e.resultIndex]);
  rec.onerror = (e) => log.events.push(["error", e.error]);
  rec.onend = () => log.events.push(["end"]);
  const flush = async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r)); };
  return { rec, clock, log, level, flush };
}

test("getRecognition: native Web Speech in a browser, the recorder in Electron, the recorder when there is no Web Speech, null when neither", () => {
  const native = function Native() {};
  const cloud = function Cloud() {};
  assert.equal(SI.getRecognition({ webkitSpeechRecognition: native }, cloud), native, "browser: free, no upload");
  assert.equal(SI.getRecognition({ SpeechRecognition: native, linguahubDesktop: {} }, cloud), cloud, "Electron: the Web Speech API does not work there");
  assert.equal(SI.getRecognition({}, cloud), cloud);
  assert.equal(SI.getRecognition({}, null), null);
  assert.equal(SI.getRecognition({ linguahubDesktop: {} }, null), null);
});

test("helpers: server language mapping and recording format choice", () => {
  assert.equal(SI.serverLanguage("uz-UZ"), "uz");
  assert.equal(SI.serverLanguage("ar-SA"), "ar");
  assert.equal(SI.serverLanguage("fr-FR"), "", "unknown languages are auto-detected");
  assert.equal(SI.serverLanguage(undefined), "");
  assert.equal(SI.pickMimeType({ isTypeSupported: (t) => t === "audio/mp4" }), "audio/mp4");
  assert.equal(SI.pickMimeType({ isTypeSupported: () => false }), "");
  assert.equal(SI.pickMimeType(null), "");
});

test("recording: speech then a pause ends the clip by itself and the text arrives as a final result", async () => {
  const t = setup();
  t.rec.lang = "uz-UZ";
  t.rec.start();
  await t.flush();
  assert.deepEqual(t.log.events[0], ["start"]);
  assert.equal(t.log.recorders[0].options.mimeType, "audio/webm;codecs=opus");

  t.level.value = 0.3; // talking
  t.clock.advance(500);
  assert.deepEqual(t.log.events[1], ["speechstart"]);
  t.level.value = 0; // pause
  t.clock.advance(1000);
  assert.equal(t.log.fetches.length, 0, "a short pause does not end the sentence");
  t.clock.advance(600);
  await t.flush();

  assert.equal(t.log.fetches.length, 1);
  const { url, init } = t.log.fetches[0];
  assert.equal(url, "http://api.test/api/transcribe?lang=uz");
  assert.equal(init.method, "POST");
  assert.equal(init.headers["Content-Type"], "audio/webm;codecs=opus");
  assert.equal(init.headers.Authorization, "Bearer tok");
  assert.deepEqual(t.log.events.slice(2), [["result", "hello there", true, 0], ["end"]]);
  assert.ok(t.log.tracksStopped >= 1, "the microphone is released");
  assert.equal(t.log.audioClosed, true);
});

test("recording: stop() sends what was said so far", async () => {
  const t = setup();
  t.rec.start();
  await t.flush();
  t.level.value = 0.3;
  t.clock.advance(1000);
  t.rec.stop();
  await t.flush();
  assert.equal(t.log.fetches.length, 1);
  assert.equal(t.log.events.filter((e) => e[0] === "result").length, 1);
  assert.equal(t.log.events.filter((e) => e[0] === "end").length, 1);
});

test("recording: the clip is capped at 60 seconds even if the person keeps talking", async () => {
  const t = setup();
  t.rec.start();
  await t.flush();
  t.level.value = 0.3;
  t.clock.advance(SI.LIMITS.MAX_RECORDING_MS + 100);
  await t.flush();
  assert.equal(t.log.recorders[0].state, "inactive");
  assert.equal(t.log.fetches.length, 1);
});

test("recording: silence from the start ends with 'no-speech' and uploads nothing", async () => {
  const t = setup();
  t.rec.start();
  await t.flush();
  t.clock.advance(SI.LIMITS.NO_SPEECH_MS + 200);
  await t.flush();
  assert.equal(t.log.fetches.length, 0);
  assert.deepEqual(t.log.events.slice(1), [["error", "no-speech"], ["end"]]);
  assert.ok(t.log.tracksStopped >= 1);
});

test("recording: a tap that is too short sends nothing", async () => {
  const t = setup();
  t.rec.start();
  await t.flush();
  t.level.value = 0.3;
  t.clock.advance(150);
  t.rec.stop();
  await t.flush();
  assert.equal(t.log.fetches.length, 0);
  assert.deepEqual(t.log.events.slice(-2), [["error", "no-speech"], ["end"]]);
});

test("recording: without level metering (no AudioContext) the clip ends on stop() and is uploaded", async () => {
  const t = setup({ audioContext: false });
  t.rec.start();
  await t.flush();
  t.clock.advance(2000);
  t.rec.stop();
  await t.flush();
  assert.equal(t.log.fetches.length, 1);
});

test("permission and device problems become the standard error codes, then end", async () => {
  for (const [name, code] of [["NotAllowedError", "not-allowed"], ["SecurityError", "not-allowed"], ["NotFoundError", "audio-capture"], ["NotReadableError", "audio-capture"]]) {
    const t = setup({ denied: name });
    t.rec.start();
    await t.flush();
    assert.deepEqual(t.log.events, [["error", code], ["end"]], name);
    assert.equal(t.log.recorders.length, 0);
  }
  const none = setup({ noMic: true });
  none.rec.start();
  await none.flush();
  assert.deepEqual(none.log.events, [["error", "audio-capture"], ["end"]]);
});

test("server problems: 429 -> service-busy, other HTTP errors and offline -> network, empty text -> no-speech", async () => {
  const cases = [
    [{ response: { ok: false, status: 429, json: async () => ({}) } }, "service-busy"],
    [{ response: { ok: false, status: 502, json: async () => ({}) } }, "network"],
    [{ fetchError: true }, "network"],
    [{ response: { ok: true, status: 200, json: async () => ({ text: "   " }) } }, "no-speech"],
    [{ response: { ok: true, status: 200, json: async () => { throw new Error("bad json"); } } }, "network"]
  ];
  for (const [options, code] of cases) {
    const t = setup(options);
    t.rec.start();
    await t.flush();
    t.level.value = 0.3;
    t.clock.advance(1000);
    t.rec.stop();
    await t.flush();
    assert.deepEqual(t.log.events.slice(-2), [["error", code], ["end"]], code);
    assert.ok(t.log.tracksStopped >= 1);
  }
});

test("abort: while the permission prompt is open the microphone is released as soon as it opens, and nothing is sent", async () => {
  const clock = fakeClock();
  let granted;
  const log = { stopped: 0, events: [], fetches: 0 };
  const Recognition = SI.createCloudRecognition({
    mediaDevices: { getUserMedia: () => new Promise((resolve) => { granted = () => resolve({ getTracks: () => [{ stop: () => { log.stopped += 1; } }] }); }) },
    MediaRecorder: class { static isTypeSupported() { return true; } },
    fetch: async () => { log.fetches += 1; return { ok: true, json: async () => ({ text: "x" }) }; },
    apiUrl: (p) => p, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, setInterval: clock.setInterval, clearInterval: clock.clearInterval, now: clock.now
  });
  const rec = new Recognition();
  rec.onstart = () => log.events.push("start");
  rec.onend = () => log.events.push("end");
  rec.start();
  rec.abort();
  granted();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(log.events, ["end"]);
  assert.equal(log.stopped, 1);
  assert.equal(log.fetches, 0);
});

test("abort: while recording ends once, releases the microphone and never uploads", async () => {
  const t = setup();
  t.rec.start();
  await t.flush();
  t.level.value = 0.3;
  t.clock.advance(1000);
  t.rec.abort();
  t.clock.advance(5000);
  await t.flush();
  assert.equal(t.log.fetches.length, 0);
  assert.equal(t.log.events.filter((e) => e[0] === "end").length, 1);
  assert.equal(t.log.events.filter((e) => e[0] === "result").length, 0);
  assert.ok(t.log.tracksStopped >= 1);
  t.rec.abort(); // harmless twice
  assert.equal(t.log.events.filter((e) => e[0] === "end").length, 1);
});

test("start() twice is refused; a throwing listener does not break the recorder", async () => {
  const t = setup();
  t.rec.onresult = () => { throw new Error("listener bug"); };
  t.rec.start();
  assert.throws(() => t.rec.start());
  await t.flush();
  t.level.value = 0.3;
  t.clock.advance(1000);
  t.rec.stop();
  await t.flush();
  assert.equal(t.log.events.filter((e) => e[0] === "end").length, 1);
});

// ---- Electron permissions -----------------------------------------------------------------------------------------

const INDEX = "file:///C:/app/www/index.html";

test("permissions: only the app's own page may use the microphone (audio only) and write to the clipboard", () => {
  const ok = (permission, mediaTypes, url) => isPermissionAllowed({ permission, mediaTypes, url: url === undefined ? INDEX : url, indexFileUrl: INDEX });
  assert.equal(ok("media", ["audio"]), true);
  assert.equal(ok("media", ["audio"], INDEX + "#x"), true);
  assert.equal(ok("clipboard-sanitized-write"), true);
  assert.equal(ok("media", ["audio", "video"]), false, "never the camera");
  assert.equal(ok("media", ["video"]), false);
  assert.equal(ok("media", []), false);
  assert.equal(ok("media", undefined), false);
  assert.equal(ok("media", ["audio"], "https://evil.example/"), false, "other pages are denied");
  assert.equal(ok("media", ["audio"], "https://accounts.google.com/"), false, "even the sign-in popup");
  assert.equal(ok("media", ["audio"], ""), false);
  for (const permission of ["geolocation", "notifications", "midi", "midiSysex", "clipboard-read", "openExternal", "display-capture", "fullscreen", "pointerLock"]) {
    assert.equal(ok(permission, ["audio"]), false, permission);
  }
});

test("main.js installs the permission handlers before creating the window, with no blanket allow", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  assert.match(src, /setPermissionRequestHandler/);
  assert.match(src, /setPermissionCheckHandler/);
  assert.ok(src.indexOf("installPermissionHandlers();") < src.indexOf("createWindow();", src.indexOf("app.whenReady()")));
  assert.match(src, /isPermissionAllowed\(\{/);
  assert.doesNotMatch(src, /callback\(true\)/);
});

test("wiring: voice.js and the Speak screen ask speech-input.js for their recognizer; scripts load in order", () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, "..", "www", f), "utf8");
  assert.match(read("voice.js"), /window\.LinguaHubSpeechInput \? window\.LinguaHubSpeechInput\.get\(\)/);
  assert.match(read("ws-speak.js"), /window\.LinguaHubSpeechInput \? window\.LinguaHubSpeechInput\.get\(\)/);
  const html = read("index.html");
  const at = (n) => html.indexOf('<script src="' + n + '"></script>');
  assert.ok(at("config.js") > -1 && at("config.js") < at("speech-input.js"));
  assert.ok(at("speech-input.js") < at("voice.js"));
  assert.equal(at("ws-speak.js"), -1, "the Speak screen loads on first use (workspace.js), after speech-input.js is already there");
});
