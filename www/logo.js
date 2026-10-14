// LinguaHub AI - the logo: a speech bubble holding letters from three scripts
// (Latin A, Cyrillic Я, Arabic ع). One geometry, drawn here for the places
// that build markup at runtime (assistant message avatars, the dashboard);
// index.html carries the same paths for the static spots, and www/logo.svg
// (the source for the app icons and the favicon) is identical too - a test
// keeps all three in sync. Colours come from theme tokens in styles.css
// (.lh-logo-bubble = --accent, .lh-logo-glyphs = --on-accent).

var LinguaHubLogo = (function () {
  "use strict";

  var BUBBLE = "M36 10H92A28 28 0 0 1 120 38V66A28 28 0 0 1 92 94H58L34 116V94H36A28 28 0 0 1 8 66V38A28 28 0 0 1 36 10Z";
  var GLYPHS = [
    "M22 70L34 34L46 70M27 57H41",
    "M74 70V34H64C55 34 55 52 64 52H74M64 52L56 70",
    "M101 36C95 31 86 34 88 41C89 45 94 47 97 48C89 47 83 50 83 58C83 67 93 71 102 65"
  ];
  var NS = "http://www.w3.org/2000/svg";

  // The SVG as a string, for templates. className is trusted (callers pass literals).
  function markup(className) {
    return '<svg class="' + (className || "lh-logo") + '" viewBox="0 0 128 128" aria-hidden="true" focusable="false">' +
      '<path class="lh-logo-bubble" d="' + BUBBLE + '"/>' +
      '<g class="lh-logo-glyphs">' + GLYPHS.map(function (d) { return '<path d="' + d + '"/>'; }).join("") + "</g></svg>";
  }

  // The SVG as a DOM element.
  function create(className) {
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", className || "lh-logo");
    svg.setAttribute("viewBox", "0 0 128 128");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    var bubble = document.createElementNS(NS, "path");
    bubble.setAttribute("class", "lh-logo-bubble");
    bubble.setAttribute("d", BUBBLE);
    svg.appendChild(bubble);
    var group = document.createElementNS(NS, "g");
    group.setAttribute("class", "lh-logo-glyphs");
    GLYPHS.forEach(function (d) {
      var path = document.createElementNS(NS, "path");
      path.setAttribute("d", d);
      group.appendChild(path);
    });
    svg.appendChild(group);
    return svg;
  }

  return { BUBBLE: BUBBLE, GLYPHS: GLYPHS, markup: markup, create: create };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = LinguaHubLogo;
}

if (typeof window !== "undefined") {
  window.LinguaHubLogo = LinguaHubLogo;
}
