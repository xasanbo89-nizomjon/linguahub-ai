// LinguaHub AI - persisted premium visual-mode preference.
// Kept separate from settings-ui.js so it can apply before first paint.
// The toggle lives in Settings > Appearance only (settings-ui.js calls apply()).
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
  }

  apply(read());
  window.LinguaHubWowEffects = { apply: apply, isEnabled: read };
})();
