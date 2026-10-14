// LinguaHub AI - tap a word in an AI message to see what it means: a small
// popover with the translation, part of speech, one example, a listen button
// and "Save to vocabulary". Works for right-to-left text (Arabic) because the
// word is found from the text node under the pointer, not from the layout.
// Lookups use the internal "word-lookup" mode and are cached (memory + local
// storage), so tapping the same word again costs nothing.

(function (root, factory) {
  var api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.LinguaHubWordLookup = api;
})(typeof window !== "undefined" ? window : this, function (root) {
  "use strict";

  var CACHE_KEY = "linguahub-ai:lookup-cache";
  var CACHE_MAX = 200;
  var WORD_MAX = 60;
  var WORD_CHARS = /[\p{L}\p{M}\p{N}'’ʼ\-]/u;

  // ---- finding the word ----

  function isWordChar(ch) {
    return !!ch && WORD_CHARS.test(ch);
  }

  // The word that contains (or touches) `offset` in `text`, or "" on spaces
  // and punctuation. Quotes and hyphens at the edges are trimmed.
  function wordAt(text, offset) {
    text = String(text || "");
    if (!text) return "";
    var pos = Math.max(0, Math.min(offset, text.length));
    if (!isWordChar(text[pos])) {
      if (pos > 0 && isWordChar(text[pos - 1])) pos -= 1;
      else return "";
    }
    var start = pos;
    var end = pos;
    while (start > 0 && isWordChar(text[start - 1])) start -= 1;
    while (end < text.length && isWordChar(text[end])) end += 1;
    var word = text.slice(start, end).replace(/^['’ʼ\-]+|['’ʼ\-]+$/g, "");
    if (!word || word.length > WORD_MAX || !/[\p{L}]/u.test(word)) return "";
    return word;
  }

  // The sentence around `offset`, as context for picking the right meaning.
  function sentenceAt(text, offset) {
    text = String(text || "");
    var breaks = /[.!?؟۔\n]/;
    var start = Math.min(offset, text.length);
    var end = Math.min(offset, text.length);
    while (start > 0 && !breaks.test(text[start - 1])) start -= 1;
    while (end < text.length && !breaks.test(text[end])) end += 1;
    var sentence = text.slice(start, Math.min(end + 1, text.length)).trim();
    return sentence.length > 220 ? sentence.slice(Math.max(0, offset - start - 110), offset - start + 110).trim() : sentence;
  }

  // ---- cache ----

  function createCache(storage) {
    var memory = new Map();
    var loaded = false;

    function load() {
      if (loaded) return;
      loaded = true;
      try {
        var raw = storage && storage.getItem(CACHE_KEY);
        var list = raw ? JSON.parse(raw) : [];
        if (Array.isArray(list)) list.forEach(function (pair) {
          if (Array.isArray(pair) && typeof pair[0] === "string" && pair[1] && typeof pair[1] === "object") memory.set(pair[0], pair[1]);
        });
      } catch (err) { /* a broken cache is just an empty cache */ }
    }

    function persist() {
      try { if (storage) storage.setItem(CACHE_KEY, JSON.stringify(Array.from(memory.entries()))); } catch (err) { /* storage full or blocked */ }
    }

    return {
      key: function (pair, word) { return pair.from + ">" + pair.to + ":" + String(word).toLowerCase(); },
      get: function (key) {
        load();
        if (!memory.has(key)) return null;
        var value = memory.get(key);
        memory.delete(key); // most recently used goes last
        memory.set(key, value);
        return value;
      },
      set: function (key, value) {
        load();
        memory.delete(key);
        memory.set(key, value);
        while (memory.size > CACHE_MAX) memory.delete(memory.keys().next().value);
        persist();
      },
      size: function () { load(); return memory.size; }
    };
  }

  // ---- the popover ----

  function el(tag, className, text) {
    var node = root.document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function wordFromPoint(doc, x, y) {
    var node = null;
    var offset = 0;
    if (typeof doc.caretPositionFromPoint === "function") {
      var position = doc.caretPositionFromPoint(x, y);
      if (position) { node = position.offsetNode; offset = position.offset; }
    } else if (typeof doc.caretRangeFromPoint === "function") {
      var range = doc.caretRangeFromPoint(x, y);
      if (range) { node = range.startContainer; offset = range.startOffset; }
    }
    if (!node || node.nodeType !== 3) return null;
    var text = node.textContent || "";
    var word = wordAt(text, offset);
    if (!word) return null;
    return { word: word, sentence: sentenceAt(text, offset), node: node, offset: offset };
  }

  function init(options) {
    var chatBox = options.chatBox;
    var pair = options.pair;
    var vocab = options.vocab;
    var AI = options.ai || root.LinguaHubAI;
    var Lang = root.LinguaHubLanguages;
    var doc = root.document;
    var cache = createCache(options.storage !== undefined ? options.storage : (root.localStorage || null));
    var pointAt = options.wordFromPoint || function (x, y) { return wordFromPoint(doc, x, y); };

    var popover = el("div", "word-pop");
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-label", "Word meaning");
    popover.hidden = true;
    doc.body.appendChild(popover);

    var controller = null;
    var current = null; // { word, sentence, data }
    var lastOpener = null;

    function close() {
      if (controller) { controller.abort(); controller = null; }
      popover.hidden = true;
      popover.textContent = "";
      current = null;
      if (lastOpener && lastOpener.focus) { try { lastOpener.focus(); } catch (err) { /* gone */ } }
      lastOpener = null;
    }

    function place(rect) {
      var width = Math.min(320, (root.innerWidth || 800) - 24);
      var left = Math.max(12, Math.min((rect.left || 0), (root.innerWidth || 800) - width - 12));
      popover.style.width = width + "px";
      popover.style.left = left + "px";
      popover.style.top = Math.max(12, (rect.bottom || 0) + 8) + "px";
    }

    function header(word) {
      var head = el("div", "word-pop-head");
      var title = el("strong", "word-pop-word", word);
      title.setAttribute("dir", "auto");
      var closeBtn = el("button", "ws-icon-btn word-pop-close", "✕");
      closeBtn.type = "button";
      closeBtn.setAttribute("aria-label", "Close");
      closeBtn.addEventListener("click", close);
      head.appendChild(title);
      head.appendChild(closeBtn);
      return head;
    }

    function renderLoading(word) {
      popover.textContent = "";
      popover.appendChild(header(word));
      var line = el("p", "word-pop-status", "Looking it up…");
      line.setAttribute("role", "status");
      popover.appendChild(line);
    }

    function renderError(word, sentence, message) {
      popover.textContent = "";
      popover.appendChild(header(word));
      var line = el("p", "word-pop-status word-pop-error", message);
      line.setAttribute("role", "alert");
      popover.appendChild(line);
      var retry = el("button", "lh-btn lh-btn-secondary", "Retry");
      retry.type = "button";
      retry.addEventListener("click", function () { lookup(word, sentence); });
      popover.appendChild(retry);
    }

    function renderResult(word, data) {
      var wordLang = data.language || pair.get().to;
      popover.textContent = "";
      popover.appendChild(header(word));

      var meaning = el("p", "word-pop-translation", data.translation);
      meaning.setAttribute("dir", "auto");
      popover.appendChild(meaning);
      if (data.partOfSpeech) popover.appendChild(el("p", "word-pop-pos", data.partOfSpeech));
      if (data.example) {
        var example = el("p", "word-pop-example", data.example);
        example.setAttribute("dir", "auto");
        popover.appendChild(example);
        if (data.exampleTranslation) {
          var exampleTr = el("p", "word-pop-example-tr", data.exampleTranslation);
          exampleTr.setAttribute("dir", "auto");
          popover.appendChild(exampleTr);
        }
      }

      var actions = el("div", "word-pop-actions");
      var listen = el("button", "ws-icon-btn voice-feature word-pop-listen", "🔊");
      listen.type = "button";
      listen.setAttribute("aria-label", "Listen to “" + word + "”");
      listen.setAttribute("title", "Listen");
      listen.addEventListener("click", function () {
        if (root.LinguaHubVoice && root.LinguaHubVoice.speakText) root.LinguaHubVoice.speakText(word, Lang.speechLang(wordLang));
      });
      actions.appendChild(listen);

      var saved = vocab ? vocab.has(word, wordLang) : false;
      var save = el("button", "lh-btn lh-btn-primary word-pop-save", saved ? "Saved to vocabulary" : "Save to vocabulary");
      save.type = "button";
      save.disabled = saved || !vocab;
      save.addEventListener("click", function () {
        var result = vocab.add({ word: word, translation: data.translation, lang: wordLang, partOfSpeech: data.partOfSpeech, example: data.example, exampleTranslation: data.exampleTranslation });
        if (result.ok) {
          save.textContent = "Saved to vocabulary";
          save.disabled = true;
          if (root.LinguaHubToast) root.LinguaHubToast.show({ type: "success", message: result.duplicate ? "Already in your vocabulary." : "Saved “" + word + "”.", duration: 2000 });
        } else if (root.LinguaHubToast) {
          root.LinguaHubToast.show({ type: "error", message: result.reason === "word-limit-reached" ? "Your vocabulary is full. Delete a word to add more." : "Couldn't save that word." });
        }
      });
      actions.appendChild(save);
      popover.appendChild(actions);
    }

    async function lookup(word, sentence) {
      var p = pair.get();
      var key = cache.key(p, word);
      var hit = cache.get(key);
      current = { word: word, sentence: sentence };
      if (hit) { renderResult(word, hit); return; }
      if (controller) controller.abort();
      controller = typeof AbortController === "function" ? new AbortController() : null;
      var mine = current;
      renderLoading(word);
      try {
        var answer = await AI.request({
          mode: "word-lookup",
          messages: [{ role: "user", content: AI.prompts.lookup(p, word, sentence) }],
          signal: controller ? controller.signal : undefined,
          normalize: AI.normalizeLookup
        });
        if (current !== mine) return; // closed or replaced while waiting
        if (!answer.data) throw Object.assign(new Error("unreadable"), { userMessage: AI.describeError({ status: 502 }) });
        cache.set(key, answer.data);
        renderResult(word, answer.data);
      } catch (err) {
        if (current !== mine || (err && err.aborted)) return;
        renderError(word, sentence, err && err.userMessage ? err.userMessage : AI.describeError(err));
      }
    }

    function open(found, rect) {
      lastOpener = null;
      popover.hidden = false;
      place(rect || {});
      return lookup(found.word, found.sentence);
    }

    chatBox.addEventListener("click", function (event) {
      var target = event.target;
      if (!target || !target.closest) return;
      var content = target.closest(".message.ai .message-content");
      if (!content) return;
      if (target.closest("a, button, pre, code, textarea, input, .message-actions")) return;
      var selection = root.getSelection ? root.getSelection() : null;
      if (selection && !selection.isCollapsed && String(selection).trim()) return; // selecting text, not tapping
      var found = pointAt(event.clientX, event.clientY);
      if (!found) return;
      open(found, { left: event.clientX, bottom: event.clientY + 16 });
    });

    // Clicks inside never reach the document handler: buttons here re-render
    // the popover, so by then their target is no longer inside it.
    popover.addEventListener("click", function (event) { event.stopPropagation(); });
    doc.addEventListener("click", function (event) {
      if (popover.hidden) return;
      if (event.target && event.target.closest && event.target.closest(".message.ai .message-content")) return; // the chat handler decides
      close();
    });
    doc.addEventListener("keydown", function (event) {
      if (!popover.hidden && event.key === "Escape") close();
    });

    return { close: close, _lookup: lookup, _open: open, _cache: cache, _popover: popover };
  }

  return { init: init, wordAt: wordAt, sentenceAt: sentenceAt, createCache: createCache, wordFromPoint: wordFromPoint, CACHE_KEY: CACHE_KEY };
});
