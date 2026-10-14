// LinguaHub AI - the first screen for brand-new visitors.
//
// Shown once, on the first visit, and only when nobody is signed in and the
// device has no earlier LinguaHub data. A returning or signed-in person goes
// straight to the learning home. It shows:
//   - the logo and a large headline that types out "Learn English", "تعلّم العربية",
//     "Изучай русский", "O'zbek tilini o'rgan" (the Arabic one right-to-left),
//   - a live demo of a correction (plain CSS/JS - no API call),
//   - ONE real correction without signing in (POST /api/try-correct, limited per IP
//     on the server; this page also remembers that the free try was used),
//   - "Start free" (-> onboarding) and "Sign in with Google", and three feature cards.
// With prefers-reduced-motion nothing is animated: the headline is static and
// the demo shows its finished state.

var LinguaHubLanding = (function () {
  "use strict";

  var STORAGE_KEY = "linguahub-ai:landing";
  var TRY_KEY = "linguahub-ai:landing-try";
  var ONBOARDING_KEY = "linguahub-ai:onboarding";
  var PAIR_KEY = "linguahub-ai:language-pair";

  var PHRASES = [
    { text: "Learn English", lang: "en", dir: "ltr" },
    { text: "تعلّم العربية", lang: "ar", dir: "rtl" },
    { text: "Изучай русский", lang: "ru", dir: "ltr" },
    { text: "O'zbek tilini o'rgan", lang: "uz", dir: "ltr" }
  ];

  var TYPE_MS = 75;
  var HOLD_MS = 1700;
  var DELETE_MS = 38;
  var GAP_MS = 380;

  // when each demo step happens, in ms after the previous one (a full loop is about 7 s)
  var DEMO_STEPS = [900, 1300, 1300, 1300, 2200];
  var DEMO_LAST = 4;

  var DEMO = {
    note: "With “she” the verb takes -s, and days of the week use “on”.",
    translationLabel: "Uzbek",
    translation: "U dushanba kuni maktabga boradi."
  };

  var FEATURES = [
    { icon: "🎤", title: "Speak", text: "Practice out loud and get gentle feedback on every sentence." },
    { icon: "✍️", title: "Grammar fixes", text: "See every mistake, what it should be, and why." },
    { icon: "🗂️", title: "Flashcards", text: "Remember new words with spaced-repetition review." }
  ];

  // ---- pure helpers -------------------------------------------------------------------------

  function graphemes(text, win) {
    var scope = win || (typeof window !== "undefined" ? window : {});
    var Segmenter = (scope.Intl && scope.Intl.Segmenter) || (typeof Intl !== "undefined" ? Intl.Segmenter : null);
    if (Segmenter) {
      var out = [];
      var iterator = new Segmenter(undefined, { granularity: "grapheme" }).segment(text)[Symbol.iterator]();
      for (var next = iterator.next(); !next.done; next = iterator.next()) out.push(next.value.segment);
      return out;
    }
    return Array.from(text);
  }

  // The typing headline: types a phrase, holds it, deletes it, moves on, forever.
  // onFrame(visibleText, phrase, phraseIndex); schedule(fn, ms) -> handle.
  function createTyper(options) {
    var phrases = options.phrases;
    var schedule = options.schedule;
    var cancel = options.cancel;
    var index = 0;
    var parts = graphemes(phrases[0].text, options.window);
    var count = 0;
    var mode = "typing";
    var handle = null;
    var running = false;

    function frame() {
      options.onFrame(parts.slice(0, count).join(""), phrases[index], index);
    }

    function step() {
      handle = null;
      if (!running) return;
      var delay;
      if (mode === "typing") {
        count += 1;
        frame();
        if (count >= parts.length) { mode = "holding"; delay = HOLD_MS; } else delay = TYPE_MS;
      } else if (mode === "holding") {
        mode = "deleting";
        delay = DELETE_MS;
      } else if (mode === "deleting") {
        count -= 1;
        frame();
        if (count <= 0) { mode = "gap"; delay = GAP_MS; } else delay = DELETE_MS;
      } else {
        index = (index + 1) % phrases.length;
        parts = graphemes(phrases[index].text, options.window);
        mode = "typing";
        delay = TYPE_MS;
      }
      handle = schedule(step, delay);
    }

    return {
      start: function () { if (running) return; running = true; frame(); handle = schedule(step, TYPE_MS); },
      stop: function () { running = false; if (handle !== null) { cancel(handle); handle = null; } },
      // shows one phrase completely, with no animation
      showStatic: function (i) { index = i || 0; parts = graphemes(phrases[index].text, options.window); count = parts.length; frame(); }
    };
  }

  // The looping correction demo. Steps: 1 "go"->"goes", 2 "in"->"on", 3 the explanation, 4 the translation.
  function createDemoLoop(options) {
    var step = 0;
    var handle = null;
    var running = false;

    function show(n) {
      step = n;
      options.apply(n);
    }

    function advance() {
      handle = null;
      if (!running) return;
      var next = step >= DEMO_LAST ? 0 : step + 1;
      show(next);
      // after the last step the pause is DEMO_STEPS[DEMO_LAST]; resetting to 0 then starts the next lap
      handle = options.schedule(advance, next === 0 ? DEMO_STEPS[0] : DEMO_STEPS[next]);
    }

    return {
      start: function () { if (running) return; running = true; show(0); handle = options.schedule(advance, DEMO_STEPS[0]); },
      stop: function () { running = false; if (handle !== null) { options.cancel(handle); handle = null; } },
      showFinal: function () { show(DEMO_LAST); },
      step: function () { return step; }
    };
  }

  function readFlag(storage, key) {
    try { return storage.getItem(key) !== null; } catch (err) { return false; }
  }
  function writeFlag(storage, key, value) {
    try { storage.setItem(key, value || JSON.stringify({ at: Date.now() })); } catch (err) { /* private mode: it may show again */ }
  }

  // ---- the page -----------------------------------------------------------------------------

  function init(options) {
    var opts = options || {};
    var win = opts.window || window;
    var doc = opts.document || document;
    var storage = opts.storage !== undefined ? opts.storage : win.localStorage;
    var auth = opts.auth || null;
    var setTimer = opts.setTimeout || function (fn, ms) { return win.setTimeout(fn, ms); };
    var clearTimer = opts.clearTimeout || function (h) { win.clearTimeout(h); };
    var doFetch = opts.fetch || function (url, init2) { return win.fetch(url, init2); };
    var apiUrl = opts.apiUrl || function (path) { return win.LINGUAHUB_CONFIG && win.LINGUAHUB_CONFIG.apiUrl ? win.LINGUAHUB_CONFIG.apiUrl(path) : path; };
    var reducedMotion = opts.reducedMotion !== undefined ? opts.reducedMotion
      : Boolean(win.matchMedia && win.matchMedia("(prefers-reduced-motion: reduce)").matches);

    return new Promise(function (resolve) {
      var settled = false;
      var unsubscribe = null;

      function decide(user) {
        if (settled) return;
        settled = true;
        if (typeof unsubscribe === "function") unsubscribe();
        resolve(evaluate(user));
      }

      if (!auth || typeof auth.onAuthStateChanged !== "function") { decide(null); return; }
      var safety = setTimer(function () { decide(typeof auth.getCurrentUser === "function" ? auth.getCurrentUser() : null); }, 4000);
      unsubscribe = auth.onAuthStateChanged(function (user) { clearTimer(safety); decide(user); });
      if (settled && typeof unsubscribe === "function") unsubscribe();
    });

    // ---- should it show? ----
    function evaluate(user) {
      if (user) { writeFlag(storage, STORAGE_KEY); return { shown: false, reason: "signed-in" }; }
      if (readFlag(storage, STORAGE_KEY)) return { shown: false, reason: "returning" };
      var existing = readFlag(storage, ONBOARDING_KEY) || readFlag(storage, PAIR_KEY) || Boolean(opts.hasExistingData && opts.hasExistingData());
      if (existing) { writeFlag(storage, STORAGE_KEY); return { shown: false, reason: "existing-data" }; }
      writeFlag(storage, STORAGE_KEY); // the first visit: never again
      return show();
    }

    function show() {
      var el = function (tag, className, text) {
        var node = doc.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
      };
      var closed = false;
      var typer = null;
      var demo = null;
      var authWatch = null;
      var shell = opts.shell || null;

      var root = el("div", "landing");
      root.setAttribute("role", "region");
      root.setAttribute("aria-label", "Welcome to LinguaHub");
      root.setAttribute("tabindex", "-1");

      var inner = el("div", "landing-inner");
      root.appendChild(inner);

      // top: logo + name
      var top = el("div", "landing-top");
      if (win.LinguaHubLogo) {
        var logo = el("span", "landing-logo");
        logo.innerHTML = win.LinguaHubLogo.markup("lh-logo lh-logo-sm");
        top.appendChild(logo);
      }
      top.appendChild(el("span", "landing-brand", "LinguaHub"));
      inner.appendChild(top);

      // headline
      var hero = el("section", "landing-hero");
      var title = el("h1", "landing-headline");
      title.setAttribute("id", "landing-title");
      title.appendChild(el("span", "sr-only", "Learn English, Arabic, Russian or Uzbek"));
      var typed = el("span", "landing-typed");
      typed.setAttribute("aria-hidden", "true");
      // the blinking cursor is typed::after, so it sits at the logical END of the text:
      // on the left for right-to-left Arabic
      title.appendChild(typed);
      hero.appendChild(title);
      hero.appendChild(el("p", "landing-sub", "Write, speak and get corrected instantly by your AI tutor."));

      // demo card
      var card = el("div", "landing-demo");
      card.setAttribute("role", "group");
      card.setAttribute("aria-label", "Example: “She go to school in Monday.” is corrected to “She goes to school on Monday.” With “she” the verb takes -s, and days of the week use “on”. In Uzbek: “U dushanba kuni maktabga boradi.”");
      var visual = el("div", "landing-demo-visual");
      visual.setAttribute("aria-hidden", "true");
      var sentence = el("p", "demo-sentence");
      sentence.setAttribute("dir", "ltr");
      sentence.appendChild(doc.createTextNode("She "));
      var fixes = [["go", "goes"], ["in", "on"]].map(function (pairText) {
        var fix = el("span", "demo-fix");
        fix.appendChild(el("del", "demo-del", pairText[0]));
        fix.appendChild(el("ins", "demo-ins", pairText[1]));
        return fix;
      });
      sentence.appendChild(fixes[0]);
      sentence.appendChild(doc.createTextNode(" to school "));
      sentence.appendChild(fixes[1]);
      sentence.appendChild(doc.createTextNode(" Monday."));
      var note = el("p", "demo-note", DEMO.note);
      var translation = el("p", "demo-translation");
      translation.appendChild(el("span", "demo-translation-label", DEMO.translationLabel));
      translation.appendChild(doc.createTextNode(" "));
      translation.appendChild(el("span", "demo-translation-text", DEMO.translation));
      visual.appendChild(sentence);
      visual.appendChild(note);
      visual.appendChild(translation);
      card.appendChild(visual);
      hero.appendChild(card);

      // try it
      var form = el("form", "landing-try");
      form.setAttribute("novalidate", "novalidate");
      var label = el("label", "sr-only", "Write any sentence, in any language");
      label.setAttribute("for", "landing-try-input");
      var input = el("input", "landing-try-input");
      input.setAttribute("id", "landing-try-input");
      input.type = "text";
      input.setAttribute("maxlength", "300");
      input.setAttribute("placeholder", "Write any sentence, in any language");
      input.setAttribute("autocomplete", "off");
      input.setAttribute("dir", "auto");
      var check = el("button", "lh-btn lh-btn-primary landing-try-btn", "Check");
      check.type = "submit";
      form.appendChild(label);
      form.appendChild(input);
      form.appendChild(check);
      hero.appendChild(form);
      var result = el("div", "landing-result");
      result.setAttribute("aria-live", "polite");
      hero.appendChild(result);

      // buttons
      var actions = el("div", "landing-actions");
      var start = el("button", "lh-btn lh-btn-primary landing-start", "Start free");
      start.type = "button";
      var google = el("button", "lh-btn lh-btn-secondary landing-google", "Sign in with Google");
      google.type = "button";
      if (auth && typeof auth.isAvailable === "function" && !auth.isAvailable()) google.hidden = true; // sign-in is not configured
      actions.appendChild(start);
      actions.appendChild(google);
      hero.appendChild(actions);
      inner.appendChild(hero);

      // features
      var features = el("section", "landing-features");
      features.setAttribute("aria-label", "What you can do");
      FEATURES.forEach(function (feature) {
        var cardEl = el("article", "landing-card");
        var icon = el("span", "landing-card-icon", feature.icon);
        icon.setAttribute("aria-hidden", "true");
        cardEl.appendChild(icon);
        cardEl.appendChild(el("h2", "landing-card-title", feature.title));
        cardEl.appendChild(el("p", "landing-card-text", feature.text));
        features.appendChild(cardEl);
      });
      inner.appendChild(features);

      // ---- behaviour ----
      function close(reason) {
        if (closed) return;
        closed = true;
        if (typer) typer.stop();
        if (demo) demo.stop();
        if (typeof authWatch === "function") authWatch();
        root.remove();
        if (shell) { shell.inert = false; shell.removeAttribute("aria-hidden"); }
        if (doc.documentElement && doc.documentElement.removeAttribute) doc.documentElement.removeAttribute("data-landing");
        if (typeof opts.onDone === "function") opts.onDone({ reason: reason });
      }

      start.addEventListener("click", function () { close("start"); });
      google.addEventListener("click", function () { close("google"); });

      function signupPrompt(kind) {
        var existing = result.querySelector ? result.querySelector(".landing-signup") : null;
        if (existing) existing.remove();
        var box = el("div", "landing-signup");
        box.appendChild(el("p", "landing-signup-title", kind === "limit" ? "You've used today's free try." : "Like it? Keep going for free."));
        box.appendChild(el("p", "landing-signup-text", "Create a free account to check as much as you like, practise speaking and save new words."));
        var row = el("div", "landing-actions");
        var again = el("button", "lh-btn lh-btn-primary landing-signup-start", "Start free");
        again.type = "button";
        again.addEventListener("click", function () { close("start"); });
        row.appendChild(again);
        if (!google.hidden) {
          var withGoogle = el("button", "lh-btn lh-btn-secondary landing-signup-google", "Sign in with Google");
          withGoogle.type = "button";
          withGoogle.addEventListener("click", function () { close("google"); });
          row.appendChild(withGoogle);
        }
        box.appendChild(row);
        result.appendChild(box);
      }

      function ensureDiff() {
        if (win.LinguaHubGrammarDiff) return Promise.resolve(win.LinguaHubGrammarDiff);
        return new Promise(function (resolveDiff, rejectDiff) {
          var script = doc.createElement("script");
          script.src = "grammar-diff.js";
          script.onload = function () { win.LinguaHubGrammarDiff ? resolveDiff(win.LinguaHubGrammarDiff) : rejectDiff(new Error("diff")); };
          script.onerror = function () { rejectDiff(new Error("diff")); };
          (doc.head || doc.body).appendChild(script);
        });
      }

      function renderCorrection(text, data, Diff) {
        result.textContent = "";
        var edits = Diff.normalize ? (Diff.normalize({ corrected: data.corrected, edits: data.edits }, text) || { edits: [] }).edits : data.edits;
        var line = el("p", "landing-corrected");
        line.setAttribute("dir", "auto");
        if (!edits.length) {
          line.appendChild(doc.createTextNode(text));
          result.appendChild(el("p", "landing-result-title", "No mistakes found — nice writing!"));
          result.appendChild(line);
          return;
        }
        result.appendChild(el("p", "landing-result-title", edits.length === 1 ? "1 correction" : edits.length + " corrections"));
        var built = Diff.buildSegments(text, edits);
        built.segments.forEach(function (segment) {
          if (segment.type === "text") { line.appendChild(doc.createTextNode(segment.text)); return; }
          var fix = el("span", "landing-fix");
          if (segment.edit.original) fix.appendChild(el("del", "landing-del", segment.edit.original));
          if (segment.edit.correction) fix.appendChild(el("ins", "landing-ins", segment.edit.correction));
          line.appendChild(fix);
        });
        result.appendChild(line);
        var list = el("ul", "landing-explain");
        edits.forEach(function (edit) {
          var item = el("li");
          item.appendChild(el("del", "landing-del", edit.original));
          item.appendChild(doc.createTextNode(" → "));
          item.appendChild(el("ins", "landing-ins", edit.correction || "(remove)"));
          if (edit.explanation) item.appendChild(doc.createTextNode(" — " + edit.explanation));
          list.appendChild(item);
        });
        result.appendChild(list);
      }

      var busy = false;
      form.addEventListener("submit", async function (event) {
        event.preventDefault();
        var text = input.value.trim();
        if (!text || busy) { if (!text) input.focus(); return; }
        if (readFlag(storage, TRY_KEY)) { result.textContent = ""; signupPrompt("limit"); return; }
        busy = true;
        check.disabled = true;
        check.textContent = "Checking…";
        result.textContent = "";
        try {
          var response = await doFetch(apiUrl("/api/try-correct"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: text }) });
          if (response.status === 429) {
            writeFlag(storage, TRY_KEY, "1");
            signupPrompt("limit");
          } else if (!response.ok) {
            result.appendChild(el("p", "landing-error", response.status === 400 ? "Write a short sentence (up to 300 characters) and try again." : "Couldn't check that right now. Please try again in a moment."));
          } else {
            var body = await response.json();
            var Diff = await ensureDiff();
            if (!body || !body.result) throw new Error("bad-reply");
            renderCorrection(text, body.result, Diff);
            writeFlag(storage, TRY_KEY, "1");
            signupPrompt("after");
          }
        } catch (err) {
          result.textContent = "";
          result.appendChild(el("p", "landing-error", "Couldn't check that right now. Please try again in a moment."));
        } finally {
          busy = false;
          check.disabled = false;
          check.textContent = "Check";
        }
      });

      // animations (or their finished state)
      function setPhrase(text, phrase) {
        typed.textContent = text;
        typed.setAttribute("lang", phrase.lang);
        typed.setAttribute("dir", phrase.dir);
      }
      function applyDemo(n) {
        fixes[0].classList.toggle("is-on", n >= 1);
        fixes[1].classList.toggle("is-on", n >= 2);
        note.classList.toggle("is-on", n >= 3);
        translation.classList.toggle("is-on", n >= 4);
        card.setAttribute("data-step", String(n));
      }
      var timers = { schedule: setTimer, cancel: clearTimer };
      typer = createTyper({ phrases: PHRASES, schedule: timers.schedule, cancel: timers.cancel, window: win, onFrame: setPhrase });
      demo = createDemoLoop({ schedule: timers.schedule, cancel: timers.cancel, apply: applyDemo });
      if (reducedMotion) {
        root.setAttribute("data-motion", "reduced");
        typer.showStatic(0);
        demo.showFinal();
      } else {
        typer.start();
        demo.start();
      }

      // put it on the page; the app behind it is switched off until it is dismissed
      if (shell) { shell.inert = true; shell.setAttribute("aria-hidden", "true"); }
      if (doc.documentElement && doc.documentElement.setAttribute) doc.documentElement.setAttribute("data-landing", "");
      doc.body.appendChild(root);
      if (typeof root.focus === "function") root.focus();

      // signing in (a popup, or a slow session restore) while this is open: step aside
      if (auth && typeof auth.onAuthStateChanged === "function") {
        authWatch = auth.onAuthStateChanged(function (user) { if (user) close("signed-in"); });
      }

      return { shown: true, reason: "first-visit", close: close, root: root };
    }
  }

  return {
    init: init,
    createTyper: createTyper,
    createDemoLoop: createDemoLoop,
    graphemes: graphemes,
    PHRASES: PHRASES,
    FEATURES: FEATURES,
    DEMO: DEMO,
    DEMO_STEPS: DEMO_STEPS,
    STORAGE_KEY: STORAGE_KEY,
    TRY_KEY: TRY_KEY
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = LinguaHubLanding;
}

if (typeof window !== "undefined") {
  window.LinguaHubLanding = LinguaHubLanding;
}
