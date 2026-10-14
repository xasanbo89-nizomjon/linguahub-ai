// LinguaHub AI - Vocabulary workspace: the learner's saved words and a
// flashcard review with spaced repetition.
//
//   Words   - search, language filter, listen, delete (with Undo), and
//             "Suggest words" for a topic (the AI proposes, the learner adds).
//   Review  - the words due today, one card at a time: flip, then answer
//             Again / Hard / Good / Easy. Each button shows when the word
//             will come back. "Again" cards return at the end of the session.

(function () {
  "use strict";

  var SESSION_MAX = 50;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function intervalLabel(days) {
    if (days <= 0) return "10 min";
    if (days === 1) return "1 day";
    if (days < 30) return days + " days";
    if (days < 365) return Math.round(days / 30) + (Math.round(days / 30) === 1 ? " month" : " months");
    return Math.round(days / 365) + (Math.round(days / 365) === 1 ? " year" : " years");
  }

  function create(api) {
    var vocab = api.vocab;
    var pair = api.pair;
    if (!vocab) {
      var unavailable = el("p", "ws-note", "Saving words isn't available in this browser.");
      api.panel.appendChild(unavailable);
      return { activate: function () {}, deactivate: function () {} };
    }
    var Lang = window.LinguaHubLanguages;
    var AI = window.LinguaHubAI;
    var Store = window.LinguaHubVocab;

    var root = el("div", "ws ws-vocab");
    var tab = "words";
    var filter = { query: "", lang: "all" };
    var queue = [];
    var sessionTotal = 0;
    var flipped = false;
    var recorded = false;
    var suggestController = null;
    var unsubscribe = null;
    var active = false;

    // ---- tabs ----
    var tabs = el("div", "vocab-tabs");
    tabs.setAttribute("role", "tablist");
    var tabButtons = {};
    [["words", "Words"], ["review", "Review"]].forEach(function (pairDef) {
      var button = el("button", "vocab-tab", pairDef[1]);
      button.type = "button";
      button.setAttribute("role", "tab");
      button.setAttribute("data-tab", pairDef[0]);
      button.addEventListener("click", function () { setTab(pairDef[0]); });
      button.addEventListener("keydown", function (event) {
        if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
          event.preventDefault();
          var next = pairDef[0] === "words" ? "review" : "words";
          setTab(next);
          tabButtons[next].focus();
        }
      });
      tabButtons[pairDef[0]] = button;
      tabs.appendChild(button);
    });
    var dueBadge = el("span", "vocab-due-badge");
    tabButtons.review.appendChild(dueBadge);
    root.appendChild(tabs);

    var wordsPanel = el("div", "vocab-panel vocab-words");
    wordsPanel.setAttribute("role", "tabpanel");
    var reviewPanel = el("div", "vocab-panel vocab-review");
    reviewPanel.setAttribute("role", "tabpanel");
    root.appendChild(wordsPanel);
    root.appendChild(reviewPanel);
    api.panel.appendChild(root);

    // ---- Words tab ----
    var controls = el("div", "ws-toolbar vocab-controls");
    var search = el("input", "vocab-search");
    search.type = "search";
    search.setAttribute("placeholder", "Search your words");
    search.setAttribute("aria-label", "Search your words");
    search.setAttribute("autocomplete", "off");
    var langSelect = el("select", "lang-pair-select vocab-lang");
    langSelect.setAttribute("aria-label", "Filter by language");
    var count = el("span", "ws-note vocab-count");
    count.setAttribute("role", "status");
    controls.appendChild(search);
    controls.appendChild(langSelect);
    controls.appendChild(count);

    var suggest = el("section", "ws-pane vocab-suggest");
    suggest.setAttribute("aria-label", "Suggest words");
    var suggestRow = el("div", "vocab-suggest-row");
    var topic = el("input", "vocab-topic");
    topic.type = "text";
    topic.setAttribute("placeholder", "Suggest words about… (e.g. travel, food)");
    topic.setAttribute("aria-label", "Topic for suggested words");
    topic.setAttribute("maxlength", "60");
    var suggestBtn = el("button", "lh-btn lh-btn-secondary vocab-suggest-btn", "Suggest words");
    suggestBtn.type = "button";
    suggestRow.appendChild(topic);
    suggestRow.appendChild(suggestBtn);
    var suggestOut = el("ul", "vocab-suggestions");
    suggestOut.hidden = true;
    var suggestStatus = el("p", "ws-note vocab-suggest-status");
    suggestStatus.setAttribute("role", "status");
    suggest.appendChild(suggestRow);
    suggest.appendChild(suggestStatus);
    suggest.appendChild(suggestOut);

    var list = el("ul", "vocab-list");
    var empty = el("div", "vocab-empty");
    wordsPanel.appendChild(controls);
    wordsPanel.appendChild(suggest);
    wordsPanel.appendChild(list);
    wordsPanel.appendChild(empty);

    function speakWord(word) {
      if (window.LinguaHubVoice && window.LinguaHubVoice.speakText) window.LinguaHubVoice.speakText(word.word, Lang.speechLang(word.lang));
    }

    function fillLanguageOptions() {
      var previous = filter.lang;
      langSelect.textContent = "";
      var all = el("option", "", "All languages");
      all.value = "all";
      langSelect.appendChild(all);
      vocab.languages().forEach(function (code) {
        var option = el("option", "", Lang.nameOf(code));
        option.value = code;
        langSelect.appendChild(option);
      });
      var stillThere = previous === "all" || vocab.languages().indexOf(previous) !== -1;
      filter.lang = stillThere ? previous : "all";
      langSelect.value = filter.lang;
    }

    function buildWordRow(word) {
      var item = el("li", "vocab-item");
      item.setAttribute("data-id", word.id);
      var text = el("div", "vocab-item-text");
      var title = el("div", "vocab-item-word", word.word);
      title.setAttribute("dir", "auto");
      title.setAttribute("lang", word.lang);
      var meaning = el("div", "vocab-item-translation", word.translation);
      meaning.setAttribute("dir", "auto");
      text.appendChild(title);
      text.appendChild(meaning);
      if (word.partOfSpeech) text.appendChild(el("div", "vocab-item-pos", word.partOfSpeech));
      if (word.example) {
        var example = el("div", "vocab-item-example", word.example);
        example.setAttribute("dir", "auto");
        text.appendChild(example);
      }
      item.appendChild(text);

      var actions = el("div", "vocab-item-actions");
      var listen = el("button", "ws-icon-btn voice-feature vocab-listen", "🔊");
      listen.type = "button";
      listen.setAttribute("aria-label", "Listen to " + word.word);
      listen.addEventListener("click", function () { speakWord(word); });
      var del = el("button", "ws-icon-btn vocab-delete", "🗑");
      del.type = "button";
      del.setAttribute("aria-label", "Delete " + word.word);
      del.setAttribute("title", "Delete");
      del.addEventListener("click", function () { deleteWord(word); });
      actions.appendChild(listen);
      actions.appendChild(del);
      item.appendChild(actions);
      return item;
    }

    function deleteWord(word) {
      var result = vocab.remove(word.id);
      if (!result.ok) return;
      if (window.LinguaHubToast) {
        window.LinguaHubToast.show({
          type: "info",
          message: "Deleted “" + word.word + "”.",
          duration: 6000,
          action: { label: "Undo", onClick: function () { vocab.restore(result.word); } }
        });
      }
    }

    function renderWords() {
      fillLanguageOptions();
      updateBadge();
      var words = vocab.list({ query: filter.query, lang: filter.lang });
      var total = vocab.stats().total;
      list.textContent = "";
      words.forEach(function (word) { list.appendChild(buildWordRow(word)); });
      list.hidden = words.length === 0;
      count.textContent = total === 0 ? "" : (words.length === total ? total + (total === 1 ? " word" : " words") : words.length + " of " + total);
      empty.textContent = "";
      empty.hidden = words.length > 0;
      if (words.length === 0) {
        if (total === 0) {
          empty.appendChild(el("p", "vocab-empty-title", "No saved words yet"));
          empty.appendChild(el("p", "ws-note", "Tap any word in an AI message and choose “Save to vocabulary”, or ask for suggestions above."));
        } else {
          empty.appendChild(el("p", "vocab-empty-title", "No words match"));
          empty.appendChild(el("p", "ws-note", "Try a different search or language."));
        }
      }
    }

    search.addEventListener("input", function () { filter.query = search.value; renderWords(); });
    langSelect.addEventListener("change", function () { filter.lang = langSelect.value; renderWords(); });

    // ---- suggestions ----
    function suggestionRow(entry, lang) {
      var item = el("li", "vocab-suggestion");
      var text = el("div", "vocab-item-text");
      var title = el("div", "vocab-item-word", entry.word);
      title.setAttribute("dir", "auto");
      var meaning = el("div", "vocab-item-translation", entry.translation);
      meaning.setAttribute("dir", "auto");
      text.appendChild(title);
      text.appendChild(meaning);
      if (entry.example) {
        var example = el("div", "vocab-item-example", entry.example);
        example.setAttribute("dir", "auto");
        text.appendChild(example);
      }
      item.appendChild(text);
      var saved = vocab.has(entry.word, lang);
      var add = el("button", "lh-btn lh-btn-secondary vocab-add", saved ? "Saved" : "Add");
      add.type = "button";
      add.disabled = saved;
      add.setAttribute("aria-label", (saved ? "Saved: " : "Add ") + entry.word);
      add.addEventListener("click", function () {
        var result = vocab.add({ word: entry.word, translation: entry.translation, lang: lang, partOfSpeech: entry.partOfSpeech, example: entry.example });
        if (result.ok) { add.textContent = "Saved"; add.disabled = true; }
        else if (window.LinguaHubToast) window.LinguaHubToast.show({ type: "error", message: result.reason === "word-limit-reached" ? "Your vocabulary is full. Delete a word to add more." : "Couldn't save that word." });
      });
      item.appendChild(add);
      return item;
    }

    async function suggestWords() {
      var subject = topic.value.trim();
      if (!subject) { topic.focus(); return; }
      if (suggestController) suggestController.abort();
      suggestController = typeof AbortController === "function" ? new AbortController() : null;
      var lang = pair.get().to;
      suggestBtn.disabled = true;
      suggestStatus.textContent = "Finding words…";
      suggestOut.hidden = true;
      suggestOut.textContent = "";
      try {
        var answer = await AI.request({
          mode: "vocabulary",
          messages: [{ role: "user", content: AI.prompts.vocabulary(pair.get(), subject) }],
          signal: suggestController ? suggestController.signal : undefined,
          normalize: AI.normalizeWords
        });
        if (!answer.data) throw Object.assign(new Error("unreadable"), { userMessage: AI.describeError({ status: 502 }) });
        answer.data.words.forEach(function (entry) { suggestOut.appendChild(suggestionRow(entry, lang)); });
        suggestOut.hidden = false;
        suggestStatus.textContent = "Words in " + Lang.nameOf(lang) + " about “" + subject + "”";
        if (!recorded) { recorded = true; document.dispatchEvent(new CustomEvent("linguahub:activity")); }
      } catch (err) {
        if (err && err.aborted) return;
        suggestStatus.textContent = err && err.userMessage ? err.userMessage : AI.describeError(err);
      } finally {
        suggestBtn.disabled = false;
      }
    }
    suggestBtn.addEventListener("click", suggestWords);
    topic.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); suggestWords(); }
    });

    // ---- Review tab ----
    function startSession() {
      queue = vocab.due().slice(0, SESSION_MAX).map(function (w) { return w.id; });
      sessionTotal = queue.length;
      flipped = false;
      renderReview();
    }

    function currentWord() {
      while (queue.length) {
        var word = vocab.get(queue[0]);
        if (word) return word;
        queue.shift(); // deleted meanwhile
      }
      return null;
    }

    function answer(grade) {
      var word = currentWord();
      if (!word || !flipped) return;
      var result = vocab.review(word.id, grade);
      if (!result.ok) return;
      queue.shift();
      if (grade === "again") queue.push(word.id); // see it again before the session ends
      flipped = false;
      if (!recorded) { recorded = true; document.dispatchEvent(new CustomEvent("linguahub:activity")); }
      renderReview();
    }

    function renderReview() {
      reviewPanel.textContent = "";
      var word = currentWord();
      var stats = vocab.stats();

      if (!word) {
        var done = el("div", "vocab-done");
        var reviewed = sessionTotal;
        done.appendChild(el("p", "vocab-empty-title", stats.total === 0 ? "Nothing to review yet" : reviewed > 0 ? "All done for today" : "Nothing is due today"));
        done.appendChild(el("p", "ws-note", stats.total === 0
          ? "Save some words first, then come back to review them."
          : reviewed > 0 ? "You reviewed " + reviewed + (reviewed === 1 ? " word." : " words.") + " They will come back when they are due."
            : "Your next words will show up here when they are due."));
        var back = el("button", "lh-btn lh-btn-secondary vocab-to-words", "View my words");
        back.type = "button";
        back.addEventListener("click", function () { setTab("words"); });
        done.appendChild(back);
        reviewPanel.appendChild(done);
        updateBadge();
        return;
      }

      var position = sessionTotal - queue.length + 1;
      var progress = el("p", "vocab-progress", Math.min(position, sessionTotal) + " / " + sessionTotal);
      progress.setAttribute("role", "status");
      reviewPanel.appendChild(progress);

      var card = el("div", "flashcard" + (flipped ? " is-flipped" : ""));
      card.setAttribute("tabindex", "0");
      card.setAttribute("role", "button");
      card.setAttribute("aria-label", flipped ? "Card: " + word.word + " means " + word.translation + ". Press to hide the answer" : "Card: " + word.word + ". Press to show the answer");
      var front = el("div", "flashcard-word", word.word);
      front.setAttribute("dir", "auto");
      front.setAttribute("lang", word.lang);
      card.appendChild(front);
      var listen = el("button", "ws-icon-btn voice-feature flashcard-listen", "🔊");
      listen.type = "button";
      listen.setAttribute("aria-label", "Listen to " + word.word);
      listen.addEventListener("click", function (event) { event.stopPropagation(); speakWord(word); });
      card.appendChild(listen);

      if (flipped) {
        var back2 = el("div", "flashcard-back");
        var meaning = el("div", "flashcard-translation", word.translation);
        meaning.setAttribute("dir", "auto");
        back2.appendChild(meaning);
        if (word.partOfSpeech) back2.appendChild(el("div", "vocab-item-pos", word.partOfSpeech));
        if (word.example) {
          var example = el("div", "vocab-item-example", word.example);
          example.setAttribute("dir", "auto");
          back2.appendChild(example);
          if (word.exampleTranslation) {
            var exampleTr = el("div", "vocab-item-example-tr", word.exampleTranslation);
            exampleTr.setAttribute("dir", "auto");
            back2.appendChild(exampleTr);
          }
        }
        card.appendChild(back2);
      } else {
        card.appendChild(el("div", "flashcard-hint", "Tap to show the answer"));
      }
      function flip() { flipped = !flipped; renderReview(); focusCard(); }
      card.addEventListener("click", flip);
      card.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); flip(); }
      });
      reviewPanel.appendChild(card);

      var grades = el("div", "flashcard-grades");
      grades.hidden = !flipped;
      var preview = Store.previewIntervals(word.srs);
      [["again", "Again"], ["hard", "Hard"], ["good", "Good"], ["easy", "Easy"]].forEach(function (g, index) {
        var button = el("button", "flashcard-grade", "");
        button.type = "button";
        button.setAttribute("data-grade", g[0]);
        button.setAttribute("aria-label", g[1] + ", next review in " + intervalLabel(preview[g[0]]));
        button.appendChild(el("span", "flashcard-grade-label", g[1]));
        button.appendChild(el("span", "flashcard-grade-interval", intervalLabel(preview[g[0]])));
        button.setAttribute("title", "Shortcut: " + (index + 1));
        button.addEventListener("click", function () { answer(g[0]); });
        grades.appendChild(button);
      });
      reviewPanel.appendChild(grades);
      updateBadge();
    }

    function focusCard() {
      var card = reviewPanel.querySelector(".flashcard");
      if (card && card.focus) card.focus();
    }

    function updateBadge() {
      var due = vocab.stats().due;
      dueBadge.textContent = due > 0 ? String(due) : "";
      dueBadge.hidden = due === 0;
      tabButtons.review.setAttribute("aria-label", due > 0 ? "Review, " + due + " due today" : "Review");
    }

    // keys 1-4 answer while a card is flipped (only while this screen is open)
    document.addEventListener("keydown", function (event) {
      if (!active || tab !== "review" || !flipped) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      var target = event.target;
      if (target && (target.tag === "input" || target.tag === "textarea" || target.tag === "select")) return;
      var grade = { "1": "again", "2": "hard", "3": "good", "4": "easy" }[event.key];
      if (grade) { event.preventDefault(); answer(grade); }
    });

    // ---- switching ----
    function setTab(next) {
      tab = next === "review" ? "review" : "words";
      Object.keys(tabButtons).forEach(function (id) {
        var on = id === tab;
        tabButtons[id].classList.toggle("is-active", on);
        tabButtons[id].setAttribute("aria-selected", String(on));
        tabButtons[id].setAttribute("tabindex", on ? "0" : "-1");
      });
      wordsPanel.hidden = tab !== "words";
      reviewPanel.hidden = tab !== "review";
      if (tab === "review") startSession(); else renderWords();
    }

    function onStoreChange(event) {
      if (!active) return;
      updateBadge();
      if (tab === "words") renderWords();
      else if (event && (event.type === "remote" || event.type === "namespace")) startSession();
    }

    return {
      activate: function (options) {
        active = true;
        if (!unsubscribe) unsubscribe = vocab.subscribe(onStoreChange);
        setTab(options && options.tab === "review" ? "review" : "words");
        if (tab === "review") focusCard(); else search.focus();
      },
      deactivate: function () {
        active = false;
        if (suggestController) { suggestController.abort(); suggestController = null; }
        if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      },
      _setTab: setTab
    };
  }

  if (window.LinguaHubWorkspace) window.LinguaHubWorkspace.register("vocabulary", create);
})();
