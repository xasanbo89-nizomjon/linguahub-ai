// LinguaHub AI - turns the grammar checker's edits into something to draw.
//
// The model returns the corrected text plus a list of edits, each with the
// wrong part copied from the learner's text. Models are sloppy about
// "copied exactly", so every edit is located in the text by searching
// forward from where the previous edit ended; an edit that cannot be found is
// kept aside as an unplaced suggestion instead of corrupting the text.

var LinguaHubGrammarDiff = (function () {
  "use strict";

  var MAX_EDITS = 50;

  // { corrected, edits: [{ original, correction, explanation }] } or null.
  function normalize(obj, originalText) {
    if (!obj || typeof obj !== "object") return null;
    var text = typeof originalText === "string" ? originalText : "";
    var corrected = typeof obj.corrected === "string" && obj.corrected.trim() ? obj.corrected : text;
    var edits = (Array.isArray(obj.edits) ? obj.edits : []).map(function (e) {
      if (!e || typeof e !== "object") return null;
      var original = typeof e.original === "string" ? e.original : "";
      var correction = typeof e.correction === "string" ? e.correction : "";
      if (!original.trim() || original === correction) return null;
      return {
        original: original,
        correction: correction,
        explanation: typeof e.explanation === "string" ? e.explanation.trim().slice(0, 300) : ""
      };
    }).filter(Boolean).slice(0, MAX_EDITS);
    if (typeof obj.corrected !== "string" && !Array.isArray(obj.edits)) return null;
    return { corrected: corrected, edits: edits };
  }

  // Places edits in `text`, in order. Returns { segments, unplaced } where
  // segments alternate { type: "text", text } and { type: "edit", edit, index }.
  function buildSegments(text, edits) {
    var source = String(text || "");
    var segments = [];
    var unplaced = [];
    var cursor = 0;
    var placed = [];

    (edits || []).forEach(function (edit, index) {
      var at = source.indexOf(edit.original, cursor);
      if (at === -1) {
        // out of order: accept an earlier, still-free spot
        var from = 0;
        while (true) {
          var candidate = source.indexOf(edit.original, from);
          if (candidate === -1) break;
          var end = candidate + edit.original.length;
          var overlaps = placed.some(function (p) { return candidate < p.end && end > p.start; });
          if (!overlaps) { at = candidate; break; }
          from = candidate + 1;
        }
      }
      if (at === -1) { unplaced.push(edit); return; }
      placed.push({ start: at, end: at + edit.original.length, edit: edit, index: index });
      if (at >= cursor) cursor = at + edit.original.length;
    });

    placed.sort(function (a, b) { return a.start - b.start; });
    var position = 0;
    placed.forEach(function (p) {
      if (p.start > position) segments.push({ type: "text", text: source.slice(position, p.start) });
      segments.push({ type: "edit", edit: p.edit, index: p.index });
      position = p.end;
    });
    if (position < source.length) segments.push({ type: "text", text: source.slice(position) });
    return { segments: segments, unplaced: unplaced };
  }

  function textOf(segments, applyAll) {
    return segments.map(function (s) {
      return s.type === "text" ? s.text : (applyAll ? s.edit.correction : s.edit.original);
    }).join("");
  }

  // The text after accepting one edit (by its position among the placed
  // segments); the other edits stay exactly as they were.
  function applyOne(text, edits, index) {
    var built = buildSegments(text, edits);
    var done = false;
    var out = built.segments.map(function (s) {
      if (s.type === "edit" && s.index === index && !done) { done = true; return s.edit.correction; }
      return s.type === "text" ? s.text : s.edit.original;
    }).join("");
    return { text: out, remaining: edits.filter(function (e, i) { return i !== index; }), applied: done };
  }

  // Accept everything. When every edit could be placed the result is built
  // from the learner's own text; if some could not, the model's complete
  // corrected text is the safer answer.
  function applyAll(text, edits, corrected) {
    var built = buildSegments(text, edits);
    if (built.unplaced.length && typeof corrected === "string" && corrected.trim()) return corrected;
    return textOf(built.segments, true);
  }

  return { normalize: normalize, buildSegments: buildSegments, applyOne: applyOne, applyAll: applyAll, MAX_EDITS: MAX_EDITS };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = LinguaHubGrammarDiff;
}

if (typeof window !== "undefined") {
  window.LinguaHubGrammarDiff = LinguaHubGrammarDiff;
}
