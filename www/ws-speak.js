// LinguaHub AI - Speak workspace: a voice-first conversation partner.
//
// A large microphone button sits in the centre; while it listens an animated
// waveform plays and the transcript appears under it. When you stop talking
// the sentence goes to the "speak" mode, and the answer comes back as text
// AND out loud. Small pronunciation / grammar / vocabulary notes appear under
// the sentence you said. Speech recognition is not available everywhere
// (for example inside Electron), so typing a sentence always works too.

(function () {
  "use strict";

  var MAX_HISTORY_MESSAGES = 8;
  var MAX_TYPED_CHARS = 500;

  var RECOGNITION_ERRORS = {
    "not-allowed": "Microphone access is blocked. Allow it in your browser or system settings, or type your sentence below.",
    "service-not-allowed": "Speech recognition is blocked here. You can type your sentence below.",
    "no-speech": "I didn't hear anything. Tap the microphone and try again.",
    "audio-capture": "No microphone was found. Connect one, or type your sentence below.",
    "network": "Speech recognition needs an internet connection and isn't available here. You can type your sentence below.",
    "language-not-supported": "Speech input isn't available for this language here. You can type your sentence below."
  };

  var NOTE_LABELS = { grammar: "Grammar", pronunciation: "Pronunciation", vocabulary: "Vocabulary" };

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function create(api) {
    var pair = api.pair;
    var Lang = window.LinguaHubLanguages;
    var AI = window.LinguaHubAI;
    var Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    var state = "idle"; // idle | listening | thinking | speaking
    var history = [];   // what is sent to the model (user lines carry the language header)
    var recognition = null;
    var requestController = null;
    var recorded = false;

    var root = el("div", "ws ws-speak");

    var toolbar = el("div", "ws-toolbar");
    var control = Lang.createControl(pair, { className: "ws-pair-control" });
    var pairNote = el("span", "ws-note");
    var resetBtn = el("button", "lh-btn lh-btn-secondary ws-reset", "New conversation");
    resetBtn.type = "button";
    toolbar.appendChild(control.el);
    toolbar.appendChild(pairNote);
    toolbar.appendChild(resetBtn);
    root.appendChild(toolbar);

    var log = el("div", "speak-log");
    log.setAttribute("role", "log");
    log.setAttribute("aria-label", "Conversation");
    log.setAttribute("aria-live", "polite");
    var intro = el("p", "speak-intro", "Tap the microphone and say something in the language you are learning. I'll answer out loud and point out small things to improve.");
    log.appendChild(intro);
    root.appendChild(log);

    var stage = el("div", "speak-stage");
    var transcript = el("div", "speak-transcript");
    transcript.setAttribute("dir", "auto");
    transcript.setAttribute("aria-live", "polite");

    var mic = el("button", "speak-mic");
    mic.type = "button";
    mic.setAttribute("aria-pressed", "false");
    var micIcon = null;
    if (typeof document.createElementNS === "function") {
      micIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      micIcon.setAttribute("viewBox", "0 0 24 24");
      micIcon.setAttribute("class", "speak-mic-icon");
      micIcon.setAttribute("aria-hidden", "true");
      [["rect", { x: 9, y: 3, width: 6, height: 11, rx: 3 }], ["path", { d: "M5 11a7 7 0 0 0 14 0M12 18v3" }]].forEach(function (p) {
        var node = document.createElementNS("http://www.w3.org/2000/svg", p[0]);
        Object.keys(p[1]).forEach(function (k) { node.setAttribute(k, String(p[1][k])); });
        micIcon.appendChild(node);
      });
    }
    var wave = el("span", "speak-wave");
    wave.setAttribute("aria-hidden", "true");
    for (var i = 0; i < 7; i += 1) wave.appendChild(el("i"));
    if (micIcon) mic.appendChild(micIcon);
    mic.appendChild(wave);
    var micLabel = el("span", "sr-only", "Start speaking");
    mic.appendChild(micLabel);

    var status = el("div", "speak-status");
    status.setAttribute("role", "status");

    var typed = el("form", "speak-typed");
    var typedInput = el("input", "speak-typed-input");
    typedInput.type = "text";
    typedInput.setAttribute("placeholder", "Or type your sentence");
    typedInput.setAttribute("aria-label", "Type your sentence");
    typedInput.setAttribute("dir", "auto");
    typedInput.setAttribute("maxlength", String(MAX_TYPED_CHARS));
    typedInput.setAttribute("autocomplete", "off");
    var typedSend = el("button", "lh-btn lh-btn-secondary", "Send");
    typedSend.type = "submit";
    typed.appendChild(typedInput);
    typed.appendChild(typedSend);

    stage.appendChild(transcript);
    stage.appendChild(mic);
    stage.appendChild(status);
    stage.appendChild(typed);
    root.appendChild(stage);
    api.panel.appendChild(root);

    // ---- state ----
    function setState(next, message) {
      state = next;
      var listening = next === "listening";
      mic.classList.toggle("is-listening", listening);
      mic.classList.toggle("is-busy", next === "thinking");
      mic.setAttribute("aria-pressed", String(listening));
      mic.disabled = next === "thinking";
      typedSend.disabled = next === "thinking";
      micLabel.textContent = listening ? "Stop listening" : next === "speaking" ? "Stop and speak again" : "Start speaking";
      var text = message !== undefined ? message : (
        next === "listening" ? "Listening…" :
        next === "thinking" ? "Thinking…" :
        next === "speaking" ? "Speaking…" :
        Recognition ? "Tap the microphone to speak" : "Speech input isn't available here – type your sentence below");
      status.textContent = text;
    }

    function renderPair() {
      var p = pair.get();
      pairNote.textContent = "Practising " + Lang.nameOf(p.to) + " · notes in " + Lang.nameOf(p.from);
    }

    function scrollLog() {
      log.scrollTop = log.scrollHeight;
    }

    function addTurn(role, text) {
      if (intro.parentNode === log) log.removeChild(intro);
      var turn = el("div", "speak-turn speak-" + role);
      var bubble = el("div", "speak-bubble", text);
      bubble.setAttribute("dir", "auto");
      bubble.setAttribute("lang", Lang.speechLang(pair.get().to).slice(0, 2));
      turn.appendChild(bubble);
      if (role === "assistant") {
        var listen = el("button", "ws-icon-btn voice-feature", "🔊");
        listen.type = "button";
        listen.setAttribute("aria-label", "Listen again");
        listen.setAttribute("title", "Listen again");
        listen.addEventListener("click", function () { speak(text); });
        turn.appendChild(listen);
      }
      log.appendChild(turn);
      scrollLog();
      return turn;
    }

    function addNotes(turn, notes) {
      if (!notes || !notes.length) return;
      var list = el("ul", "speak-notes");
      notes.forEach(function (note) {
        var item = el("li", "speak-note");
        item.setAttribute("data-kind", note.kind);
        item.appendChild(el("span", "speak-note-kind", NOTE_LABELS[note.kind] || "Note"));
        var text = el("span", "speak-note-text", note.text);
        text.setAttribute("dir", "auto");
        item.appendChild(text);
        list.appendChild(item);
      });
      turn.appendChild(list);
      scrollLog();
    }

    // ---- speaking the answer ----
    function speak(text) {
      var voice = window.LinguaHubVoice;
      if (!voice || !voice.speakText) { setState("idle"); return; }
      setState("speaking");
      Promise.resolve(voice.speakText(text, Lang.speechLang(pair.get().to))).then(function () {
        if (state === "speaking") setState("idle");
      }, function () {
        if (state === "speaking") setState("idle");
      });
    }

    // ---- sending a sentence ----
    function showRetry(turn, text, message) {
      var box = el("div", "chat-error speak-error");
      box.setAttribute("role", "alert");
      box.appendChild(el("span", "chat-error-text", message));
      var retry = el("button", "lh-btn lh-btn-secondary", "Retry");
      retry.type = "button";
      retry.addEventListener("click", function () {
        if (box.parentNode) box.parentNode.removeChild(box);
        if (turn.parentNode) turn.parentNode.removeChild(turn);
        submit(text);
      });
      box.appendChild(retry);
      log.appendChild(box);
      scrollLog();
    }

    async function submit(text) {
      var sentence = String(text || "").trim();
      if (!sentence) return;
      var turn = addTurn("user", sentence);
      history.push({ role: "user", content: AI.prompts.speak(pair.get(), sentence) });
      if (history.length > MAX_HISTORY_MESSAGES) history = history.slice(history.length - MAX_HISTORY_MESSAGES);
      while (history.length && history[0].role !== "user") history.shift();
      transcript.textContent = "";
      setState("thinking");
      requestController = typeof AbortController === "function" ? new AbortController() : null;
      try {
        var answer = await AI.request({
          mode: "speak",
          messages: history.slice(),
          signal: requestController ? requestController.signal : undefined,
          normalize: AI.normalizeSpeak
        });
        var reply = answer.data ? answer.data.reply : answer.text.trim();
        if (!reply) throw Object.assign(new Error("empty"), { status: 502, userMessage: AI.describeError({ status: 502 }) });
        if (answer.data) addNotes(turn, answer.data.notes);
        addTurn("assistant", reply);
        history.push({ role: "assistant", content: reply });
        if (!recorded) { recorded = true; document.dispatchEvent(new CustomEvent("linguahub:activity")); }
        speak(reply);
      } catch (err) {
        history.pop(); // the failed sentence is not part of the conversation
        setState("idle");
        if (err && err.aborted) return;
        showRetry(turn, sentence, err && err.userMessage ? err.userMessage : AI.describeError(err));
      } finally {
        requestController = null;
      }
    }

    // ---- listening ----
    function stopRecognition(abort) {
      if (!recognition) return;
      var current = recognition;
      // a normal stop keeps `recognition` so onend still sends what was heard
      if (abort) recognition = null;
      try { if (abort) current.abort(); else current.stop(); } catch (err) { /* already stopped */ }
    }

    function startListening() {
      if (!Recognition) {
        setState("idle", "Speech input isn't available here – type your sentence below");
        typedInput.focus();
        return;
      }
      if (window.LinguaHubVoice) window.LinguaHubVoice.stopSpeaking();
      var rec = new Recognition();
      var finalText = "";
      var errorCode = "";
      rec.lang = Lang.speechLang(pair.get().to);
      rec.continuous = false;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      recognition = rec;
      transcript.textContent = "";
      rec.onstart = function () { setState("listening"); };
      rec.onresult = function (event) {
        var interim = "";
        for (var i = event.resultIndex; i < event.results.length; i += 1) {
          var piece = event.results[i][0] ? event.results[i][0].transcript : "";
          if (event.results[i].isFinal) finalText += piece; else interim += piece;
        }
        transcript.textContent = (finalText + interim).trim();
      };
      rec.onerror = function (event) { errorCode = event && event.error ? event.error : "error"; };
      rec.onend = function () {
        if (recognition !== rec) return; // aborted on purpose (leaving the screen, new conversation)
        recognition = null;
        var text = (finalText || transcript.textContent).trim();
        if (text) { submit(text); return; }
        setState("idle", errorCode && errorCode !== "aborted" ? (RECOGNITION_ERRORS[errorCode] || "Something went wrong with the microphone. You can type your sentence below.") : "I didn't catch that. Tap the microphone and try again.");
      };
      try { rec.start(); } catch (err) { recognition = null; setState("idle", "The microphone could not start. You can type your sentence below."); }
    }

    mic.addEventListener("click", function () {
      if (state === "listening") { stopRecognition(false); return; }
      if (state === "thinking") return;
      startListening();
    });

    typed.addEventListener("submit", function (event) {
      event.preventDefault();
      if (state === "thinking") return;
      var text = typedInput.value.trim();
      if (!text) return;
      typedInput.value = "";
      stopRecognition(true);
      if (window.LinguaHubVoice) window.LinguaHubVoice.stopSpeaking();
      submit(text);
    });

    function reset() {
      stopRecognition(true);
      if (requestController) { requestController.abort(); requestController = null; }
      if (window.LinguaHubVoice) window.LinguaHubVoice.stopSpeaking();
      history = [];
      log.textContent = "";
      log.appendChild(intro);
      transcript.textContent = "";
      setState("idle");
    }
    resetBtn.addEventListener("click", reset);
    pair.onChange(renderPair);

    renderPair();
    setState("idle");

    return {
      activate: function () { renderPair(); setState(state === "listening" || state === "thinking" ? state : "idle"); },
      deactivate: function () {
        stopRecognition(true);
        if (requestController) requestController.abort();
        if (window.LinguaHubVoice) window.LinguaHubVoice.stopSpeaking();
        if (state !== "thinking") setState("idle");
      },
      _submit: submit,
      _state: function () { return { state: state, history: history.slice() }; }
    };
  }

  if (window.LinguaHubWorkspace) window.LinguaHubWorkspace.register("speak", create);
})();
