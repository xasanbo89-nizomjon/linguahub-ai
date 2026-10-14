// LinguaHub AI - the learner's saved words and their spaced-repetition
// schedule. Local first (localStorage, one list per guest / signed-in
// account, like chats); www/vocab-sync.js mirrors it to Firestore.
//
// Scheduling is a small SM-2 variant with whole-day intervals:
//   Again  - back in 10 minutes, ease drops, the streak of successes resets
//   Hard   - a short step, ease drops a little
//   Good   - the normal step (1 day, then 6 days, then interval x ease)
//   Easy   - a longer step and a higher ease

var LinguaHubVocab = (function () {
  "use strict";

  var SCHEMA_VERSION = 1;
  var LIMITS = { maxWords: 2000, word: 80, translation: 200, example: 300, partOfSpeech: 30 };
  var GRADES = ["again", "hard", "good", "easy"];
  var QUALITY = { again: 1, hard: 3, good: 4, easy: 5 };
  var AGAIN_DELAY_MS = 10 * 60 * 1000;
  var DAY_MS = 86400000;
  var MIN_EASE = 1.3;
  var START_EASE = 2.5;

  function cleanText(value, max) {
    return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
  }

  function normalizeWord(word) {
    return cleanText(word, LIMITS.word).toLowerCase();
  }

  function startOfDay(ms) {
    var d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }

  function endOfDay(ms) {
    return startOfDay(ms) + DAY_MS - 1;
  }

  function generateId() {
    var random;
    if (typeof crypto !== "undefined" && crypto.randomUUID) random = crypto.randomUUID();
    else random = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    return "w_" + random;
  }

  // ---- scheduling (pure) ----------------------------------------------------------------------

  function newSrs(nowMs) {
    return { ease: START_EASE, interval: 0, reps: 0, lapses: 0, due: new Date(nowMs).toISOString() };
  }

  function sanitizeSrs(raw, fallbackNow) {
    var s = raw && typeof raw === "object" ? raw : {};
    var due = Date.parse(s.due);
    return {
      ease: typeof s.ease === "number" && s.ease >= MIN_EASE && s.ease <= 4 ? s.ease : START_EASE,
      interval: Number.isFinite(s.interval) && s.interval >= 0 && s.interval <= 3650 ? Math.round(s.interval) : 0,
      reps: Number.isFinite(s.reps) && s.reps >= 0 ? Math.min(Math.round(s.reps), 10000) : 0,
      lapses: Number.isFinite(s.lapses) && s.lapses >= 0 ? Math.min(Math.round(s.lapses), 10000) : 0,
      due: new Date(Number.isFinite(due) ? due : fallbackNow).toISOString()
    };
  }

  // The next state after answering with `grade`. Never mutates its input.
  function schedule(srs, grade, nowMs) {
    if (GRADES.indexOf(grade) === -1) throw new Error("unknown grade: " + grade);
    var now = typeof nowMs === "number" ? nowMs : Date.now();
    var cur = sanitizeSrs(srs, now);
    var q = QUALITY[grade];

    if (grade === "again") {
      return {
        ease: Math.max(MIN_EASE, +(cur.ease - 0.2).toFixed(2)),
        interval: 0,
        reps: 0,
        lapses: cur.lapses + 1,
        due: new Date(now + AGAIN_DELAY_MS).toISOString()
      };
    }

    var interval;
    if (cur.reps === 0) interval = grade === "hard" ? 1 : grade === "good" ? 1 : 3;
    else if (cur.reps === 1) interval = grade === "hard" ? 3 : grade === "good" ? 6 : 8;
    else {
      var multiplier = grade === "hard" ? 1.2 : grade === "good" ? cur.ease : cur.ease * 1.3;
      interval = Math.max(cur.interval + 1, Math.round(cur.interval * multiplier));
    }
    interval = Math.min(interval, 3650);

    var ease = Math.max(MIN_EASE, +(cur.ease + 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)).toFixed(2));
    return {
      ease: ease,
      interval: interval,
      reps: cur.reps + 1,
      lapses: cur.lapses,
      due: new Date(startOfDay(now) + interval * DAY_MS).toISOString()
    };
  }

  // Days until the next review for each answer, shown on the buttons
  // (0 means "again in a few minutes").
  function previewIntervals(srs, nowMs) {
    var out = {};
    GRADES.forEach(function (g) { out[g] = schedule(srs, g, nowMs).interval; });
    return out;
  }

  // ---- sanitising ------------------------------------------------------------------------------

  // Anything that comes from storage, a sync document or an import is untrusted text.
  function sanitizeWord(raw, nowMs) {
    if (!raw || typeof raw !== "object") return null;
    var word = cleanText(raw.word, LIMITS.word);
    var translation = cleanText(raw.translation, LIMITS.translation);
    var lang = cleanText(raw.lang, 8).toLowerCase();
    if (!word || !translation || !lang) return null;
    var now = typeof nowMs === "number" ? nowMs : Date.now();
    var created = Date.parse(raw.createdAt);
    var updated = Number(raw.updatedAt);
    return {
      id: typeof raw.id === "string" && /^[A-Za-z0-9_-]{3,80}$/.test(raw.id) ? raw.id : generateId(),
      word: word,
      translation: translation,
      lang: lang,
      partOfSpeech: cleanText(raw.partOfSpeech, LIMITS.partOfSpeech),
      example: cleanText(raw.example, LIMITS.example),
      exampleTranslation: cleanText(raw.exampleTranslation, LIMITS.example),
      createdAt: new Date(Number.isFinite(created) ? created : now).toISOString(),
      updatedAt: Number.isFinite(updated) && updated > 0 ? updated : now,
      srs: sanitizeSrs(raw.srs, now)
    };
  }

  // ---- the store -----------------------------------------------------------------------------------

  function create(options) {
    var storage = (options && options.storage) || (typeof window !== "undefined" ? window.localStorage : null);
    var clock = (options && options.now) || function () { return Date.now(); };
    var namespace = "guest";
    var listeners = [];

    function key() { return "linguahub-ai:vocab:" + namespace; }

    function read() { return readNamespace(namespace); }

    function readNamespace(ns) {
      try {
        var parsed = JSON.parse(storage.getItem("linguahub-ai:vocab:" + ns) || "null");
        var list = parsed && Array.isArray(parsed.words) ? parsed.words : [];
        var out = [];
        var seen = {};
        list.forEach(function (raw) {
          var w = sanitizeWord(raw, clock());
          if (!w || seen[w.id]) return;
          seen[w.id] = true;
          out.push(w);
        });
        return out;
      } catch (err) {
        return [];
      }
    }

    function write(words) {
      try {
        storage.setItem(key(), JSON.stringify({ schemaVersion: SCHEMA_VERSION, words: words }));
        return true;
      } catch (err) {
        return false;
      }
    }

    function emit(event) {
      listeners.slice().forEach(function (cb) { try { cb(event); } catch (err) { /* ignore */ } });
    }

    function sameWord(a, lang, normalized) {
      return a.lang === lang && normalizeWord(a.word) === normalized;
    }

    function find(words, id) {
      for (var i = 0; i < words.length; i += 1) if (words[i].id === id) return i;
      return -1;
    }

    // Saves a word. A word already in the list (same language, same spelling
    // ignoring case) is not added twice; the existing entry is returned.
    function add(entry) {
      var now = clock();
      var candidate = sanitizeWord(Object.assign({}, entry, { id: undefined, srs: undefined, createdAt: undefined, updatedAt: undefined }), now);
      if (!candidate) return { ok: false, reason: "invalid-word" };
      var words = read();
      var normalized = normalizeWord(candidate.word);
      for (var i = 0; i < words.length; i += 1) {
        if (sameWord(words[i], candidate.lang, normalized)) return { ok: true, duplicate: true, word: words[i] };
      }
      if (words.length >= LIMITS.maxWords) return { ok: false, reason: "word-limit-reached" };
      candidate.srs = newSrs(now);
      words.push(candidate);
      if (!write(words)) return { ok: false, reason: "storage-error" };
      emit({ type: "changed", id: candidate.id });
      return { ok: true, duplicate: false, word: candidate };
    }

    function remove(id) {
      var words = read();
      var index = find(words, id);
      if (index === -1) return { ok: false, reason: "not-found" };
      var removed = words.splice(index, 1)[0];
      if (!write(words)) return { ok: false, reason: "storage-error" };
      emit({ type: "deleted", id: id });
      return { ok: true, word: removed };
    }

    function review(id, grade, nowMs) {
      var now = typeof nowMs === "number" ? nowMs : clock();
      var words = read();
      var index = find(words, id);
      if (index === -1) return { ok: false, reason: "not-found" };
      words[index].srs = schedule(words[index].srs, grade, now);
      words[index].updatedAt = now;
      if (!write(words)) return { ok: false, reason: "storage-error" };
      emit({ type: "changed", id: id });
      return { ok: true, word: words[index] };
    }

    // query: substring of the word or its translation (case-insensitive);
    // lang: only words in that language ("all" / empty = every language).
    function list(filter) {
      var f = filter || {};
      var q = cleanText(f.query, 80).toLowerCase();
      var lang = f.lang && f.lang !== "all" ? f.lang : null;
      return read().filter(function (w) {
        if (lang && w.lang !== lang) return false;
        if (!q) return true;
        return w.word.toLowerCase().indexOf(q) !== -1 || w.translation.toLowerCase().indexOf(q) !== -1;
      }).sort(function (a, b) { return Date.parse(b.createdAt) - Date.parse(a.createdAt); });
    }

    // Words due by the END of today, most overdue first.
    function due(nowMs) {
      var limit = endOfDay(typeof nowMs === "number" ? nowMs : clock());
      return read().filter(function (w) { return Date.parse(w.srs.due) <= limit; })
        .sort(function (a, b) { return Date.parse(a.srs.due) - Date.parse(b.srs.due); });
    }

    function stats(nowMs) {
      var words = read();
      var limit = endOfDay(typeof nowMs === "number" ? nowMs : clock());
      return {
        total: words.length,
        // learned: answered correctly at least twice in a row (the interval has reached 6+ days)
        learned: words.filter(function (w) { return w.srs.reps >= 2; }).length,
        due: words.filter(function (w) { return Date.parse(w.srs.due) <= limit; }).length
      };
    }

    function languages() {
      var seen = {};
      read().forEach(function (w) { seen[w.lang] = true; });
      return Object.keys(seen).sort();
    }

    return {
      setUserId: function (uid) { namespace = uid ? "user:" + uid : "guest"; emit({ type: "namespace" }); },
      getNamespace: function () { return namespace; },
      add: add,
      remove: remove,
      review: review,
      list: list,
      due: due,
      stats: stats,
      languages: languages,
      get: function (id) { var words = read(); var i = find(words, id); return i === -1 ? null : words[i]; },
      has: function (word, lang) {
        var normalized = normalizeWord(word);
        return read().some(function (w) { return sameWord(w, lang, normalized); });
      },
      all: read,
      // sync support: apply a word from another device exactly as it arrived
      upsert: function (raw) {
        var word = sanitizeWord(raw, clock());
        if (!word) return { ok: false, reason: "invalid-word" };
        var words = read();
        var index = find(words, word.id);
        if (index === -1) {
          if (words.length >= LIMITS.maxWords) return { ok: false, reason: "word-limit-reached" };
          words.push(word);
        } else words[index] = word;
        if (!write(words)) return { ok: false, reason: "storage-error" };
        return { ok: true, word: word, created: index === -1 };
      },
      removeSilently: function (id) {
        var words = read();
        var index = find(words, id);
        if (index === -1) return { ok: false };
        words.splice(index, 1);
        return { ok: write(words) };
      },
      // The words saved while signed out (the guest list). Read-only: signing
      // in switches to the account's own list and leaves these alone.
      listGuestWords: function () { return readNamespace("guest"); },
      // Adds words (e.g. the guest ones) to the CURRENT list as they are,
      // schedule included. Words already there (same id, or same language and
      // spelling) are skipped; stops at the word limit. Never removes anything.
      mergeWords: function (list) {
        var words = read();
        var added = 0;
        var skipped = 0;
        (Array.isArray(list) ? list : []).forEach(function (raw) {
          var word = sanitizeWord(raw, clock());
          if (!word || find(words, word.id) !== -1 || words.some(function (w) { return sameWord(w, word.lang, normalizeWord(word.word)); }) || words.length >= LIMITS.maxWords) {
            skipped += 1;
            return;
          }
          word.updatedAt = clock(); // newer than anything an older copy elsewhere may hold
          words.push(word);
          added += 1;
        });
        if (!added) return { ok: true, added: 0, skipped: skipped };
        if (!write(words)) return { ok: false, reason: "storage-error" };
        emit({ type: "changed" });
        return { ok: true, added: added, skipped: skipped };
      },
      // undo of a delete: the same word (same id, same schedule), newer than any tombstone
      restore: function (raw) {
        var word = sanitizeWord(raw, clock());
        if (!word) return { ok: false, reason: "invalid-word" };
        word.updatedAt = clock();
        var words = read();
        var index = find(words, word.id);
        if (index === -1) {
          if (words.length >= LIMITS.maxWords) return { ok: false, reason: "word-limit-reached" };
          words.push(word);
        } else words[index] = word;
        if (!write(words)) return { ok: false, reason: "storage-error" };
        emit({ type: "changed", id: word.id });
        return { ok: true, word: word };
      },
      // sync applied changes from another device: tell the screens to redraw
      notifyRemoteChange: function () { emit({ type: "remote" }); },
      subscribe: function (cb) {
        listeners.push(cb);
        return function () { listeners = listeners.filter(function (x) { return x !== cb; }); };
      }
    };
  }

  return {
    LIMITS: LIMITS,
    GRADES: GRADES,
    create: create,
    schedule: schedule,
    previewIntervals: previewIntervals,
    newSrs: newSrs,
    sanitizeWord: sanitizeWord,
    normalizeWord: normalizeWord,
    startOfDay: startOfDay,
    endOfDay: endOfDay
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = LinguaHubVocab;
}

if (typeof window !== "undefined") {
  window.LinguaHubVocab = LinguaHubVocab;
  try { window.linguahubVocab = LinguaHubVocab.create(); } catch (err) { /* no storage */ }
}
