// LinguaHub AI - first-launch onboarding: three short screens.
//   1. your native language   2. the language you want to learn   3. your level
// The answers go into the language pair (www/language-pair.js, which the home,
// Translate, Speak and Grammar all read) and into the learning settings
// (www/learning-memory.js: `level`). Skip is on every screen; Esc skips too.
// Finishing or skipping is remembered on this device, so it is never shown
// again. It never blocks anything: skipped = the defaults stay.

var LinguaHubOnboarding = (function () {
  "use strict";

  var STORAGE_KEY = "linguahub-ai:onboarding";
  var LEVELS = [
    { id: "beginner", label: "Beginner", description: "I know a few words and phrases." },
    { id: "intermediate", label: "Intermediate", description: "I can hold a simple conversation." },
    { id: "advanced", label: "Advanced", description: "I'm comfortable and want to polish." }
  ];

  function isDone(storage) {
    try {
      var raw = storage.getItem(STORAGE_KEY);
      return Boolean(raw && JSON.parse(raw).done === true);
    } catch (err) {
      // unreadable value: do not nag again and again either
      try { return Boolean(storage.getItem(STORAGE_KEY)); } catch (err2) { return false; }
    }
  }

  function markDone(storage, skipped) {
    try { storage.setItem(STORAGE_KEY, JSON.stringify({ done: true, skipped: Boolean(skipped), at: Date.now() })); } catch (err) { /* private mode: it may show again next launch */ }
  }

  function init(options) {
    var opts = options || {};
    var doc = opts.document || document;
    var storage = opts.storage !== undefined ? opts.storage : (typeof window !== "undefined" ? window.localStorage : null);
    var pair = opts.pair;
    var memory = opts.memory !== undefined ? opts.memory : (typeof window !== "undefined" ? window.LinguaHubLearningMemory : null);
    var Lang = opts.languages || (typeof window !== "undefined" ? window.LinguaHubLanguages : null);
    if (!pair || !Lang || !storage) return { shown: false };
    if (isDone(storage) && !opts.force) return { shown: false };

    var current = pair.get();
    var answers = { from: current.from, to: current.to, level: "beginner" };
    var step = 0;
    var previouslyFocused = doc.activeElement;

    var backdrop = doc.createElement("div");
    backdrop.className = "lh-dialog-backdrop onboarding-backdrop";
    var dialog = doc.createElement("div");
    dialog.className = "lh-dialog onboarding";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "onboarding-title");
    backdrop.appendChild(dialog);

    function el(tag, className, text) {
      var node = doc.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }

    function finish(skipped) {
      if (!skipped) {
        pair.set({ from: answers.from, to: answers.to });
        if (memory && typeof memory.get === "function" && typeof memory.save === "function") {
          try { memory.save(Object.assign({}, memory.get(), { level: answers.level })); } catch (err) { /* the level is optional */ }
        }
      }
      markDone(storage, skipped);
      doc.removeEventListener("keydown", onKeydown, true);
      backdrop.remove();
      if (previouslyFocused && typeof previouslyFocused.focus === "function") previouslyFocused.focus();
      if (typeof opts.onDone === "function") opts.onDone({ skipped: Boolean(skipped), answers: skipped ? null : Object.assign({}, answers) });
    }

    function languageChoices(name, selected, exclude, onPick) {
      var group = el("div", "onboarding-choices");
      group.setAttribute("role", "radiogroup");
      group.setAttribute("aria-labelledby", "onboarding-title");
      Lang.LANGUAGES.forEach(function (language) {
        if (language.code === exclude) return;
        group.appendChild(choice(name, language.code, language.name, language.native !== language.name ? language.native : "", language.code === selected, function () { onPick(language.code); }, language.code === "ar"));
      });
      return group;
    }

    function choice(name, value, label, hint, checked, onPick, rtlHint) {
      var wrap = el("label", "onboarding-choice");
      var input = el("input", "onboarding-radio");
      input.type = "radio";
      input.name = name;
      input.value = value;
      input.checked = checked;
      input.addEventListener("change", function () { if (input.checked) onPick(); });
      var text = el("span", "onboarding-choice-text");
      text.appendChild(el("span", "onboarding-choice-label", label));
      if (hint) {
        var hintEl = el("span", "onboarding-choice-hint", hint);
        if (rtlHint) hintEl.setAttribute("dir", "auto");
        text.appendChild(hintEl);
      }
      wrap.appendChild(input);
      wrap.appendChild(text);
      return wrap;
    }

    var SCREENS = [
      function nativeScreen() {
        return {
          title: "What is your native language?",
          hint: "Explanations and translations will be in this language.",
          body: languageChoices("onboarding-from", answers.from, null, function (code) {
            answers.from = code;
            if (answers.to === code) answers.to = Lang.LANGUAGES.filter(function (l) { return l.code !== code; })[0].code;
          })
        };
      },
      function learnScreen() {
        if (answers.to === answers.from) answers.to = Lang.LANGUAGES.filter(function (l) { return l.code !== answers.from; })[0].code;
        return {
          title: "Which language do you want to learn?",
          hint: "You can change this any time on the home screen.",
          body: languageChoices("onboarding-to", answers.to, answers.from, function (code) { answers.to = code; })
        };
      },
      function levelScreen() {
        var group = el("div", "onboarding-choices");
        group.setAttribute("role", "radiogroup");
        group.setAttribute("aria-labelledby", "onboarding-title");
        LEVELS.forEach(function (level) {
          group.appendChild(choice("onboarding-level", level.id, level.label, level.description, level.id === answers.level, function () { answers.level = level.id; }));
        });
        return { title: "What is your level in " + Lang.nameOf(answers.to) + "?", hint: "The tutor adapts its words and explanations to it.", body: group };
      }
    ];

    function render() {
      dialog.textContent = "";
      var screen = SCREENS[step]();
      var progress = el("p", "onboarding-progress", "Step " + (step + 1) + " of " + SCREENS.length);
      progress.setAttribute("aria-live", "polite");
      var dots = el("div", "onboarding-dots");
      dots.setAttribute("aria-hidden", "true");
      SCREENS.forEach(function (unused, index) { dots.appendChild(el("span", "onboarding-dot" + (index === step ? " is-active" : ""))); });
      var title = el("h2", "lh-dialog-title onboarding-title", screen.title);
      title.setAttribute("id", "onboarding-title");
      dialog.appendChild(dots);
      dialog.appendChild(progress);
      dialog.appendChild(title);
      dialog.appendChild(el("p", "lh-dialog-message", screen.hint));
      dialog.appendChild(screen.body);

      var actions = el("div", "lh-dialog-actions onboarding-actions");
      var skip = el("button", "lh-btn lh-btn-secondary onboarding-skip", "Skip");
      skip.type = "button";
      skip.addEventListener("click", function () { finish(true); });
      actions.appendChild(skip);
      if (step > 0) {
        var back = el("button", "lh-btn lh-btn-secondary onboarding-back", "Back");
        back.type = "button";
        back.addEventListener("click", function () { step -= 1; render(); });
        actions.appendChild(back);
      }
      var last = step === SCREENS.length - 1;
      var next = el("button", "lh-btn lh-btn-primary onboarding-next", last ? "Get started" : "Next");
      next.type = "button";
      next.addEventListener("click", function () { if (last) finish(false); else { step += 1; render(); } });
      actions.appendChild(next);
      dialog.appendChild(actions);

      var checked = dialog.querySelector(".onboarding-radio");
      var radios = dialog.querySelectorAll(".onboarding-radio");
      var focusTarget = null;
      Array.prototype.forEach.call(radios, function (r) { if (r.checked) focusTarget = r; });
      (focusTarget || checked || next).focus();
    }

    function onKeydown(event) {
      if (event.key === "Escape") { event.preventDefault(); finish(true); return; }
      if (event.key === "Tab") {
        var focusable = Array.prototype.slice.call(dialog.querySelectorAll("button, input"));
        if (!focusable.length) return;
        var first = focusable[0];
        var lastEl = focusable[focusable.length - 1];
        if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); lastEl.focus(); }
        else if (!event.shiftKey && doc.activeElement === lastEl) { event.preventDefault(); first.focus(); }
      }
    }

    doc.addEventListener("keydown", onKeydown, true);
    doc.body.appendChild(backdrop);
    render();
    return { shown: true, backdrop: backdrop, finish: finish };
  }

  return { init: init, isDone: isDone, STORAGE_KEY: STORAGE_KEY, LEVELS: LEVELS };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = LinguaHubOnboarding;
}

if (typeof window !== "undefined") {
  window.LinguaHubOnboarding = LinguaHubOnboarding;
}
