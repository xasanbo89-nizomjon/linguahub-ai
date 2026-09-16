// LinguaHub AI - persisted premium visual-mode preference.
// Kept separate from settings-ui.js so it can apply before first paint.
(function () {
  "use strict";

  var KEY = "linguahub-ai:settings";
  var root = document.documentElement;

  function read() {
    try {
      var value = JSON.parse(window.localStorage.getItem(KEY) || "{}");
      return value && value.wowEffects === true;
    } catch (error) {
      return false;
    }
  }

  function apply(enabled) {
    root.toggleAttribute("data-wow-effects", Boolean(enabled));
    var button = document.getElementById("wow-mode-btn");
    if (button) button.setAttribute("aria-pressed", String(Boolean(enabled)));
  }

  apply(read());
  document.addEventListener("DOMContentLoaded", function () {
    var button = document.getElementById("wow-mode-btn");
    if (!button) return;
    apply(read());
    button.addEventListener("click", function () {
      var enabled = !root.hasAttribute("data-wow-effects");
      try {
        var stored = JSON.parse(window.localStorage.getItem(KEY) || "{}");
        stored = stored && typeof stored === "object" ? stored : {};
        stored.wowEffects = enabled;
        window.localStorage.setItem(KEY, JSON.stringify(stored));
      } catch (error) { /* Visual preference is optional. */ }
      apply(enabled);
    });
  });
  window.LinguaHubWowEffects = { apply: apply, isEnabled: read };
})();
