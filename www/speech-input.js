// LinguaHub AI - speech input that works everywhere.
//
// The Web Speech API's recognition does not work in Electron (and is missing
// in some browsers). getRecognition() therefore returns:
//   - the browser's own SpeechRecognition, when it exists and we are NOT in
//     Electron (it is free and needs no upload), otherwise
//   - CloudRecognition: records with MediaRecorder, stops by itself after a
//     pause (or a time limit), uploads the clip to POST /api/transcribe and
//     reports the text through the same events SpeechRecognition uses
//     (onstart / onresult / onerror / onend / onspeechstart), so callers
//     (voice.js, ws-speak.js) treat both alike.
// null when neither is possible (no microphone API at all).

(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") root.LinguaHubSpeechInput = api.install(root);
})(typeof window !== "undefined" ? window : this, function () {
  "use strict";

  var MAX_RECORDING_MS = 60000;      // hard stop (also keeps the upload far below the server limit)
  var NO_SPEECH_MS = 8000;           // nobody started talking
  var SILENCE_AFTER_SPEECH_MS = 1400; // pause that ends a sentence
  var MIN_RECORDING_MS = 400;
  var LEVEL_POLL_MS = 100;
  var SPEECH_LEVEL = 0.02;           // RMS above this counts as speech
  var MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  var SERVER_LANGS = ["en", "uz", "ar", "ru", "tr"];

  function pickMimeType(MediaRecorderClass) {
    if (!MediaRecorderClass || typeof MediaRecorderClass.isTypeSupported !== "function") return "";
    for (var i = 0; i < MIME_CANDIDATES.length; i += 1) {
      if (MediaRecorderClass.isTypeSupported(MIME_CANDIDATES[i])) return MIME_CANDIDATES[i];
    }
    return "";
  }

  // "uz-UZ" -> "uz"; anything the server does not know -> "" (auto-detect)
  function serverLanguage(tag) {
    var code = String(tag || "").slice(0, 2).toLowerCase();
    return SERVER_LANGS.indexOf(code) === -1 ? "" : code;
  }

  function errorCodeForGetUserMedia(err) {
    var name = err && err.name;
    if (name === "NotAllowedError" || name === "SecurityError") return "not-allowed";
    if (name === "NotFoundError" || name === "OverconstrainedError" || name === "NotReadableError") return "audio-capture";
    return "audio-capture";
  }

  // deps: { mediaDevices, MediaRecorder, AudioContext, fetch, apiUrl(path), getAuthHeaders() -> Promise<{}>,
  //         setTimeout, clearTimeout, setInterval, clearInterval, now() }
  function createCloudRecognition(deps) {
    var timers = {
      setTimeout: deps.setTimeout || setTimeout,
      clearTimeout: deps.clearTimeout || clearTimeout,
      setInterval: deps.setInterval || setInterval,
      clearInterval: deps.clearInterval || clearInterval
    };
    var now = deps.now || function () { return Date.now(); };

    function CloudRecognition() {
      this.lang = "en-US";
      this.continuous = false;
      this.interimResults = false;
      this.maxAlternatives = 1;
      this.onstart = null;
      this.onresult = null;
      this.onerror = null;
      this.onend = null;
      this.onspeechstart = null;
      this.onsoundstart = null;
      this._state = "idle"; // idle | starting | recording | sending | done
    }

    CloudRecognition.prototype._emit = function (name, event) {
      var handler = this["on" + name];
      if (typeof handler === "function") {
        try { handler.call(this, event || {}); } catch (err) { /* a listener must not break the recorder */ }
      }
    };

    CloudRecognition.prototype._cleanup = function () {
      var self = this;
      ["_maxTimer", "_noSpeechTimer"].forEach(function (k) { if (self[k]) { timers.clearTimeout(self[k]); self[k] = null; } });
      if (this._levelTimer) { timers.clearInterval(this._levelTimer); this._levelTimer = null; }
      if (this._stream) {
        try { this._stream.getTracks().forEach(function (t) { t.stop(); }); } catch (err) { /* already stopped */ }
        this._stream = null;
      }
      if (this._audioContext) {
        try { this._audioContext.close(); } catch (err) { /* ignore */ }
        this._audioContext = null;
      }
    };

    CloudRecognition.prototype._finish = function (errorCode) {
      if (this._state === "done") return;
      this._state = "done";
      this._cleanup();
      if (errorCode) this._emit("error", { error: errorCode });
      this._emit("end");
    };

    CloudRecognition.prototype.start = function () {
      var self = this;
      if (this._state !== "idle") throw new Error("already started");
      // recording is only for signed-in people (the server insists): ask nicely before the microphone opens
      if (deps.canStart && !deps.canStart()) {
        this._state = "starting";
        Promise.resolve().then(function () { self._finish("sign-in-required"); });
        return;
      }
      if (!deps.mediaDevices || typeof deps.mediaDevices.getUserMedia !== "function" || !deps.MediaRecorder) {
        this._state = "starting";
        Promise.resolve().then(function () { self._finish("audio-capture"); });
        return;
      }
      this._state = "starting";
      deps.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
        if (self._state !== "starting") { // aborted while the permission prompt was open
          try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (err) { /* ignore */ }
          return;
        }
        self._stream = stream;
        self._begin(stream);
      }, function (err) {
        if (self._state === "starting") self._finish(errorCodeForGetUserMedia(err));
      });
    };

    CloudRecognition.prototype._begin = function (stream) {
      var self = this;
      var mimeType = pickMimeType(deps.MediaRecorder);
      var recorder;
      try {
        recorder = mimeType ? new deps.MediaRecorder(stream, { mimeType: mimeType }) : new deps.MediaRecorder(stream);
      } catch (err) {
        this._finish("audio-capture");
        return;
      }
      this._recorder = recorder;
      this._chunks = [];
      this._heardSpeech = false;
      this._startedAt = now();
      this._sendOnStop = true;

      recorder.ondataavailable = function (event) {
        if (event && event.data && event.data.size > 0) self._chunks.push(event.data);
      };
      recorder.onerror = function () { self._sendOnStop = false; self._finish("audio-capture"); };
      recorder.onstop = function () { self._upload(recorder.mimeType || mimeType || "audio/webm"); };

      try { recorder.start(); } catch (err) { this._finish("audio-capture"); return; }
      this._state = "recording";
      this._emit("start");

      this._maxTimer = timers.setTimeout(function () { self.stop(); }, MAX_RECORDING_MS);
      this._noSpeechTimer = timers.setTimeout(function () { if (!self._heardSpeech) self.stop(); }, NO_SPEECH_MS);
      this._watchLevel(stream);
    };

    // Ends the clip after a pause once speech was heard. Without an
    // AudioContext there is no pause detection: the clip ends on stop() or the time limit.
    CloudRecognition.prototype._watchLevel = function (stream) {
      var self = this;
      if (!deps.AudioContext) return;
      var context;
      var analyser;
      try {
        context = new deps.AudioContext();
        var source = context.createMediaStreamSource(stream);
        analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
      } catch (err) { return; }
      this._audioContext = context;
      this._canDetectSpeech = true;
      var buffer = new Float32Array(analyser.fftSize);
      var lastSpeechAt = now();
      this._levelTimer = timers.setInterval(function () {
        if (self._state !== "recording") return;
        analyser.getFloatTimeDomainData(buffer);
        var sum = 0;
        for (var i = 0; i < buffer.length; i += 1) sum += buffer[i] * buffer[i];
        var rms = Math.sqrt(sum / buffer.length);
        if (rms > SPEECH_LEVEL) {
          lastSpeechAt = now();
          if (!self._heardSpeech) {
            self._heardSpeech = true;
            self._emit("speechstart");
            self._emit("soundstart");
          }
        } else if (self._heardSpeech && now() - lastSpeechAt > SILENCE_AFTER_SPEECH_MS) {
          self.stop();
        }
      }, LEVEL_POLL_MS);
    };

    CloudRecognition.prototype.stop = function () {
      if (this._state !== "recording") {
        if (this._state === "starting") this._finish(null); // stopped before the microphone opened
        return;
      }
      this._state = "sending";
      this._cleanupTimersOnly();
      try { this._recorder.stop(); } catch (err) { this._upload("audio/webm"); }
    };

    CloudRecognition.prototype._cleanupTimersOnly = function () {
      var self = this;
      ["_maxTimer", "_noSpeechTimer"].forEach(function (k) { if (self[k]) { timers.clearTimeout(self[k]); self[k] = null; } });
      if (this._levelTimer) { timers.clearInterval(this._levelTimer); this._levelTimer = null; }
    };

    CloudRecognition.prototype.abort = function () {
      if (this._state === "done") return;
      this._sendOnStop = false;
      var recorder = this._recorder;
      if (recorder && recorder.state === "recording") {
        try { recorder.onstop = null; recorder.stop(); } catch (err) { /* ignore */ }
      }
      this._finish(null);
    };

    CloudRecognition.prototype._upload = function (mimeType) {
      var self = this;
      if (this._state === "done" || !this._sendOnStop) return;
      this._state = "sending";
      this._cleanup(); // the microphone is released as soon as recording ends
      var size = 0;
      this._chunks.forEach(function (c) { size += c.size; });
      var duration = now() - this._startedAt;
      // nothing worth uploading: too short, or silence all along (when we can tell)
      if (!size || duration < MIN_RECORDING_MS || (this._canDetectSpeech && !this._heardSpeech)) { this._finish("no-speech"); return; }

      var BlobClass = deps.Blob || (typeof Blob !== "undefined" ? Blob : null);
      var blob = BlobClass ? new BlobClass(this._chunks, { type: mimeType }) : this._chunks[0];
      var contentType = String(mimeType || "audio/webm");
      var lang = serverLanguage(this.lang);
      var url = deps.apiUrl("/api/transcribe") + (lang ? "?lang=" + lang : "");
      Promise.resolve(deps.getAuthHeaders ? deps.getAuthHeaders() : {}).then(function (auth) {
        return deps.fetch(url, { method: "POST", headers: Object.assign({ "Content-Type": contentType }, auth), body: blob });
      }).then(function (response) {
        if (self._state === "done") return null;
        if (response.status === 429) { self._finish("service-busy"); return null; }
        if (!response.ok) { self._finish("network"); return null; }
        return response.json();
      }).then(function (data) {
        if (!data || self._state === "done") return;
        var text = typeof data.text === "string" ? data.text.trim() : "";
        if (!text) { self._finish("no-speech"); return; }
        self._emit("result", { resultIndex: 0, results: [{ 0: { transcript: text }, isFinal: true, length: 1 }] });
        self._finish(null);
      }).catch(function () {
        self._finish("network");
      });
    };

    return CloudRecognition;
  }

  function isElectron(win) {
    return Boolean(win && win.linguahubDesktop);
  }

  // Which recognizer class to use in this environment, or null.
  function getRecognition(win, cloud) {
    var native = win.SpeechRecognition || win.webkitSpeechRecognition || null;
    if (native && !isElectron(win)) return native;
    return cloud || null;
  }

  function install(win) {
    var hasMic = Boolean(win.navigator && win.navigator.mediaDevices && win.navigator.mediaDevices.getUserMedia && win.MediaRecorder);
    var cloud = hasMic ? createCloudRecognition({
      mediaDevices: win.navigator.mediaDevices,
      MediaRecorder: win.MediaRecorder,
      AudioContext: win.AudioContext || win.webkitAudioContext || null,
      fetch: function (url, init) { return win.fetch(url, init); },
      apiUrl: function (path) { return win.LINGUAHUB_CONFIG && win.LINGUAHUB_CONFIG.apiUrl ? win.LINGUAHUB_CONFIG.apiUrl(path) : path; },
      getAuthHeaders: function () {
        var auth = win.LinguaHubAuth;
        if (!auth || !auth.isAvailable || !auth.isAvailable() || !auth.getCurrentUser()) return Promise.resolve({});
        return Promise.resolve(auth.getIdToken()).then(function (token) { return token ? { Authorization: "Bearer " + token } : {}; }, function () { return {}; });
      },
      Blob: win.Blob,
      canStart: function () { return !win.linguahubUsage || win.linguahubUsage.canUseAi(); }
    }) : null;
    return {
      get: function () { return getRecognition(win, cloud); },
      isCloud: function () { var r = getRecognition(win, cloud); return Boolean(r) && r === cloud; }
    };
  }

  return {
    createCloudRecognition: createCloudRecognition,
    getRecognition: getRecognition,
    isElectron: isElectron,
    pickMimeType: pickMimeType,
    serverLanguage: serverLanguage,
    install: install,
    LIMITS: { MAX_RECORDING_MS: MAX_RECORDING_MS, NO_SPEECH_MS: NO_SPEECH_MS, SILENCE_AFTER_SPEECH_MS: SILENCE_AFTER_SPEECH_MS, MIN_RECORDING_MS: MIN_RECORDING_MS }
  };
});
