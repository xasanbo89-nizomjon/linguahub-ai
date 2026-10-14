// LinguaHub AI - Translate workspace: two panes (source on the left, the
// translation on the right) with automatic source-language detection, swap,
// and Copy / Listen on both sides. It translates as you type (debounced) and
// immediately on Enter (Shift+Enter makes a new line).

(function () {
  "use strict";

  var DEBOUNCE_MS = 800;
  var MAX_CHARS = 2000;
  var AUTO_KEY = "linguahub-ai:translate-auto";

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function iconButton(label, glyph, className) {
    var btn = el("button", "ws-icon-btn " + (className || ""));
    btn.type = "button";
    btn.setAttribute("aria-label", label);
    btn.setAttribute("title", label);
    btn.textContent = glyph;
    return btn;
  }

  function create(api) {
    var panel = api.panel;
    var pair = api.pair;
    var Lang = window.LinguaHubLanguages;
    var AI = window.LinguaHubAI;

    var auto = true;
    try { auto = window.localStorage.getItem(AUTO_KEY) !== "0"; } catch (err) { /* default */ }

    var detected = "";
    var timer = null;
    var controller = null;
    var runId = 0;
    var lastKey = "";
    var recorded = false;

    // ---- layout ----
    var root = el("div", "ws ws-translate");

    var toolbar = el("div", "ws-toolbar");
    var sourceSelect = el("select", "lang-pair-select");
    sourceSelect.setAttribute("aria-label", "Translate from");
    var autoOption = el("option", "", "Detect language");
    autoOption.value = "auto";
    sourceSelect.appendChild(autoOption);
    Lang.LANGUAGES.forEach(function (l) { var o = el("option", "", l.name); o.value = l.code; sourceSelect.appendChild(o); });
    var swapBtn = el("button", "lang-pair-swap");
    swapBtn.type = "button";
    swapBtn.setAttribute("aria-label", "Swap languages");
    swapBtn.setAttribute("title", "Swap languages");
    swapBtn.textContent = "⇄";
    var targetSelect = el("select", "lang-pair-select");
    targetSelect.setAttribute("aria-label", "Translate to");
    Lang.LANGUAGES.forEach(function (l) { var o = el("option", "", l.name); o.value = l.code; targetSelect.appendChild(o); });
    toolbar.appendChild(sourceSelect);
    toolbar.appendChild(swapBtn);
    toolbar.appendChild(targetSelect);
    root.appendChild(toolbar);

    var panes = el("div", "ws-panes");

    var sourcePane = el("section", "ws-pane");
    sourcePane.setAttribute("aria-label", "Text to translate");
    var source = el("textarea", "ws-textarea");
    source.setAttribute("aria-label", "Text to translate");
    source.setAttribute("placeholder", "Type or paste text to translate");
    source.setAttribute("dir", "auto");
    source.setAttribute("maxlength", String(MAX_CHARS));
    source.setAttribute("rows", "8");
    var sourceFoot = el("div", "ws-pane-foot");
    var detectedLabel = el("span", "ws-detected");
    detectedLabel.setAttribute("aria-live", "polite");
    var sourceListen = iconButton("Listen to the original text", "🔊", "voice-feature");
    var sourceCopy = iconButton("Copy the original text", "⧉");
    var counter = el("span", "ws-counter", "0 / " + MAX_CHARS);
    sourceFoot.appendChild(detectedLabel);
    sourceFoot.appendChild(sourceListen);
    sourceFoot.appendChild(sourceCopy);
    sourceFoot.appendChild(counter);
    sourcePane.appendChild(source);
    sourcePane.appendChild(sourceFoot);

    var targetPane = el("section", "ws-pane ws-pane-target");
    targetPane.setAttribute("aria-label", "Translation");
    var output = el("div", "ws-output");
    output.setAttribute("dir", "auto");
    output.setAttribute("aria-live", "polite");
    var targetFoot = el("div", "ws-pane-foot");
    var targetListen = iconButton("Listen to the translation", "🔊", "voice-feature");
    var targetCopy = iconButton("Copy the translation", "⧉");
    targetFoot.appendChild(targetListen);
    targetFoot.appendChild(targetCopy);
    targetPane.appendChild(output);
    targetPane.appendChild(targetFoot);

    panes.appendChild(sourcePane);
    panes.appendChild(targetPane);
    root.appendChild(panes);
    api.panel.appendChild(root);

    var translation = "";

    function showPlaceholder() {
      output.className = "ws-output is-placeholder";
      output.textContent = "The translation appears here.";
      translation = "";
      refreshButtons();
    }

    function refreshButtons() {
      var hasSource = source.value.trim().length > 0;
      sourceListen.disabled = !hasSource;
      sourceCopy.disabled = !hasSource;
      targetListen.disabled = !translation;
      targetCopy.disabled = !translation;
    }

    function sourceLang() {
      if (auto) return detected || pair.get().from;
      return pair.get().from;
    }

    function render() {
      var p = pair.get();
      sourceSelect.value = auto ? "auto" : p.from;
      targetSelect.value = p.to;
      detectedLabel.textContent = auto && detected ? "Detected: " + Lang.nameOf(detected) : "";
      counter.textContent = source.value.length + " / " + MAX_CHARS;
      refreshButtons();
    }

    function setAuto(next) {
      auto = next;
      try { window.localStorage.setItem(AUTO_KEY, auto ? "1" : "0"); } catch (err) { /* ignore */ }
    }

    // ---- translating ----
    function cancel() {
      runId += 1;
      if (timer) { clearTimeout(timer); timer = null; }
      if (controller) { controller.abort(); controller = null; }
    }

    function showError(message) {
      output.className = "ws-output is-error";
      output.textContent = "";
      output.appendChild(el("span", "ws-error-text", message));
      var retry = el("button", "lh-btn lh-btn-secondary ws-retry", "Retry");
      retry.type = "button";
      retry.addEventListener("click", function () { lastKey = ""; run(); });
      output.appendChild(retry);
      translation = "";
      refreshButtons();
    }

    async function run() {
      cancel();
      var text = source.value.trim();
      if (!text) { lastKey = ""; detected = ""; showPlaceholder(); render(); return; }
      var p = pair.get();
      var key = [auto ? "auto" : p.from, p.to, text].join("\u0001");
      if (key === lastKey) return;

      controller = typeof AbortController === "function" ? new AbortController() : null;
      var myRun = ++runId;
      output.className = "ws-output is-busy";
      output.setAttribute("aria-busy", "true");
      output.textContent = "Translating…";
      try {
        var result = await AI.request({
          mode: "translate",
          messages: [{ role: "user", content: AI.prompts.translate(auto ? "auto" : p.from, p.to, text) }],
          signal: controller ? controller.signal : undefined,
          normalize: AI.normalizeTranslate
        });
        if (myRun !== runId) return; // a newer request replaced this one
        lastKey = key;
        output.removeAttribute("aria-busy");
        if (result.data) {
          detected = result.data.detected || (auto ? "" : p.from);
          translation = result.data.translation;
        } else {
          // the reply was not the JSON we asked for: show it as it is
          detected = "";
          translation = result.text.trim();
        }
        if (!translation) { showError("There was nothing to translate."); render(); return; }
        output.className = "ws-output";
        output.textContent = translation;
        if (!recorded) {
          recorded = true;
          document.dispatchEvent(new CustomEvent("linguahub:activity"));
        }
        render();
      } catch (err) {
        output.removeAttribute("aria-busy");
        if (err && err.aborted) return; // a newer request replaced this one
        showError(err && err.userMessage ? err.userMessage : AI.describeError(err));
      }
    }

    function schedule() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () { timer = null; run(); }, DEBOUNCE_MS);
    }

    // ---- events ----
    source.addEventListener("input", function () {
      render();
      if (!source.value.trim()) { cancel(); lastKey = ""; detected = ""; showPlaceholder(); render(); return; }
      schedule();
    });

    source.addEventListener("keydown", function (event) {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        if (timer) { clearTimeout(timer); timer = null; }
        run();
      }
    });

    sourceSelect.addEventListener("change", function () {
      if (sourceSelect.value === "auto") setAuto(true);
      else { setAuto(false); pair.setFrom(sourceSelect.value); }
      lastKey = "";
      render();
      if (source.value.trim()) run();
    });

    targetSelect.addEventListener("change", function () {
      pair.setTo(targetSelect.value);
    });

    swapBtn.addEventListener("click", function () {
      var current = pair.get();
      var from = auto ? (detected || current.from) : current.from;
      var moved = translation;
      setAuto(false);
      pair.set({ from: current.to, to: from === current.to ? current.from : from });
      detected = "";
      lastKey = "";
      if (moved) source.value = moved;
      render();
      if (source.value.trim()) run(); else showPlaceholder();
    });

    pair.onChange(function () {
      lastKey = "";
      render();
      if (source.value.trim() && api.panel.hidden === false) schedule();
    });

    function copy(text) {
      if (!text) return;
      var done = function () { if (window.LinguaHubToast) window.LinguaHubToast.show({ type: "success", message: "Copied to clipboard.", duration: 1500 }); };
      var fail = function () { if (window.LinguaHubToast) window.LinguaHubToast.show({ type: "error", message: "Could not copy to the clipboard." }); };
      try { navigator.clipboard.writeText(text).then(done, fail); } catch (err) { fail(); }
    }

    function listen(text, lang) {
      if (text && window.LinguaHubVoice && window.LinguaHubVoice.speakText) window.LinguaHubVoice.speakText(text, Lang.speechLang(lang));
    }

    sourceCopy.addEventListener("click", function () { copy(source.value.trim()); });
    targetCopy.addEventListener("click", function () { copy(translation); });
    sourceListen.addEventListener("click", function () { listen(source.value.trim(), sourceLang()); });
    targetListen.addEventListener("click", function () { listen(translation, pair.get().to); });

    showPlaceholder();
    render();

    return {
      activate: function () { render(); source.focus(); },
      deactivate: function () { cancel(); if (window.LinguaHubVoice) window.LinguaHubVoice.stopSpeaking(); },
      // exposed for tests
      _run: run,
      _state: function () { return { auto: auto, detected: detected, translation: translation, sourceLang: sourceLang() }; }
    };
  }

  if (window.LinguaHubWorkspace) window.LinguaHubWorkspace.register("translate", create);
})();
