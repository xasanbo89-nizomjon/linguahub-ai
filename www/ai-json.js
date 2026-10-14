// LinguaHub AI - requests to the learning modes (translate, grammar, speak,
// vocabulary, word-lookup), which answer with one JSON object.
//
// The model's reply is never trusted to be JSON: it is parsed defensively
// (code fences, text around the object), checked by the caller's normalize()
// function, and if it still is not the expected shape the plain reply text is
// handed back so the screen can show it instead of failing. Errors become one
// friendly sentence; raw status codes never reach the user.

var LinguaHubAI = (function () {
  "use strict";

  // The first JSON object in a model reply, or null.
  function parseJsonReply(text) {
    if (typeof text !== "string") return null;
    var s = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    function tryParse(candidate) {
      try {
        var value = JSON.parse(candidate);
        return value && typeof value === "object" && !Array.isArray(value) ? value : null;
      } catch (err) {
        return null;
      }
    }
    var direct = tryParse(s);
    if (direct) return direct;
    var start = s.indexOf("{");
    var end = s.lastIndexOf("}");
    return start !== -1 && end > start ? tryParse(s.slice(start, end + 1)) : null;
  }

  function isOffline() {
    return typeof navigator !== "undefined" && navigator.onLine === false;
  }

  function describeError(err) {
    var status = err && err.status;
    if (isOffline()) return "You're offline. Check your connection, then try again.";
    if (status === 429) return "You're sending requests too quickly. Wait a moment, then try again.";
    if (status === 401 || status === 403) return "Your session isn't authorized for this request. Sign in again, then try again.";
    if (status === 400 || status === 413 || status === 422) return "That text couldn't be processed - it may be too long. Shorten it and try again.";
    if (status >= 500) return "The AI service ran into a problem. Please try again in a moment.";
    return "Couldn't reach the AI service. Check your connection and try again.";
  }

  function apiUrl(path) {
    return window.LINGUAHUB_CONFIG && window.LINGUAHUB_CONFIG.apiUrl ? window.LINGUAHUB_CONFIG.apiUrl(path) : path;
  }

  async function authHeaders() {
    var auth = window.LinguaHubAuth;
    if (!auth || !auth.isAvailable || !auth.isAvailable() || !auth.getCurrentUser()) return {};
    try {
      var token = await auth.getIdToken();
      return token ? { Authorization: "Bearer " + token } : {};
    } catch (err) {
      return {};
    }
  }

  // options: { mode, messages: [{role, content}], signal, normalize(obj) -> obj|null }
  // resolves { data: normalized object | null, text: raw reply }
  // rejects  Error with .userMessage (friendly), .status, .aborted
  async function request(options) {
    var response;
    try {
      response = await fetch(apiUrl("/api/chat"), {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, await authHeaders()),
        body: JSON.stringify({ mode: options.mode, messages: options.messages }),
        signal: options.signal
      });
    } catch (err) {
      var failure = new Error(err && err.name === "AbortError" ? "aborted" : "network");
      failure.aborted = Boolean(err && err.name === "AbortError");
      failure.userMessage = failure.aborted ? "" : describeError(err);
      throw failure;
    }

    if (!response.ok) {
      var httpError = new Error("http " + response.status);
      httpError.status = response.status;
      httpError.userMessage = describeError(httpError);
      throw httpError;
    }

    var body;
    try {
      body = await response.json();
    } catch (err) {
      var badBody = new Error("bad response");
      badBody.userMessage = describeError({ status: 502 });
      throw badBody;
    }
    var text = body && typeof body.reply === "string" ? body.reply : "";
    var parsed = parseJsonReply(text);
    var data = null;
    if (parsed) {
      try { data = typeof options.normalize === "function" ? options.normalize(parsed) : parsed; } catch (err) { data = null; }
    }
    return { data: data || null, text: text };
  }

  function nameOf(code) {
    return window.LinguaHubLanguages ? window.LinguaHubLanguages.nameOf(code) : code;
  }

  // The message formats the backend prompts (lib/aiModes.js) expect.
  // The level chosen in onboarding (kept with the learning settings); "" when unknown.
  function learnerLevel() {
    try {
      var memory = window.LinguaHubLearningMemory;
      var level = memory && memory.get ? memory.get().level : "";
      return level === "beginner" || level === "intermediate" || level === "advanced" ? level : "";
    } catch (err) {
      return "";
    }
  }

  var prompts = {
    translate: function (source, target, text) {
      return "Source language: " + (source === "auto" ? "detect it automatically" : nameOf(source)) +
        "\nTarget language: " + nameOf(target) + "\n\nText to translate:\n" + text;
    },
    grammar: function (pair, text) {
      var level = learnerLevel();
      return "Writing language: " + nameOf(pair.to) + "\nLearner's native language: " + nameOf(pair.from) + (level ? "\nLearner level: " + level : "") + "\n\nText:\n" + text;
    },
    speak: function (pair, utterance) {
      var level = learnerLevel();
      return "[Practice language: " + nameOf(pair.to) + " | Native language: " + nameOf(pair.from) + (level ? " | Level: " + level : "") + "]\n" + utterance;
    },
    vocabulary: function (pair, topic) {
      var level = learnerLevel();
      return "Practice language: " + nameOf(pair.to) + "\nLearner's native language: " + nameOf(pair.from) + (level ? "\nLearner level: " + level : "") + "\nTopic: " + topic;
    },
    lookup: function (pair, word, sentence) {
      return "Language A (the learner's native language): " + nameOf(pair.from) +
        "\nLanguage B (the language being learned): " + nameOf(pair.to) +
        "\nWord: " + word + (sentence ? "\nSentence it appeared in: " + sentence : "");
    }
  };

  // ---- normalizers: the shape each screen needs, or null ------------------------------------------

  function str(value, max) {
    return typeof value === "string" ? value.trim().slice(0, max || 4000) : "";
  }

  function normalizeTranslate(obj) {
    var translation = str(obj.translation, 8000);
    if (!translation) return null;
    var detected = str(obj.detected, 12).toLowerCase().slice(0, 2);
    return { detected: /^[a-z]{2}$/.test(detected) ? detected : "", translation: translation };
  }

  function normalizeSpeak(obj) {
    var reply = str(obj.reply, 1500);
    if (!reply) return null;
    var kinds = ["grammar", "pronunciation", "vocabulary"];
    var notes = (Array.isArray(obj.notes) ? obj.notes : []).map(function (n) {
      return n && typeof n === "object" ? { kind: kinds.indexOf(n.kind) !== -1 ? n.kind : "grammar", text: str(n.text, 300) } : null;
    }).filter(function (n) { return n && n.text; }).slice(0, 2);
    return { reply: reply, notes: notes };
  }

  function normalizeLookup(obj) {
    var translation = str(obj.translation, 200);
    if (!translation) return null;
    var language = str(obj.language, 12).toLowerCase().slice(0, 2);
    return {
      language: /^[a-z]{2}$/.test(language) ? language : "",
      translation: translation,
      partOfSpeech: str(obj.partOfSpeech, 30),
      example: str(obj.example, 300),
      exampleTranslation: str(obj.exampleTranslation, 300)
    };
  }

  function normalizeWords(obj) {
    var list = Array.isArray(obj.words) ? obj.words : [];
    var words = list.map(function (w) {
      if (!w || typeof w !== "object") return null;
      var word = str(w.word, 80);
      var translation = str(w.translation, 200);
      return word && translation ? { word: word, translation: translation, partOfSpeech: str(w.partOfSpeech, 30), example: str(w.example, 300) } : null;
    }).filter(Boolean).slice(0, 8);
    return words.length ? { words: words } : null;
  }

  return {
    request: request,
    parseJsonReply: parseJsonReply,
    describeError: describeError,
    prompts: prompts,
    normalizeTranslate: normalizeTranslate,
    normalizeSpeak: normalizeSpeak,
    normalizeLookup: normalizeLookup,
    normalizeWords: normalizeWords
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = LinguaHubAI;
}

if (typeof window !== "undefined") {
  window.LinguaHubAI = LinguaHubAI;
}
