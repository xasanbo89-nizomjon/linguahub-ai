// LinguaHub AI - custom desktop title bar.
//
// Only active inside the Electron app, where preload.js exposes
// window.linguahubDesktop. In a browser or the Capacitor Android webview
// that object does not exist, this file does nothing, and the title-bar
// markup stays display:none (see "Desktop title bar" in styles.css).
//
// Loaded as a blocking <script> in <head> (right after theme.js) so
// data-desktop is on <html> before first paint - the title-bar height is
// reserved by CSS from that attribute, so the layout never jumps.
(function () {
  "use strict";

  var api = window.linguahubDesktop;
  if (!api) return;

  var root = document.documentElement;
  root.setAttribute("data-desktop", api.platform || "desktop");

  function setMaximized(isMaximized) {
    var maximized = Boolean(isMaximized);
    if (maximized) root.setAttribute("data-maximized", "");
    else root.removeAttribute("data-maximized");

    var toggle = document.getElementById("titlebar-maximize-btn");
    if (!toggle) return;
    var label = maximized ? "Restore" : "Maximize";
    toggle.setAttribute("aria-label", label);
    toggle.setAttribute("title", label);
  }

  function init() {
    var bar = document.getElementById("titlebar");
    if (!bar) return;

    var actions = {
      minimize: api.minimize,
      "toggle-maximize": api.toggleMaximize,
      close: api.close
    };
    bar.addEventListener("click", function (event) {
      var button = event.target.closest ? event.target.closest("[data-titlebar-action]") : null;
      if (!button || !bar.contains(button)) return;
      var action = actions[button.getAttribute("data-titlebar-action")];
      if (action) action();
    });

    api.isMaximized().then(setMaximized, function () { /* keep the default icon */ });
    api.onMaximizeChange(setMaximized);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
