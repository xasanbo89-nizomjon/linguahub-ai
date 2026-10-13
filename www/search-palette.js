// LinguaHub AI - Ctrl/Cmd+K search palette.
//
// A centered overlay (command-palette style) that searches chat titles and
// message content (www/chat-search.js), highlights what matched and shows a
// short snippet. Keyboard: Up/Down move, Enter opens, Esc closes. The palette
// itself only finds and reports; opening a chat (and scrolling to the matched
// message) is the host's openConversation(id, messageId) callback.

var LinguaHubSearchPalette = (function () {
  "use strict";

  var DEBOUNCE_MS = 120;
  var state = null; // the open palette, or null
  var config = null;

  function debounce(fn, waitMs) {
    var timer = null;
    var wrapped = function () {
      var args = arguments;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () { timer = null; fn.apply(null, args); }, waitMs);
    };
    wrapped.cancel = function () { if (timer) { clearTimeout(timer); timer = null; } };
    return wrapped;
  }

  // textContent + <mark> only - search text and chat content never reach innerHTML.
  function appendHighlighted(parent, text, ranges) {
    var cursor = 0;
    (ranges || []).forEach(function (range) {
      if (range[0] > cursor) parent.appendChild(document.createTextNode(text.slice(cursor, range[0])));
      var mark = document.createElement("mark");
      mark.textContent = text.slice(range[0], range[1]);
      parent.appendChild(mark);
      cursor = range[1];
    });
    if (cursor < text.length) parent.appendChild(document.createTextNode(text.slice(cursor)));
  }

  function formatDate(iso) {
    var date = new Date(iso);
    if (isNaN(date.getTime())) return "";
    try { return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); } catch (err) { return ""; }
  }

  function close() {
    if (!state) return;
    var current = state;
    state = null;
    current.debounced.cancel();
    document.removeEventListener("keydown", current.onKeydown, true);
    if (current.backdrop.parentNode) current.backdrop.parentNode.removeChild(current.backdrop);
    if (current.previouslyFocused && typeof current.previouslyFocused.focus === "function") current.previouslyFocused.focus();
  }

  function setActive(index) {
    if (!state || !state.results.length) return;
    state.active = (index + state.results.length) % state.results.length;
    state.items.forEach(function (el, i) {
      var selected = i === state.active;
      el.setAttribute("aria-selected", String(selected));
      if (selected) {
        state.input.setAttribute("aria-activedescendant", el.id);
        if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
      }
    });
  }

  function openResult(result) {
    var query = state ? state.input.value : "";
    close();
    if (config && typeof config.openConversation === "function") config.openConversation(result.id, result.messageId, query);
  }

  function renderResults(results, isRecent) {
    state.results = results;
    state.items = [];
    var list = state.list;
    list.textContent = "";
    state.empty.hidden = results.length > 0;
    state.heading.hidden = !(isRecent && results.length > 0);
    state.status.textContent = results.length
      ? results.length + (results.length === 1 ? " result" : " results")
      : "No results";

    results.forEach(function (result, i) {
      var item = document.createElement("div");
      item.className = "lh-palette-item";
      item.id = "lh-palette-item-" + i;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", "false");

      var head = document.createElement("div");
      head.className = "lh-palette-item-head";
      var title = document.createElement("span");
      title.className = "lh-palette-item-title";
      appendHighlighted(title, result.title, result.titleRanges);
      head.appendChild(title);
      var meta = document.createElement("span");
      meta.className = "lh-palette-item-meta";
      meta.textContent = (result.pinned ? "Pinned · " : "") + formatDate(result.updatedAt);
      head.appendChild(meta);
      item.appendChild(head);

      if (result.snippet) {
        var snippet = document.createElement("div");
        snippet.className = "lh-palette-item-snippet";
        snippet.setAttribute("dir", "auto");
        appendHighlighted(snippet, result.snippet.text, result.snippet.ranges);
        item.appendChild(snippet);
      }

      item.addEventListener("mousemove", function () { if (state && state.active !== i) setActive(i); });
      item.addEventListener("click", function () { openResult(result); });
      list.appendChild(item);
      state.items.push(item);
    });
    state.active = -1;
    if (results.length) setActive(0);
    else state.input.removeAttribute("aria-activedescendant");
  }

  function runQuery() {
    if (!state) return;
    var text = state.input.value;
    state.lastQuery = text;
    if (!text.trim()) {
      renderResults(window.LinguaHubChatSearch.recent(state.index, 8), true);
      return;
    }
    renderResults(window.LinguaHubChatSearch.query(state.index, text, { limit: 50 }), false);
  }

  function open() {
    if (state) return;
    if (!config || !window.LinguaHubChatSearch) return;
    var previouslyFocused = document.activeElement;

    var backdrop = document.createElement("div");
    backdrop.className = "lh-palette-backdrop";

    var dialog = document.createElement("div");
    dialog.className = "lh-palette";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", "Search chats");

    var row = document.createElement("div");
    row.className = "lh-palette-input-row";
    var input = document.createElement("input");
    input.type = "text";
    input.className = "lh-palette-input";
    input.placeholder = "Search chats and messages…";
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-expanded", "true");
    input.setAttribute("aria-controls", "lh-palette-list");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-label", "Search chats and messages");
    input.setAttribute("autocomplete", "off");
    input.setAttribute("spellcheck", "false");
    row.appendChild(input);

    var heading = document.createElement("div");
    heading.className = "lh-palette-heading";
    heading.textContent = "Recent";

    var list = document.createElement("div");
    list.className = "lh-palette-list";
    list.id = "lh-palette-list";
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Results");

    var empty = document.createElement("div");
    empty.className = "lh-palette-empty";
    empty.textContent = "No results";
    empty.hidden = true;

    var status = document.createElement("div");
    status.className = "sr-only";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");

    var footer = document.createElement("div");
    footer.className = "lh-palette-footer";
    footer.setAttribute("aria-hidden", "true");
    footer.textContent = "↑↓ navigate · Enter open · Esc close";

    [row, heading, list, empty, status, footer].forEach(function (el) { dialog.appendChild(el); });
    backdrop.appendChild(dialog);

    var debounced = debounce(runQuery, DEBOUNCE_MS);

    function onKeydown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive(state.active + 1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive(state.active - 1);
      } else if (event.key === "Enter") {
        event.preventDefault();
        // A pending (debounced) query must be applied before Enter picks a
        // row - but only if the text really changed, or re-running would
        // reset the arrow-key selection back to the first result.
        debounced.cancel();
        if (input.value !== state.lastQuery) runQuery();
        if (state.results[state.active]) openResult(state.results[state.active]);
      } else if (event.key === "Tab") {
        event.preventDefault(); // the input is the only stop inside the palette
      }
    }

    state = {
      backdrop: backdrop, input: input, list: list, empty: empty, heading: heading, status: status,
      index: window.LinguaHubChatSearch.createIndex(config.getConversations()),
      results: [], items: [], active: -1, lastQuery: null, previouslyFocused: previouslyFocused,
      debounced: debounced, onKeydown: onKeydown
    };

    input.addEventListener("input", debounced);
    backdrop.addEventListener("mousedown", function (event) { if (event.target === backdrop) close(); });
    document.addEventListener("keydown", onKeydown, true);
    document.body.appendChild(backdrop);
    runQuery();
    input.focus();
  }

  function onGlobalKeydown(event) {
    if (!(event.key === "k" || event.key === "K") || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
    // never on top of another dialog (Settings, confirmations...)
    if (!state && document.querySelector(".lh-dialog-backdrop")) return;
    event.preventDefault();
    if (state) close();
    else open();
  }

  // config: { getConversations(): Conversation[], openConversation(id, messageId, query) }
  function init(options) {
    config = options;
    document.addEventListener("keydown", onGlobalKeydown);
  }

  return { init: init, open: open, close: close, isOpen: function () { return state !== null; } };
})();

if (typeof window !== "undefined") {
  window.LinguaHubSearchPalette = LinguaHubSearchPalette;
}
