// LinguaHub AI - sidebar chat grouping (pure, no DOM).
//
// Pinned chats first, in one "Pinned" group. Everything else is grouped by
// the calendar day of its last update: Today, Yesterday, Previous 7 days,
// Previous 30 days, then one group per month ("March 2026"). Groups appear in
// that order (newest first); chats keep their incoming order inside a group.

var LinguaHubChatGroups = (function () {
  "use strict";

  var DAY_MS = 86400000;

  function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  }

  // Whole calendar days between `date` and `now` (0 = same day). Uses local
  // midnights, so daylight-saving shifts never skew a day boundary.
  function daysAgo(date, now) {
    return Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);
  }

  function monthLabel(date, locale) {
    try {
      return date.toLocaleString(locale || undefined, { month: "long", year: "numeric" });
    } catch (err) {
      return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0");
    }
  }

  // Returns { key, label, order } for one conversation's update time.
  // order sorts the groups newest-first (smaller = newer).
  function bucketFor(updatedAt, now, locale) {
    var date = new Date(updatedAt);
    if (isNaN(date.getTime())) return { key: "older", label: "Older", order: Number.MAX_SAFE_INTEGER };
    var days = daysAgo(date, now);
    if (days <= 0) return { key: "today", label: "Today", order: 0 };
    if (days === 1) return { key: "yesterday", label: "Yesterday", order: 1 };
    if (days <= 7) return { key: "week", label: "Previous 7 days", order: 2 };
    if (days <= 30) return { key: "month", label: "Previous 30 days", order: 3 };
    var monthKey = date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0");
    // Months sort newest first: later months have a smaller order.
    return { key: "m:" + monthKey, label: monthLabel(date, locale), order: 1000000 - (date.getFullYear() * 12 + date.getMonth()) };
  }

  function groupConversations(conversations, now, locale) {
    var reference = now instanceof Date ? now : new Date();
    var pinned = [];
    var buckets = {};
    var order = [];

    (conversations || []).forEach(function (conv) {
      if (conv.pinned) { pinned.push(conv); return; }
      var bucket = bucketFor(conv.updatedAt, reference, locale);
      if (!buckets[bucket.key]) {
        buckets[bucket.key] = { key: bucket.key, label: bucket.label, order: bucket.order, items: [] };
        order.push(bucket.key);
      }
      buckets[bucket.key].items.push(conv);
    });

    var groups = [];
    if (pinned.length) groups.push({ key: "pinned", label: "Pinned", items: pinned });
    order
      .map(function (key) { return buckets[key]; })
      .sort(function (a, b) { return a.order - b.order; })
      .forEach(function (g) { groups.push({ key: g.key, label: g.label, items: g.items }); });
    return groups;
  }

  return { groupConversations: groupConversations, bucketFor: bucketFor, daysAgo: daysAgo };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = LinguaHubChatGroups;
}

if (typeof window !== "undefined") {
  window.LinguaHubChatGroups = LinguaHubChatGroups;
}
