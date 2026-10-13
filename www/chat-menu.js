// LinguaHub AI - small popover menus: the header "..." chat actions menu and
// the sidebar account menu.
//
// Pure presentation: opens/closes a menu and handles keyboard/focus. The items
// inside keep their own click handlers (history-ui.js, tutor-dashboard.js,
// app.js...); this file only shows and hides them.
// Keyboard: Enter/Space/ArrowDown on the button opens it, ArrowUp/ArrowDown/
// Home/End move between items, Escape closes and returns focus to the
// button, Tab or an outside click closes it.
(function () {
  "use strict";

  // fixedAbove: the menu is positioned in the viewport just above its button
  // (used by the account menu, which lives at the very bottom of a sidebar
  // that clips overflow - and may be only a narrow icon rail when collapsed).
  function setupMenu(config) {
    var root = document.getElementById(config.root);
    var button = document.getElementById(config.button);
    var list = document.getElementById(config.list);
    if (!root || !button || !list) return;

    function items() {
      return Array.prototype.slice.call(list.querySelectorAll('[role="menuitem"]:not(:disabled)'));
    }

    function isOpen() {
      return !list.hidden;
    }

    function close(returnFocus) {
      if (!isOpen()) return;
      list.hidden = true;
      button.setAttribute("aria-expanded", "false");
      if (returnFocus) button.focus();
    }

    function place() {
      if (!config.fixedAbove || typeof button.getBoundingClientRect !== "function") return;
      var rect = button.getBoundingClientRect();
      var width = Math.max(rect.width, 220);
      list.style.position = "fixed";
      list.style.minWidth = width + "px";
      list.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) + "px";
      list.style.bottom = (window.innerHeight - rect.top + 4) + "px";
      list.style.top = "auto";
      list.style.right = "auto";
    }

    function open(focusIndex) {
      list.hidden = false;
      place();
      button.setAttribute("aria-expanded", "true");
      var all = items();
      if (all.length && focusIndex !== null) all[focusIndex === -1 ? all.length - 1 : focusIndex].focus();
    }

    button.addEventListener("click", function () {
      if (isOpen()) close(false);
      else open(null);
    });

    button.addEventListener("keydown", function (event) {
      if (event.key === "ArrowDown") { event.preventDefault(); open(0); }
      else if (event.key === "ArrowUp") { event.preventDefault(); open(-1); }
    });

    list.addEventListener("keydown", function (event) {
      var all = items();
      var index = all.indexOf(document.activeElement);
      if (event.key === "ArrowDown") { event.preventDefault(); all[(index + 1) % all.length].focus(); }
      else if (event.key === "ArrowUp") { event.preventDefault(); all[(index - 1 + all.length) % all.length].focus(); }
      else if (event.key === "Home") { event.preventDefault(); all[0].focus(); }
      else if (event.key === "End") { event.preventDefault(); all[all.length - 1].focus(); }
      else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
      else if (event.key === "Tab") close(false);
    });

    // Capture phase, i.e. before the item's own handler runs: move focus to
    // the (always visible) menu button first. Items like Clear chat open a
    // dialog that restores focus to whatever was focused when it opened - if
    // that were the menu item, it would be hidden by then and focus would be
    // lost.
    list.addEventListener("click", function (event) {
      if (event.target.closest && event.target.closest('[role="menuitem"]')) button.focus();
    }, true);

    // Choosing an item closes the menu; the item's own handler (registered
    // elsewhere) still runs because this listener never stops propagation.
    list.addEventListener("click", function (event) {
      if (event.target.closest && event.target.closest('[role="menuitem"]')) close(false);
    });

    document.addEventListener("click", function (event) {
      if (isOpen() && !root.contains(event.target)) close(false);
    });
  }

  function init() {
    setupMenu({ root: "chat-menu", button: "chat-menu-btn", list: "chat-menu-list" });
    setupMenu({ root: "user-profile", button: "account-menu-btn", list: "account-menu-list", fixedAbove: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
