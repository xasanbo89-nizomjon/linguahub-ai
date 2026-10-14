// LinguaHub AI - Grammar workspace: write in the language you are learning
// and get inline corrections. The wrong part is struck through (--danger-text),
// the correction is shown in green, and each one has a short explanation on
// hover / focus / tap with its own Accept button. "Accept all" applies
// everything at once.

(function () {
  "use strict";

  var MAX_CHARS = 2000;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function create(api) {
    var pair = api.pair;
    var Diff = window.LinguaHubGrammarDiff;
    var Lang = window.LinguaHubLanguages;
    var AI = window.LinguaHubAI;

    var controller = null;
    var recorded = false;
    var result = null; // { text, edits, corrected } for the text that was checked

    var root = el("div", "ws ws-grammar");

    var toolbar = el("div", "ws-toolbar");
    var pairNote = el("span", "ws-note");
    var control = Lang.createControl(pair, { className: "ws-pair-control" });
    toolbar.appendChild(control.el);
    toolbar.appendChild(pairNote);
    root.appendChild(toolbar);

    var editor = el("section", "ws-pane ws-grammar-editor");
    editor.setAttribute("aria-label", "Your writing");
    var input = el("textarea", "ws-textarea");
    input.setAttribute("aria-label", "Write something to check");
    input.setAttribute("dir", "auto");
    input.setAttribute("maxlength", String(MAX_CHARS));
    input.setAttribute("rows", "7");
    var foot = el("div", "ws-pane-foot");
    var counter = el("span", "ws-counter", "0 / " + MAX_CHARS);
    var checkBtn = el("button", "lh-btn lh-btn-primary ws-check", "Check grammar");
    checkBtn.type = "button";
    foot.appendChild(counter);
    foot.appendChild(checkBtn);
    editor.appendChild(input);
    editor.appendChild(foot);
    root.appendChild(editor);

    var resultCard = el("section", "ws-pane ws-grammar-result");
    resultCard.setAttribute("aria-label", "Corrections");
    resultCard.hidden = true;
    var resultHead = el("div", "ws-result-head");
    var summary = el("h3", "ws-result-title");
    summary.setAttribute("role", "status");
    var acceptAllBtn = el("button", "lh-btn lh-btn-secondary ws-accept-all", "Accept all");
    acceptAllBtn.type = "button";
    resultHead.appendChild(summary);
    resultHead.appendChild(acceptAllBtn);
    var body = el("div", "gr-text");
    body.setAttribute("dir", "auto");
    var extra = el("ul", "gr-unplaced");
    extra.hidden = true;
    resultCard.appendChild(resultHead);
    resultCard.appendChild(body);
    resultCard.appendChild(extra);
    root.appendChild(resultCard);

    api.panel.appendChild(root);

    function renderPair() {
      var p = pair.get();
      pairNote.textContent = "Writing in " + Lang.nameOf(p.to) + " · explanations in " + Lang.nameOf(p.from);
    }

    function updateCounter() {
      counter.textContent = input.value.length + " / " + MAX_CHARS;
      checkBtn.disabled = !input.value.trim();
    }

    function hideResult() {
      result = null;
      resultCard.hidden = true;
      body.textContent = "";
      extra.textContent = "";
      extra.hidden = true;
    }

    // ---- drawing the corrections ----
    var openTip = null;
    function closeTip() {
      if (openTip) { openTip.classList.remove("is-open"); openTip.setAttribute("aria-expanded", "false"); openTip = null; }
    }

    function buildEdit(edit, index) {
      var wrap = el("span", "gr-edit");
      wrap.setAttribute("tabindex", "0");
      wrap.setAttribute("role", "button");
      wrap.setAttribute("aria-expanded", "false");
      wrap.setAttribute("aria-label", "Correction: " + edit.original + " to " + (edit.correction || "(remove)") + ". " + edit.explanation);
      if (edit.original) wrap.appendChild(el("del", "gr-del", edit.original));
      if (edit.correction) wrap.appendChild(el("ins", "gr-ins", edit.correction));
      else wrap.appendChild(el("span", "gr-removed", "(remove)"));

      var tip = el("span", "gr-tip");
      tip.setAttribute("role", "tooltip");
      if (edit.explanation) tip.appendChild(el("span", "gr-tip-text", edit.explanation));
      var accept = el("button", "gr-accept", "Accept");
      accept.type = "button";
      accept.addEventListener("click", function (event) {
        event.stopPropagation();
        acceptOne(index);
      });
      tip.appendChild(accept);
      wrap.appendChild(tip);

      function toggle() {
        var opening = openTip !== wrap;
        closeTip();
        if (opening) { wrap.classList.add("is-open"); wrap.setAttribute("aria-expanded", "true"); openTip = wrap; }
      }
      wrap.addEventListener("click", function (event) { if (event.target === accept) return; toggle(); });
      wrap.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(); }
        else if (event.key === "Escape") { closeTip(); }
      });
      return wrap;
    }

    function draw() {
      body.textContent = "";
      extra.textContent = "";
      var built = Diff.buildSegments(result.text, result.edits);
      built.segments.forEach(function (segment) {
        if (segment.type === "text") body.appendChild(document.createTextNode(segment.text));
        else body.appendChild(buildEdit(segment.edit, segment.index));
      });
      built.unplaced.forEach(function (edit) {
        extra.appendChild(el("li", "", "“" + edit.original + "” → “" + edit.correction + "”" + (edit.explanation ? " — " + edit.explanation : "")));
      });
      extra.hidden = built.unplaced.length === 0;
      var count = result.edits.length;
      summary.textContent = count === 0 ? "No mistakes found — nice writing!" : count + (count === 1 ? " suggestion" : " suggestions");
      acceptAllBtn.hidden = count === 0;
      resultCard.hidden = false;
    }

    function acceptOne(index) {
      if (!result) return;
      var next = Diff.applyOne(result.text, result.edits, index);
      if (!next.applied) return;
      closeTip();
      result.text = next.text;
      result.edits = next.remaining;
      input.value = result.text;
      updateCounter();
      draw();
    }

    function acceptAll() {
      if (!result) return;
      var count = result.edits.length;
      var finalText = Diff.applyAll(result.text, result.edits, result.corrected);
      input.value = finalText.slice(0, MAX_CHARS);
      updateCounter();
      hideResult();
      if (window.LinguaHubToast) window.LinguaHubToast.show({ type: "success", message: count === 1 ? "Applied 1 correction." : "Applied " + count + " corrections.", duration: 2000 });
      input.focus();
    }

    // ---- checking ----
    function showFailure(message) {
      resultCard.hidden = false;
      body.textContent = "";
      extra.hidden = true;
      acceptAllBtn.hidden = true;
      summary.textContent = "Couldn't check your text";
      var box = el("div", "chat-error");
      box.setAttribute("role", "alert");
      box.appendChild(el("span", "chat-error-text", message));
      var retry = el("button", "lh-btn lh-btn-secondary", "Retry");
      retry.type = "button";
      retry.addEventListener("click", check);
      box.appendChild(retry);
      body.appendChild(box);
    }

    async function check() {
      var text = input.value.trim();
      if (!text) return;
      if (controller) controller.abort();
      controller = typeof AbortController === "function" ? new AbortController() : null;
      checkBtn.disabled = true;
      checkBtn.textContent = "Checking…";
      try {
        var answer = await AI.request({
          mode: "grammar",
          messages: [{ role: "user", content: AI.prompts.grammar(pair.get(), text) }],
          signal: controller ? controller.signal : undefined,
          normalize: function (obj) { return Diff.normalize(obj, text); }
        });
        if (answer.data) {
          result = { text: text, edits: answer.data.edits, corrected: answer.data.corrected };
          draw();
        } else {
          // not the JSON we asked for: show the reply as plain feedback
          result = null;
          resultCard.hidden = false;
          body.textContent = answer.text.trim() || "No feedback was returned.";
          extra.hidden = true;
          acceptAllBtn.hidden = true;
          summary.textContent = "Feedback";
        }
        if (!recorded) { recorded = true; document.dispatchEvent(new CustomEvent("linguahub:activity")); }
      } catch (err) {
        if (err && err.aborted) return;
        showFailure(err && err.userMessage ? err.userMessage : AI.describeError(err));
      } finally {
        checkBtn.textContent = "Check grammar";
        updateCounter();
      }
    }

    input.addEventListener("input", function () { updateCounter(); if (result) hideResult(); });
    input.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); check(); }
    });
    checkBtn.addEventListener("click", check);
    acceptAllBtn.addEventListener("click", acceptAll);
    document.addEventListener("click", function (event) { if (openTip && !openTip.contains(event.target)) closeTip(); });
    pair.onChange(renderPair);

    renderPair();
    updateCounter();

    return {
      activate: function () { renderPair(); input.focus(); },
      deactivate: function () { closeTip(); if (controller) { controller.abort(); controller = null; } },
      _check: check,
      _state: function () { return result; }
    };
  }

  if (window.LinguaHubWorkspace) window.LinguaHubWorkspace.register("grammar", create);
})();
