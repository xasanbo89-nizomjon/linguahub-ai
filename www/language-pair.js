// LinguaHub AI - the learner's language pair ("Uzbek -> English").
//
// from = the learner's native language, to = the language they are learning.
// Persisted, shared by the home screen and every learning workspace, and
// changeable from any of them (all selectors stay in step). The pair also
// decides which language is spoken / listened to (see voice.js speakText).

var LinguaHubLanguages = (function () {
  "use strict";

  var STORAGE_KEY = "linguahub-ai:language-pair";
  var DEFAULT_PAIR = { from: "uz", to: "en" };

  // speech = the BCP-47 tag handed to speech recognition / synthesis. These
  // are the same five languages www/voice.js already supports.
  var LANGUAGES = [
    { code: "en", name: "English", native: "English", speech: "en-US" },
    { code: "uz", name: "Uzbek", native: "O'zbekcha", speech: "uz-UZ" },
    { code: "ar", name: "Arabic", native: "العربية", speech: "ar-SA" },
    { code: "ru", name: "Russian", native: "Русский", speech: "ru-RU" },
    { code: "tr", name: "Turkish", native: "Türkçe", speech: "tr-TR" }
  ];

  function find(code) {
    for (var i = 0; i < LANGUAGES.length; i += 1) if (LANGUAGES[i].code === code) return LANGUAGES[i];
    return null;
  }

  function isLanguage(code) { return find(code) !== null; }
  function nameOf(code) { var l = find(code); return l ? l.name : String(code || ""); }
  function nativeNameOf(code) { var l = find(code); return l ? l.native : String(code || ""); }
  function speechLang(code) { var l = find(code); return l ? l.speech : "en-US"; }
  function isRtl(code) { return code === "ar"; }

  // Any input becomes a valid pair: unknown codes fall back to the defaults,
  // and the two languages are never the same.
  function normalizePair(raw) {
    var value = raw && typeof raw === "object" ? raw : {};
    var from = isLanguage(value.from) ? value.from : DEFAULT_PAIR.from;
    var to = isLanguage(value.to) ? value.to : DEFAULT_PAIR.to;
    if (from === to) {
      to = LANGUAGES.map(function (l) { return l.code; }).filter(function (c) { return c !== from; })[0];
    }
    return { from: from, to: to };
  }

  function create(options) {
    var storage = (options && options.storage) || (typeof window !== "undefined" ? window.localStorage : null);
    var listeners = [];
    var pair;

    function load() {
      try {
        return normalizePair(JSON.parse(storage.getItem(STORAGE_KEY) || "null"));
      } catch (err) {
        return normalizePair(null);
      }
    }
    pair = load();

    function emit() {
      var snapshot = { from: pair.from, to: pair.to };
      listeners.slice().forEach(function (cb) { try { cb(snapshot); } catch (err) { /* a listener must not break the pair */ } });
    }

    function save() {
      try { storage.setItem(STORAGE_KEY, JSON.stringify(pair)); } catch (err) { /* private mode: the pair still works for this session */ }
    }

    function set(next) {
      var normalized = normalizePair(next);
      if (normalized.from === pair.from && normalized.to === pair.to) return pair;
      pair = normalized;
      save();
      emit();
      return { from: pair.from, to: pair.to };
    }

    return {
      get: function () { return { from: pair.from, to: pair.to }; },
      set: set,
      // Choosing one side as the other side's language swaps instead of clashing.
      setFrom: function (code) {
        if (!isLanguage(code)) return pair;
        return set(code === pair.to ? { from: code, to: pair.from } : { from: code, to: pair.to });
      },
      setTo: function (code) {
        if (!isLanguage(code)) return pair;
        return set(code === pair.from ? { from: pair.to, to: code } : { from: pair.from, to: code });
      },
      swap: function () { return set({ from: pair.to, to: pair.from }); },
      onChange: function (cb) {
        listeners.push(cb);
        return function () { listeners = listeners.filter(function (x) { return x !== cb; }); };
      },
      reload: function () { pair = load(); emit(); }
    };
  }

  // ---- the shared selector control (DOM) -----------------------------------------------------

  // Builds "[ Uzbek v ]  <->  [ English v ]". Every control built from the
  // same pair object stays in step through onChange.
  function createControl(pairStore, options) {
    var opts = options || {};
    var wrap = document.createElement("div");
    wrap.className = "lang-pair" + (opts.className ? " " + opts.className : "");
    wrap.setAttribute("role", "group");
    wrap.setAttribute("aria-label", "Language pair");

    function build(label) {
      var select = document.createElement("select");
      select.className = "lang-pair-select";
      select.setAttribute("aria-label", label);
      LANGUAGES.forEach(function (l) {
        var option = document.createElement("option");
        option.value = l.code;
        option.textContent = l.name;
        select.appendChild(option);
      });
      return select;
    }

    var fromSelect = build("I speak");
    var toSelect = build("I am learning");
    var swapBtn = document.createElement("button");
    swapBtn.type = "button";
    swapBtn.className = "lang-pair-swap";
    swapBtn.setAttribute("aria-label", "Swap languages");
    swapBtn.setAttribute("title", "Swap languages");
    swapBtn.textContent = "⇄";

    wrap.appendChild(fromSelect);
    wrap.appendChild(swapBtn);
    wrap.appendChild(toSelect);

    function render(p) {
      fromSelect.value = p.from;
      toSelect.value = p.to;
    }
    render(pairStore.get());

    fromSelect.addEventListener("change", function () { pairStore.setFrom(fromSelect.value); render(pairStore.get()); });
    toSelect.addEventListener("change", function () { pairStore.setTo(toSelect.value); render(pairStore.get()); });
    swapBtn.addEventListener("click", function () { pairStore.swap(); });
    var unsubscribe = pairStore.onChange(render);

    return { el: wrap, destroy: unsubscribe };
  }

  return {
    LANGUAGES: LANGUAGES,
    DEFAULT_PAIR: DEFAULT_PAIR,
    STORAGE_KEY: STORAGE_KEY,
    isLanguage: isLanguage,
    nameOf: nameOf,
    nativeNameOf: nativeNameOf,
    speechLang: speechLang,
    isRtl: isRtl,
    normalizePair: normalizePair,
    create: create,
    createControl: createControl
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = LinguaHubLanguages;
}

if (typeof window !== "undefined") {
  window.LinguaHubLanguages = LinguaHubLanguages;
  // One shared pair for the whole app.
  try { window.linguahubPair = LinguaHubLanguages.create(); } catch (err) { /* no storage: workspaces create their own */ }
}
