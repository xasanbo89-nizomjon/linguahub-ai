// LinguaHub AI - chat search (pure, no DOM): matches chat titles AND message
// content, and returns what the palette needs to render a result - highlight
// ranges for the title, a short snippet around the first match, and the id of
// the message that matched (so opening the chat can scroll to it).
//
// Matching is case-insensitive. Every word of the query must appear somewhere
// in the chat (its title or any of its messages); the snippet comes from the
// message that matches the most words, newest first on ties.

var LinguaHubChatSearch = (function () {
  "use strict";

  var MAX_TERMS = 6;
  var MAX_INDEXED_CHARS = 6000; // per message: keeps indexing fast on huge replies
  var SNIPPET_BEFORE = 36;
  var SNIPPET_AFTER = 110;

  // Lower-cases without ever changing the string's length (a few characters,
  // e.g. "İ", lower-case to two code units), so match positions found in the
  // folded text are valid positions in the original text.
  function fold(text) {
    var out = "";
    var chars = Array.from(String(text));
    for (var i = 0; i < chars.length; i += 1) {
      var lower = chars[i].toLowerCase();
      out += lower.length === chars[i].length ? lower : chars[i];
    }
    return out;
  }

  function splitTerms(query) {
    var seen = {};
    var terms = [];
    fold(String(query || "")).split(/\s+/).forEach(function (term) {
      if (term && !seen[term] && terms.length < MAX_TERMS) { seen[term] = true; terms.push(term); }
    });
    return terms;
  }

  // Every occurrence of every term inside `foldedText`, merged and sorted.
  function rangesIn(foldedText, terms) {
    var ranges = [];
    terms.forEach(function (term) {
      var from = 0;
      var index;
      while ((index = foldedText.indexOf(term, from)) !== -1) {
        ranges.push([index, index + term.length]);
        from = index + term.length;
      }
    });
    ranges.sort(function (a, b) { return a[0] - b[0] || b[1] - a[1]; });
    var merged = [];
    ranges.forEach(function (r) {
      var last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push([r[0], r[1]]);
    });
    return merged;
  }

  // Built once per palette session; querying then never re-folds any text.
  function createIndex(conversations) {
    return (conversations || []).map(function (conv) {
      var title = String(conv.title || "");
      return {
        conv: conv,
        title: title,
        titleFold: fold(title),
        messages: (conv.messages || []).map(function (m) {
          var content = String(m.content || "");
          return { id: m.id, role: m.role, content: content, fold: fold(content.slice(0, MAX_INDEXED_CHARS)) };
        })
      };
    });
  }

  function makeSnippet(content, foldedContent, terms) {
    var first = -1;
    terms.forEach(function (term) {
      var i = foldedContent.indexOf(term);
      if (i !== -1 && (first === -1 || i < first)) first = i;
    });
    if (first === -1) first = 0;
    var start = Math.max(0, first - SNIPPET_BEFORE);
    if (start > 0) {
      // do not start mid-word
      var space = content.indexOf(" ", start);
      if (space !== -1 && space < first) start = space + 1;
    }
    var end = Math.min(content.length, first + SNIPPET_AFTER);
    var text = content.slice(start, end).replace(/[\r\n\t]/g, " "); // same length: ranges stay valid
    var prefix = start > 0 ? "…" : "";
    var suffix = end < content.length ? "…" : "";
    var ranges = rangesIn(fold(text), terms).map(function (r) { return [r[0] + prefix.length, r[1] + prefix.length]; });
    return { text: prefix + text + suffix, ranges: ranges };
  }

  function query(index, rawQuery, options) {
    var limit = (options && options.limit) || 50;
    var terms = splitTerms(rawQuery);
    if (!terms.length) return [];

    var results = [];
    index.forEach(function (entry) {
      var covered = {};
      var titleTermCount = 0;
      terms.forEach(function (term) {
        if (entry.titleFold.indexOf(term) !== -1) { covered[term] = true; titleTermCount += 1; }
      });

      var best = null;
      // newest message first, so ties prefer the most recent match
      for (var i = entry.messages.length - 1; i >= 0; i -= 1) {
        var message = entry.messages[i];
        var count = 0;
        terms.forEach(function (term) {
          if (message.fold.indexOf(term) !== -1) { count += 1; covered[term] = true; }
        });
        if (count && (!best || count > best.count)) best = { message: message, count: count };
      }

      if (Object.keys(covered).length !== terms.length) return;

      var score = titleTermCount === terms.length ? 100 : titleTermCount * 20;
      if (entry.titleFold.indexOf(terms[0]) === 0) score += 25;
      if (best) score += best.count * 10;

      results.push({
        id: entry.conv.id,
        title: entry.title,
        titleRanges: rangesIn(entry.titleFold, terms),
        snippet: best ? makeSnippet(best.message.content, best.message.fold, terms) : null,
        messageId: best ? best.message.id : null,
        updatedAt: entry.conv.updatedAt,
        pinned: Boolean(entry.conv.pinned),
        score: score
      });
    });

    results.sort(function (a, b) {
      return b.score - a.score || new Date(b.updatedAt) - new Date(a.updatedAt);
    });
    return results.slice(0, limit);
  }

  // What to show before anything is typed: the most recently updated chats.
  function recent(index, limit) {
    return index
      .slice()
      .sort(function (a, b) { return new Date(b.conv.updatedAt) - new Date(a.conv.updatedAt); })
      .slice(0, limit || 8)
      .map(function (entry) {
        return { id: entry.conv.id, title: entry.title, titleRanges: [], snippet: null, messageId: null, updatedAt: entry.conv.updatedAt, pinned: Boolean(entry.conv.pinned), score: 0 };
      });
  }

  return { fold: fold, splitTerms: splitTerms, createIndex: createIndex, query: query, recent: recent, rangesIn: rangesIn };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = LinguaHubChatSearch;
}

if (typeof window !== "undefined") {
  window.LinguaHubChatSearch = LinguaHubChatSearch;
}
