// LinguaHub AI - mode workspaces.
//
// Translate, Speak, Grammar and Vocabulary each change the main area, not just
// the system prompt: while one of them is the selected mode its screen
// replaces the chat and the composer (Free chat and every other mode keep the
// chat). The header's mode selector stays the one switcher; this file only
// listens to it. Screens register themselves with register(id, factory).
//
//   factory({ panel, pair, vocab, showChat }) -> { activate(options), deactivate() }
//
// A screen is built the first time its mode is chosen and kept afterwards, so
// switching back finds the text and results exactly as they were left.

var LinguaHubWorkspace = (function () {
  "use strict";

  var factories = {};
  var instances = {};
  var activeId = null;
  var pendingOptions = null;
  var ctx = null;
  var titleBefore = null;

  // Screens that are not part of the startup page: the first time a mode is
  // chosen its script(s) are fetched (same origin, in this order), then the
  // screen builds itself. Nothing for them runs until then. Each script
  // registers its factory with register(), exactly as when preloaded - so a
  // page that already included them (or a test) works the same, synchronously.
  var LAZY_SCRIPTS = {
    translate: ["ws-translate.js"],
    speak: ["ws-speak.js"],
    grammar: ["grammar-diff.js", "ws-grammar.js"],
    vocabulary: ["ws-vocab.js"]
  };
  var scriptLoads = {}; // src -> Promise, so a script is requested once
  var loadingEl = null;

  function register(id, factory) {
    factories[id] = factory;
  }

  function has(map, id) {
    return Object.prototype.hasOwnProperty.call(map, id);
  }

  function isWorkspaceMode(id) {
    return has(factories, id) || has(LAZY_SCRIPTS, id);
  }

  function loadScript(src) {
    if (!has(scriptLoads, src)) {
      scriptLoads[src] = new Promise(function (resolve, reject) {
        var script = document.createElement("script");
        script.src = src;
        script.onload = function () { resolve(); };
        script.onerror = function () { delete scriptLoads[src]; reject(new Error("Could not load " + src)); };
        (document.head || document.body).appendChild(script);
      });
    }
    return scriptLoads[src];
  }

  function loadFactory(id) {
    var sources = has(LAZY_SCRIPTS, id) ? LAZY_SCRIPTS[id] : [];
    var index = 0;
    // one after the other (a screen may need the one before it); the first request starts right away
    function next() {
      if (index >= sources.length) return Promise.resolve();
      return loadScript(sources[index++]).then(next);
    }
    return next().then(function () {
      if (!has(factories, id)) throw new Error("Screen did not register: " + id);
    });
  }

  function showLoading(on) {
    if (on && !loadingEl) {
      loadingEl = document.createElement("p");
      loadingEl.className = "workspace-loading";
      loadingEl.setAttribute("role", "status");
      loadingEl.textContent = "Loading…";
      ctx.root.appendChild(loadingEl);
    }
    if (loadingEl) loadingEl.hidden = !on;
  }

  function modeLabel(id) {
    var option = null;
    Array.prototype.forEach.call(ctx.modeSelect.options || [], function (o) { if (o.value === id) option = o; });
    return option && option.textContent ? option.textContent : id;
  }

  function setTitle(text) {
    var title = ctx.titleEl;
    if (!title) return;
    if (text === null) {
      if (titleBefore !== null) { title.textContent = titleBefore; titleBefore = null; }
      return;
    }
    if (titleBefore === null) titleBefore = title.textContent;
    title.textContent = text;
  }

  function leave() {
    if (!activeId) return;
    var current = instances[activeId];
    if (current) {
      if (current.api && typeof current.api.deactivate === "function") current.api.deactivate();
      current.panel.hidden = true;
    }
    activeId = null;
  }

  function apply() {
    var id = ctx.modeSelect.value;
    if (!isWorkspaceMode(id)) {
      leave();
      ctx.container.removeAttribute("data-workspace");
      ctx.root.hidden = true;
      setTitle(null);
      return;
    }
    if (activeId && activeId !== id) leave();

    var entry = instances[id];
    if (!entry && !has(factories, id)) {
      // first use of a lazily loaded screen: show the frame now, build when its script is in
      ctx.root.hidden = false;
      ctx.container.setAttribute("data-workspace", id);
      setTitle(modeLabel(id));
      activeId = id;
      showLoading(true);
      loadFactory(id).then(function () {
        showLoading(false);
        if (ctx.modeSelect.value === id) apply(); // still wanted (the learner may have moved on meanwhile)
      }, function () {
        showLoading(false);
        if (window.LinguaHubToast) window.LinguaHubToast.show({ type: "error", message: "Couldn't load this screen. Check your connection and try again." });
        if (ctx.modeSelect.value === id) showChat();
      });
      return;
    }
    showLoading(false);
    if (!entry) {
      var panel = document.createElement("div");
      panel.className = "workspace-panel";
      panel.setAttribute("data-workspace", id);
      ctx.root.appendChild(panel);
      entry = { panel: panel, api: factories[id]({ panel: panel, pair: ctx.pair, vocab: ctx.vocab, showChat: showChat }) };
      instances[id] = entry;
    }
    entry.panel.hidden = false;
    ctx.root.hidden = false;
    ctx.container.setAttribute("data-workspace", id);
    setTitle(modeLabel(id));
    activeId = id;
    var options = pendingOptions;
    pendingOptions = null;
    if (entry.api && typeof entry.api.activate === "function") entry.api.activate(options || {});
  }

  // Opens a mode's screen (used by the home cards and "due today"); options
  // such as { tab: "review" } are handed to the screen's activate().
  function open(id, options) {
    var available = Array.prototype.some.call(ctx.modeSelect.options || [], function (o) { return o.value === id && !o.disabled; });
    if (!available) {
      if (window.LinguaHubToast) window.LinguaHubToast.show({ type: "warning", message: "That mode isn't available right now." });
      return false;
    }
    pendingOptions = options || null;
    ctx.modeSelect.value = id;
    ctx.modeSelect.dispatchEvent(new Event("change", { bubbles: true }));
    if (!isWorkspaceMode(id) && id === "general" && ctx.focusComposer) ctx.focusComposer();
    return true;
  }

  // Back to the chat (picking or creating a conversation does this).
  function showChat() {
    if (!activeId) return;
    ctx.modeSelect.value = "general";
    ctx.modeSelect.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function init(options) {
    ctx = options;
    ctx.modeSelect.addEventListener("change", apply);
    apply();
  }

  return { register: register, init: init, open: open, showChat: showChat, isWorkspaceMode: isWorkspaceMode, getActive: function () { return activeId; } };
})();

if (typeof window !== "undefined") {
  window.LinguaHubWorkspace = LinguaHubWorkspace;
}
