// LinguaHub AI - keyboard shortcuts and the shortcuts help dialog.
//
//   Ctrl+N (or Ctrl+Shift+O)  new chat          Ctrl+1..5  Free chat, Translate, Speak, Grammar, Vocabulary
//   Ctrl+K                    search chats      Ctrl+B     show / hide the sidebar
//   Ctrl+,                    settings          Ctrl+/     this list
//   Esc                       stop the reply, close the dialog / menu / popover, stop speech
//
// (Cmd instead of Ctrl on a Mac.) Ctrl+K stays in search-palette.js and Esc
// stays with the things it closes; this file lists them and owns the rest.
// Nothing here fires while a dialog is open (except Ctrl+/ to close its own
// help), and key presses with Alt are ignored - on Windows AltGr is
// Ctrl+Alt, so typing characters like @ or € never trips a shortcut.
// Ctrl+N and Ctrl+Shift+O: browsers reserve Ctrl+N, so the second one is the
// one that works on the web; both work in the desktop app.

var LinguaHubShortcuts = (function () {
  "use strict";

  var MODE_KEYS = { "1": "general", "2": "translate", "3": "speak", "4": "grammar", "5": "vocabulary" };

  // Every shortcut the help dialog shows. `run` ids are handled below;
  // `external` ones are handled by the module named in `note`.
  var SECTIONS = [
    {
      title: "General",
      items: [
        { id: "new-chat", label: "New chat", keys: [["Ctrl", "N"], ["Ctrl", "Shift", "O"]] },
        { id: "search", label: "Search chats", keys: [["Ctrl", "K"]], external: true },
        { id: "settings", label: "Settings", keys: [["Ctrl", ","]] },
        { id: "sidebar", label: "Show or hide the sidebar", keys: [["Ctrl", "B"]] },
        { id: "help", label: "Keyboard shortcuts", keys: [["Ctrl", "/"]] }
      ]
    },
    {
      title: "Modes",
      items: [
        { id: "mode-general", label: "Free chat", keys: [["Ctrl", "1"]] },
        { id: "mode-translate", label: "Translate", keys: [["Ctrl", "2"]] },
        { id: "mode-speak", label: "Speak", keys: [["Ctrl", "3"]] },
        { id: "mode-grammar", label: "Grammar", keys: [["Ctrl", "4"]] },
        { id: "mode-vocabulary", label: "Vocabulary", keys: [["Ctrl", "5"]] }
      ]
    },
    {
      title: "Writing and listening",
      items: [
        { id: "send", label: "Send message", keys: [["Enter"]], external: true },
        { id: "newline", label: "New line", keys: [["Shift", "Enter"]], external: true },
        { id: "escape", label: "Stop the reply, close a dialog, menu or popover, stop speech", keys: [["Esc"]], external: true }
      ]
    },
    {
      title: "Flashcard review",
      items: [
        { id: "flip", label: "Show the answer", keys: [["Space"], ["Enter"]], external: true },
        { id: "grade", label: "Again, Hard, Good, Easy", keys: [["1"], ["2"], ["3"], ["4"]], external: true }
      ]
    }
  ];

  function isMacPlatform(nav) {
    return /Mac|iPhone|iPad/i.test(String((nav && (nav.platform || nav.userAgent)) || ""));
  }

  // The action a key press stands for, or null. Pure.
  function actionFor(event, isMac) {
    if (!event || event.altKey) return null;
    var primary = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    if (!primary) return null;
    var key = String(event.key || "").toLowerCase();
    if (event.shiftKey) {
      return key === "o" ? "new-chat" : null;
    }
    if (key === "n") return "new-chat";
    if (key === ",") return "settings";
    if (key === "b") return "sidebar";
    if (key === "/") return "help";
    if (Object.prototype.hasOwnProperty.call(MODE_KEYS, key)) return "mode-" + MODE_KEYS[key];
    return null;
  }

  function init(options) {
    var opts = options || {};
    var doc = opts.document || document;
    var win = opts.window || (typeof window !== "undefined" ? window : {});
    var isMac = opts.isMac !== undefined ? opts.isMac : isMacPlatform(win.navigator);
    var helpState = null; // { backdrop, previouslyFocused, onKeydown }

    function byId(id) { return doc.getElementById(id); }

    // ---- the help dialog ----
    function keyLabel(key) {
      if (key === "Ctrl" && isMac) return "⌘";
      if (key === "Shift" && isMac) return "⇧";
      return key;
    }

    function buildKeys(combo) {
      var holder = doc.createElement("span");
      holder.className = "shortcuts-combo";
      combo.forEach(function (key, index) {
        if (index > 0) holder.appendChild(doc.createTextNode("+"));
        var kbd = doc.createElement("kbd");
        kbd.textContent = keyLabel(key);
        holder.appendChild(kbd);
      });
      return holder;
    }

    function closeHelp() {
      if (!helpState) return;
      var state = helpState;
      helpState = null;
      state.backdrop.remove();
      doc.removeEventListener("keydown", state.onKeydown, true);
      if (state.previouslyFocused && typeof state.previouslyFocused.focus === "function") state.previouslyFocused.focus();
    }

    function openHelp() {
      if (helpState) return;
      var previouslyFocused = doc.activeElement;
      var backdrop = doc.createElement("div");
      backdrop.className = "lh-dialog-backdrop";
      backdrop.setAttribute("id", "shortcuts-backdrop");

      var dialog = doc.createElement("div");
      dialog.className = "lh-dialog shortcuts-dialog";
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("aria-labelledby", "shortcuts-title");

      var title = doc.createElement("h2");
      title.className = "lh-dialog-title";
      title.setAttribute("id", "shortcuts-title");
      title.textContent = "Keyboard shortcuts";
      dialog.appendChild(title);

      SECTIONS.forEach(function (section) {
        var heading = doc.createElement("h3");
        heading.className = "shortcuts-section";
        heading.textContent = section.title;
        dialog.appendChild(heading);
        var list = doc.createElement("dl");
        list.className = "shortcuts-list";
        section.items.forEach(function (item) {
          var row = doc.createElement("div");
          row.className = "shortcuts-row";
          var term = doc.createElement("dt");
          term.textContent = item.label;
          var def = doc.createElement("dd");
          item.keys.forEach(function (combo, index) {
            if (index > 0) def.appendChild(doc.createTextNode(" or "));
            def.appendChild(buildKeys(combo));
          });
          row.appendChild(term);
          row.appendChild(def);
          list.appendChild(row);
        });
        dialog.appendChild(list);
      });

      var actions = doc.createElement("div");
      actions.className = "lh-dialog-actions";
      var close = doc.createElement("button");
      close.type = "button";
      close.className = "lh-btn lh-btn-primary";
      close.textContent = "Close";
      close.addEventListener("click", closeHelp);
      actions.appendChild(close);
      dialog.appendChild(actions);
      backdrop.appendChild(dialog);
      backdrop.addEventListener("mousedown", function (event) { if (event.target === backdrop) closeHelp(); });

      function onKeydown(event) {
        if (event.key === "Escape") { event.preventDefault(); closeHelp(); }
        else if (event.key === "Tab") { event.preventDefault(); close.focus(); } // one control: keep focus inside
        else if (actionFor(event, isMac) === "help") { event.preventDefault(); closeHelp(); }
      }
      doc.addEventListener("keydown", onKeydown, true);
      doc.body.appendChild(backdrop);
      helpState = { backdrop: backdrop, previouslyFocused: previouslyFocused, onKeydown: onKeydown };
      close.focus();
    }

    // ---- actions ----
    function click(id) {
      var el = byId(id);
      if (el && typeof el.click === "function") el.click();
    }

    function toggleSidebar() {
      var collapse = byId("sidebar-collapse-btn");
      var drawer = byId("sidebar-toggle-btn");
      // the drawer button is only on screen on narrow windows (hidden = display:none -> no offsetParent)
      var drawerVisible = drawer && (drawer.offsetParent !== null && drawer.offsetParent !== undefined);
      if (drawerVisible) drawer.click();
      else if (collapse) collapse.click();
    }

    function openMode(id) {
      var workspace = win.LinguaHubWorkspace;
      if (workspace && typeof workspace.open === "function") workspace.open(id);
    }

    function run(action) {
      if (action === "new-chat") { if (win.LinguaHubWorkspace) win.LinguaHubWorkspace.showChat(); click("new-chat-btn"); return; }
      if (action === "settings") { click("settings-btn"); return; }
      if (action === "sidebar") { toggleSidebar(); return; }
      if (action === "help") { openHelp(); return; }
      if (action.indexOf("mode-") === 0) openMode(action.slice(5));
    }

    function onKeydown(event) {
      if (event.defaultPrevented) return;
      var action = actionFor(event, isMac);
      if (!action) return;
      // a dialog (settings, a confirmation, search...) owns the keyboard
      if (!helpState && doc.querySelector(".lh-dialog-backdrop")) return;
      if (helpState) return; // the help's own capture handler deals with Ctrl+/ and Esc
      event.preventDefault();
      run(action);
    }

    // Esc also quiets voice: it stops read-aloud and dictation. (Stopping a
    // reply and closing dialogs / menus / the word popover stay with the
    // code that owns them.)
    function onEscape(event) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      var voice = win.LinguaHubVoice;
      if (!voice) return;
      try {
        if (typeof voice.stopSpeaking === "function") voice.stopSpeaking();
        if (typeof voice.stop === "function") voice.stop();
      } catch (err) { /* nothing to stop */ }
    }

    doc.addEventListener("keydown", onKeydown);
    doc.addEventListener("keydown", onEscape);
    var menuItem = byId("shortcuts-btn");
    if (menuItem) menuItem.addEventListener("click", openHelp);

    return { openHelp: openHelp, closeHelp: closeHelp, isHelpOpen: function () { return helpState !== null; } };
  }

  return { init: init, actionFor: actionFor, isMacPlatform: isMacPlatform, SECTIONS: SECTIONS };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = LinguaHubShortcuts;
}

if (typeof window !== "undefined") {
  window.LinguaHubShortcuts = LinguaHubShortcuts;
  if (typeof document !== "undefined") {
    var startShortcuts = function () { window.linguahubShortcuts = LinguaHubShortcuts.init(); };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", startShortcuts);
    else startShortcuts();
  }
}
