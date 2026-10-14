// LinguaHub AI - the learning home (shown instead of a bare hero while a chat
// is empty and Free chat is selected): language pair, word of the day,
// progress (day streak / words learned / due today) and the five mode cards.
//
// Everything on it is real local data: the pair (language-pair.js), the word
// of the day (word-of-day.js, built in), activity days from learning-memory.js
// and the saved words / review schedule from vocab-store.js.

var LinguaHubHome = (function () {
  "use strict";

  var SVG_NS = "http://www.w3.org/2000/svg";

  // One card per mode: icon paths (24x24, stroked), title, one line of help.
  var MODE_CARDS = [
    { id: "translate", title: "Translate", text: "Type or paste text and get a translation.",
      icon: [["path", { d: "M4 5h9M8.5 3v2M6 5c0 4 3 7 6 8M12 5c-.5 3-3 6.5-7 8" }], ["path", { d: "M12 21l4-9 4 9M13.5 18h5" }]] },
    { id: "speak", title: "Speak", text: "Talk out loud and get gentle feedback.",
      icon: [["rect", { x: 9, y: 3, width: 6, height: 11, rx: 3 }], ["path", { d: "M5 11a7 7 0 0 0 14 0M12 18v3" }]] },
    { id: "grammar", title: "Grammar", text: "Write, and see corrections inline.",
      icon: [["path", { d: "M4 20h4L19 9l-4-4L4 16v4z" }], ["path", { d: "M13.5 6.5l4 4" }]] },
    { id: "vocabulary", title: "Vocabulary", text: "Save words and review flashcards.",
      icon: [["rect", { x: 3, y: 7, width: 14, height: 12, rx: 2 }], ["path", { d: "M7 4h12a2 2 0 0 1 2 2v10" }]] },
    { id: "general", title: "Free chat", text: "Ask anything, in any language.",
      icon: [["path", { d: "M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" }]] }
  ];

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function icon(paths, className) {
    if (typeof document.createElementNS !== "function") return null;
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    if (className) svg.setAttribute("class", className);
    paths.forEach(function (p) {
      var node = document.createElementNS(SVG_NS, p[0]);
      Object.keys(p[1]).forEach(function (k) { node.setAttribute(k, String(p[1][k])); });
      svg.appendChild(node);
    });
    return svg;
  }

  var LISTEN_ICON = [["path", { d: "M4 10v4h4l5 4V6L8 10H4z" }], ["path", { d: "M16 9a4 4 0 0 1 0 6" }], ["path", { d: "M18.5 6.5a8 8 0 0 1 0 11" }]];

  function init(options) {
    var container = options.container;
    if (!container) return null;
    var pair = options.pair;
    var vocab = options.vocab;
    var modeSelect = options.modeSelect;
    var control = null;
    var shownDay = null;

    function openMode(id) {
      if (window.LinguaHubWorkspace && typeof window.LinguaHubWorkspace.open === "function") {
        window.LinguaHubWorkspace.open(id);
        return;
      }
      var available = Array.prototype.some.call(modeSelect.options || [], function (o) { return o.value === id && !o.disabled; });
      if (!available) {
        if (window.LinguaHubToast) window.LinguaHubToast.show({ type: "warning", message: "That mode isn't available right now." });
        return;
      }
      modeSelect.value = id;
      modeSelect.dispatchEvent(new Event("change", { bubbles: true }));
      if (id === "general" && options.focusComposer) options.focusComposer();
    }

    function memoryDays() {
      var memory = window.LinguaHubLearningMemory;
      try { return memory && memory.getActivityDates ? memory.getActivityDates() : []; } catch (err) { return []; }
    }

    function buildWordOfDay() {
      var current = pair.get();
      var data = window.LinguaHubWordOfDay ? window.LinguaHubWordOfDay.pick(current, new Date()) : null;
      var card = el("section", "home-card wod-card");
      card.setAttribute("aria-label", "Word of the day");
      card.appendChild(el("div", "home-card-label", "Word of the day"));
      if (!data) {
        card.appendChild(el("p", "home-muted", "Pick two different languages to see today's word."));
        return card;
      }

      var head = el("div", "wod-head");
      var word = el("div", "wod-word", data.word);
      word.setAttribute("dir", "auto");
      word.setAttribute("lang", data.wordLang);
      head.appendChild(word);

      var listen = el("button", "wod-icon-btn voice-feature");
      listen.type = "button";
      listen.setAttribute("aria-label", "Listen to " + data.word);
      listen.setAttribute("title", "Listen");
      var listenIcon = icon(LISTEN_ICON);
      if (listenIcon) listen.appendChild(listenIcon); else listen.textContent = "Listen";
      listen.addEventListener("click", function () {
        if (window.LinguaHubVoice && window.LinguaHubVoice.speakText) window.LinguaHubVoice.speakText(data.word, window.LinguaHubLanguages.speechLang(data.wordLang));
      });
      head.appendChild(listen);
      card.appendChild(head);

      var translation = el("div", "wod-translation", data.translation);
      translation.setAttribute("dir", "auto");
      translation.setAttribute("lang", data.translationLang);
      card.appendChild(translation);

      var example = el("p", "wod-example", data.example);
      example.setAttribute("dir", "auto");
      example.setAttribute("lang", data.wordLang);
      card.appendChild(example);
      var exampleTr = el("p", "wod-example-translation", data.exampleTranslation);
      exampleTr.setAttribute("dir", "auto");
      exampleTr.setAttribute("lang", data.translationLang);
      card.appendChild(exampleTr);

      var saved = vocab ? vocab.has(data.word, data.wordLang) : false;
      var save = el("button", "wod-save", saved ? "Saved to vocabulary" : "Save to vocabulary");
      save.type = "button";
      save.disabled = saved || !vocab;
      save.addEventListener("click", function () {
        var result = vocab.add({ word: data.word, translation: data.translation, lang: data.wordLang, example: data.example, exampleTranslation: data.exampleTranslation, partOfSpeech: data.partOfSpeech || "" });
        if (result.ok && window.LinguaHubToast) window.LinguaHubToast.show({ type: "success", message: result.duplicate ? "Already in your vocabulary." : "Saved “" + data.word + "”." });
      });
      card.appendChild(save);
      return card;
    }

    function buildStats() {
      var stats = vocab ? vocab.stats() : { learned: 0, due: 0 };
      var streak = window.LinguaHubLearningStats ? window.LinguaHubLearningStats.streak(memoryDays()) : 0;
      var list = el("ul", "home-stats");
      list.setAttribute("aria-label", "Your progress");

      function tile(value, label, onClick) {
        var item = el("li", "home-stat");
        var body = onClick ? el("button", "home-stat-body home-stat-action") : el("div", "home-stat-body");
        if (onClick) { body.type = "button"; body.addEventListener("click", onClick); }
        body.appendChild(el("span", "home-stat-value", String(value)));
        body.appendChild(el("span", "home-stat-label", label));
        item.appendChild(body);
        return item;
      }
      list.appendChild(tile(streak, "day streak"));
      list.appendChild(tile(stats.learned, stats.learned === 1 ? "word learned" : "words learned"));
      list.appendChild(tile(stats.due, "due today", stats.due > 0 ? function () {
        if (window.LinguaHubWorkspace && window.LinguaHubWorkspace.open) window.LinguaHubWorkspace.open("vocabulary", { tab: "review" });
        else openMode("vocabulary");
      } : null));
      return list;
    }

    function buildModes() {
      var wrap = el("div", "home-modes");
      wrap.setAttribute("role", "group");
      wrap.setAttribute("aria-label", "Choose how to practise");
      MODE_CARDS.forEach(function (card) {
        var btn = el("button", "mode-card");
        btn.type = "button";
        btn.setAttribute("data-mode", card.id);
        var ic = icon(card.icon, "mode-card-icon");
        if (ic) btn.appendChild(ic);
        var text = el("span", "mode-card-text");
        text.appendChild(el("span", "mode-card-title", card.title));
        text.appendChild(el("span", "mode-card-desc", card.text));
        btn.appendChild(text);
        btn.addEventListener("click", function () { openMode(card.id); });
        wrap.appendChild(btn);
      });
      return wrap;
    }

    function render() {
      shownDay = window.LinguaHubLearningStats ? window.LinguaHubLearningStats.dayKey() : null;
      container.textContent = "";
      var title = el("h2", "home-title", "What would you like to learn today?");
      container.appendChild(title);

      var pairRow = el("div", "home-pair");
      if (control) control.destroy();
      control = window.LinguaHubLanguages.createControl(pair, { className: "home-pair-control" });
      pairRow.appendChild(el("span", "home-pair-label", "I speak"));
      pairRow.appendChild(control.el);
      pairRow.appendChild(el("span", "home-pair-label", "and I'm learning"));
      container.appendChild(pairRow);

      var top = el("div", "home-top");
      top.appendChild(buildWordOfDay());
      top.appendChild(buildStats());
      container.appendChild(top);
      container.appendChild(buildModes());
    }

    // The learning home replaces the plain hero only for Free chat; every
    // other mode keeps its own prompt suggestions (see app.js).
    function applyVisibility() {
      var home = modeSelect.value === "general";
      container.hidden = !home;
      var fallback = document.getElementById("hero-default");
      if (fallback) fallback.hidden = home;
    }

    pair.onChange(render);
    if (vocab) vocab.subscribe(render);
    document.addEventListener("linguahub:learning-updated", render);
    document.addEventListener("visibilitychange", function () {
      // a new day (the word and the streak change at local midnight)
      if (!document.hidden && window.LinguaHubLearningStats && shownDay !== window.LinguaHubLearningStats.dayKey()) render();
    });
    modeSelect.addEventListener("change", applyVisibility);

    render();
    applyVisibility();
    return { render: render, openMode: openMode, applyVisibility: applyVisibility };
  }

  return { init: init, MODE_CARDS: MODE_CARDS };
})();

if (typeof window !== "undefined") {
  window.LinguaHubHome = LinguaHubHome;
}
