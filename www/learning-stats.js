// LinguaHub AI - learning statistics helpers (pure, no DOM, no storage).
//
// Activity is recorded as local calendar days ("YYYY-MM-DD") by
// www/learning-memory.js; the day streak is derived here.

var LinguaHubLearningStats = (function () {
  "use strict";

  var DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

  function dayKey(date) {
    var d = date instanceof Date ? date : new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  function parseDay(key) {
    var p = key.split("-");
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  // Whole local calendar days from a to b (b later = positive).
  function daysBetween(a, b) {
    return Math.round((parseDay(b).getTime() - parseDay(a).getTime()) / 86400000);
  }

  function cleanDays(dates) {
    var seen = {};
    return (Array.isArray(dates) ? dates : []).filter(function (d) {
      if (typeof d !== "string" || !DAY_RE.test(d) || seen[d]) return false;
      seen[d] = true;
      return true;
    }).sort();
  }

  // Consecutive days up to today. A streak is still alive on the morning
  // after the last active day (today just has not been practised yet), and
  // is broken once a whole day has been skipped.
  function streak(dates, now) {
    var days = cleanDays(dates);
    if (!days.length) return 0;
    var today = dayKey(now || new Date());
    var last = days[days.length - 1];
    var gap = daysBetween(last, today);
    if (gap < 0 || gap > 1) return 0;
    var count = 1;
    for (var i = days.length - 1; i > 0; i -= 1) {
      if (daysBetween(days[i - 1], days[i]) === 1) count += 1;
      else break;
    }
    return count;
  }

  function practisedToday(dates, now) {
    return cleanDays(dates).indexOf(dayKey(now || new Date())) !== -1;
  }

  // The union of two activity histories (used when another device's copy arrives).
  function mergeDays(a, b) {
    return cleanDays((Array.isArray(a) ? a : []).concat(Array.isArray(b) ? b : []));
  }

  return { dayKey: dayKey, streak: streak, practisedToday: practisedToday, mergeDays: mergeDays, cleanDays: cleanDays, daysBetween: daysBetween };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = LinguaHubLearningStats;
}

if (typeof window !== "undefined") {
  window.LinguaHubLearningStats = LinguaHubLearningStats;
}
