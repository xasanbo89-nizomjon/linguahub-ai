// LinguaHub AI - header "..." chat actions menu.
//
// Pure presentation: opens/closes the menu in #chat-menu. The items inside
// (#clear-chat-btn, #tutor-dashboard-btn) keep their own click handlers from
// history-ui.js / tutor-dashboard.js; this file only shows and hides them.
// Keyboard: Enter/Space/ArrowDown on the button opens it, ArrowUp/ArrowDown/
// Home/End move between items, Escape closes and returns focus to the
// button, Tab or an outside click closes it.
(function () {
  "use strict";

  function init() {
    var root = document.getElementById("chat-menu");
    var button = document.getElementById("chat-menu-btn");
    var list = document.getElementById("chat-menu-list");
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

    function open(focusIndex) {
      list.hidden = false;
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

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
