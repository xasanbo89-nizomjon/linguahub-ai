// LinguaHub AI - the daily free limit, as the person sees it.
//
// The server (lib/aiGate.js) is what enforces it; this file only shows it:
//   - a small counter near the composer for free users: "7 / 10 free today"
//     (warning colour at 2 or fewer left; hidden for Premium and when signed out),
//   - a "Premium" badge in the account menu for premium users,
//   - the paywall when the limit is reached (Free vs Premium, when it renews,
//     the price text from the server), the "Get Premium" dialog with the contact
//     link and "Remind me tomorrow",
//   - a friendly "Sign in to continue, it's free" dialog for anyone who tries an
//     AI feature while signed out.
// The numbers come from GET /api/usage and from the X-Usage-* headers (and the
// "quota" field) of every AI reply, so the counter is always what the server says.

var LinguaHubUsage = (function () {
  "use strict";

  var REMINDER_KEY = "linguahub-ai:premium-reminder";
  var LOW = 2;
  var MAX_TIMER_MS = 2147483000;

  function isHttpsUrl(value) {
    try { return new URL(String(value)).protocol === "https:"; } catch (err) { return false; }
  }

  function parseCount(value) {
    if (value === null || value === undefined || value === "") return null;
    if (value === "unlimited") return "unlimited";
    var n = Number(value);
    return Number.isInteger(n) && n >= 0 ? n : null;
  }

  // When the free requests come back - the day ends at midnight in Tashkent. Shared by the
  // paywall and the chat error text. formatLocal(resetAt) -> "HH:MM" on this person's clock.
  function renewText(resetAt, formatLocal) {
    var local = formatLocal ? formatLocal(resetAt) : "";
    if (!local) return "Free requests renew at 00:00 (Tashkent time).";
    if (local === "00:00") return "Free requests renew at 00:00.";
    return "Free requests renew at 00:00 Tashkent time (" + local + " your time).";
  }

  function create(options) {
    var opts = options || {};
    var doc = opts.document || document;
    var storage = opts.storage !== undefined ? opts.storage : null;
    var now = opts.now || function () { return Date.now(); };
    var setTimer = opts.setTimeout || function (fn, ms) { return setTimeout(fn, ms); };
    var clearTimer = opts.clearTimeout || function (h) { clearTimeout(h); };
    var notify = opts.notify || function () {};
    var counterEl = opts.counterEl || null;
    var badges = opts.premiumEls || {};
    var state = { plan: null, premium: false, limit: null, remaining: null, resetAt: null, premiumUntil: null, priceLabel: "Coming soon", contactUrl: null };
    var modal = null;
    var reminderTimer = null;

    function formatLocal(resetAt) {
      var ms = Date.parse(resetAt);
      if (!Number.isFinite(ms)) return "";
      try { return new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms)); } catch (err) { return ""; }
    }

    function el(tag, className, text) {
      var node = doc.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }

    // ---- counter and badge ----
    function render() {
      var free = Boolean(state.plan) && !state.premium && typeof state.remaining === "number" && typeof state.limit === "number";
      if (counterEl) {
        counterEl.hidden = !free;
        if (free) {
          counterEl.textContent = state.remaining + " / " + state.limit + " free today";
          counterEl.setAttribute("aria-label", state.remaining + " of " + state.limit + " free requests left today");
          counterEl.classList.toggle("is-warning", state.remaining <= LOW);
          counterEl.classList.toggle("is-empty", state.remaining === 0);
        }
      }
      ["badge", "row"].forEach(function (key) { if (badges[key]) badges[key].hidden = !state.premium; });
      if (badges.until) {
        var until = state.premiumUntil ? new Date(state.premiumUntil) : null;
        badges.until.textContent = state.premium && until && !isNaN(until.getTime()) ? "until " + until.toLocaleDateString() : "";
      }
    }

    function clear() {
      state.plan = null; state.premium = false; state.limit = null; state.remaining = null; state.resetAt = null; state.premiumUntil = null;
      render();
    }

    function setFromServer(info) {
      if (!info) return;
      if (info.plan === "premium" || info.premium === true) {
        state.plan = "premium"; state.premium = true; state.limit = null; state.remaining = null;
      } else if (info.plan === "free" || info.premium === false) {
        state.plan = "free"; state.premium = false;
        if (typeof info.limit === "number") state.limit = info.limit;
        if (typeof info.remaining === "number") state.remaining = info.remaining;
      }
      if (info.resetAt) state.resetAt = info.resetAt;
      if (info.premiumUntil !== undefined) state.premiumUntil = info.premiumUntil;
      if (typeof info.priceLabel === "string" && info.priceLabel) state.priceLabel = info.priceLabel;
      if (info.contactUrl !== undefined) state.contactUrl = isHttpsUrl(info.contactUrl) ? info.contactUrl : null;
      render();
    }

    // the "quota" field of an AI reply: { plan, premium, limit, remaining, resetAt }
    function fromQuota(quota) {
      if (quota && typeof quota === "object") setFromServer(quota);
    }

    // the X-Usage-* headers of an AI reply (headers: anything with get(name))
    function fromHeaders(headers) {
      if (!headers || typeof headers.get !== "function") return;
      var plan = headers.get("x-usage-plan");
      if (plan !== "free" && plan !== "premium") return;
      var remaining = parseCount(headers.get("x-usage-remaining"));
      var limit = parseCount(headers.get("x-usage-limit"));
      setFromServer({
        plan: plan,
        premium: plan === "premium",
        limit: typeof limit === "number" ? limit : undefined,
        remaining: typeof remaining === "number" ? remaining : undefined,
        resetAt: headers.get("x-usage-reset") || undefined
      });
    }

    async function refresh() {
      if (!opts.isSignedIn || !opts.isSignedIn()) { clear(); return null; }
      try {
        var headers = Object.assign({}, await opts.getAuthHeaders());
        if (!headers.Authorization) return null;
        var response = await opts.fetch(opts.apiUrl("/api/usage"), { headers: headers });
        if (!response.ok) return null;
        var body = await response.json();
        setFromServer(body);
        return body;
      } catch (err) {
        return null; // the counter simply stays hidden until the next reply carries the numbers
      }
    }

    function setUser(user) {
      if (user) refresh(); else clear();
    }

    // ---- dialogs ----
    function closeModal() {
      if (!modal) return;
      var m = modal;
      modal = null;
      doc.removeEventListener("keydown", m.onKeydown, true);
      m.backdrop.remove();
      if (m.previouslyFocused && typeof m.previouslyFocused.focus === "function") m.previouslyFocused.focus();
    }

    // build(dialog, close) fills the dialog; the first button gets the focus
    function openModal(title, build, extraClass) {
      var previouslyFocused = modal ? modal.previouslyFocused : doc.activeElement;
      if (modal) { var old = modal; modal = null; doc.removeEventListener("keydown", old.onKeydown, true); old.backdrop.remove(); }
      var backdrop = el("div", "lh-dialog-backdrop");
      var dialog = el("div", "lh-dialog usage-dialog" + (extraClass ? " " + extraClass : ""));
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("aria-labelledby", "usage-dialog-title");
      var heading = el("h2", "lh-dialog-title", title);
      heading.setAttribute("id", "usage-dialog-title");
      dialog.appendChild(heading);
      build(dialog, closeModal);
      backdrop.appendChild(dialog);
      function onKeydown(event) {
        if (event.key === "Escape") { event.preventDefault(); closeModal(); }
        else if (event.key === "Tab") {
          var buttons = Array.prototype.slice.call(dialog.querySelectorAll("button, a"));
          if (!buttons.length) return;
          var first = buttons[0];
          var last = buttons[buttons.length - 1];
          if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      }
      backdrop.addEventListener("mousedown", function (event) { if (event.target === backdrop) closeModal(); });
      doc.addEventListener("keydown", onKeydown, true);
      doc.body.appendChild(backdrop);
      modal = { backdrop: backdrop, onKeydown: onKeydown, previouslyFocused: previouslyFocused };
      var firstButton = dialog.querySelector("button, a");
      if (firstButton) firstButton.focus();
      return { dialog: dialog, close: closeModal };
    }

    function button(label, className, onClick) {
      var b = el("button", "lh-btn " + className, label);
      b.type = "button";
      b.addEventListener("click", onClick);
      return b;
    }

    function actionsRow(children) {
      var row = el("div", "lh-dialog-actions");
      children.forEach(function (child) { row.appendChild(child); });
      return row;
    }

    function planColumn(name, items, highlight) {
      var column = el("section", "plan-column" + (highlight ? " is-premium" : ""));
      column.appendChild(el("h3", "plan-name", name));
      var list = el("ul", "plan-list");
      items.forEach(function (text) { list.appendChild(el("li", "", text)); });
      column.appendChild(list);
      return column;
    }

    function showPaywall() {
      var limit = typeof state.limit === "number" ? state.limit : 10;
      return openModal("You've used today's free requests", function (dialog, close) {
        dialog.appendChild(el("p", "lh-dialog-message paywall-renew", renewText(state.resetAt, formatLocal)));
        var plans = el("div", "plan-compare");
        plans.appendChild(planColumn("Free", [limit + " AI requests per day", "All learning modes", "Flashcards"], false));
        var premium = planColumn("Premium", ["Unlimited requests", "Unlimited Speak practice", "Image lessons", "Priority speed"], true);
        premium.appendChild(el("p", "plan-price", state.priceLabel));
        plans.appendChild(premium);
        dialog.appendChild(plans);
        dialog.appendChild(el("p", "paywall-note", "Flashcards and your vocabulary keep working all day."));
        dialog.appendChild(actionsRow([
          button("Maybe later", "lh-btn-secondary", close),
          button("Get Premium", "lh-btn-primary paywall-get", function () { showGetPremium(); })
        ]));
      }, "paywall");
    }

    function showGetPremium() {
      return openModal("Get Premium", function (dialog, close) {
        dialog.appendChild(el("p", "lh-dialog-message get-premium-price", "Price: " + state.priceLabel));
        dialog.appendChild(el("p", "lh-dialog-message", "Premium can't be bought in the app yet. Send us a message and we'll set it up for you."));
        var buttons = [];
        if (state.contactUrl && isHttpsUrl(state.contactUrl)) {
          var link = el("a", "lh-btn lh-btn-primary get-premium-contact", "Contact us");
          link.setAttribute("href", state.contactUrl);
          link.setAttribute("target", "_blank");
          link.setAttribute("rel", "noopener noreferrer");
          buttons.push(link);
        } else {
          dialog.appendChild(el("p", "paywall-note", "The contact link isn't set up yet."));
        }
        buttons.push(button("Remind me tomorrow", "lh-btn-secondary get-premium-remind", function () { remindTomorrow(); close(); }));
        buttons.push(button("Close", "lh-btn-secondary", close));
        dialog.appendChild(actionsRow(buttons));
      }, "get-premium");
    }

    function showSignIn() {
      var available = typeof opts.isSignInAvailable === "function" ? opts.isSignInAvailable() : true;
      return openModal("Sign in to continue", function (dialog, close) {
        dialog.appendChild(el("p", "lh-dialog-message", available
          ? "It's free. Sign in to use the AI tutor - your chats, words and progress stay with your account."
          : "Signing in isn't available in this version of the app, so the AI tutor can't be used here yet."));
        var buttons = [button(available ? "Not now" : "Close", "lh-btn-secondary", close)];
        if (available) buttons.push(button("Sign in with Google", "lh-btn-primary signin-go", function () { close(); if (opts.signIn) opts.signIn(); }));
        dialog.appendChild(actionsRow(buttons));
      }, "signin-required");
    }

    // The page's gate before any AI feature: signed in -> true; otherwise the friendly dialog and false.
    function canUseAi() {
      if (opts.isSignedIn && opts.isSignedIn()) return true;
      showSignIn();
      return false;
    }

    // the server said "daily limit reached" (429 DAILY_LIMIT_REACHED)
    function handleLimit(body) {
      var info = body && typeof body === "object" ? body : {};
      setFromServer({ plan: "free", premium: false, limit: typeof info.limit === "number" ? info.limit : state.limit, remaining: 0, resetAt: info.resetAt, priceLabel: info.priceLabel, contactUrl: info.contactUrl });
      showPaywall();
    }

    function limitMessage() {
      return "You've used all your free requests for today. " + renewText(state.resetAt, formatLocal);
    }

    // ---- "Remind me tomorrow" ----
    function remindTomorrow() {
      var at = state.resetAt && Number.isFinite(Date.parse(state.resetAt)) ? Date.parse(state.resetAt) : now() + 24 * 3600 * 1000;
      try { if (storage) storage.setItem(REMINDER_KEY, String(at)); } catch (err) { /* private mode */ }
      notify("We'll remind you when your free requests are back.", "success");
      scheduleReminder();
    }

    // the stored reminder time (epoch ms), or NaN when there is none (Number(null) would be 0)
    function readReminder() {
      try {
        var raw = storage ? storage.getItem(REMINDER_KEY) : null;
        return raw === null || raw === "" ? NaN : Number(raw);
      } catch (err) {
        return NaN;
      }
    }

    function scheduleReminder() {
      if (reminderTimer) { clearTimer(reminderTimer); reminderTimer = null; }
      var at = readReminder();
      if (!Number.isFinite(at)) return;
      var wait = Math.max(0, at - now());
      if (wait > MAX_TIMER_MS) return; // far away: checked again at the next launch
      reminderTimer = setTimer(checkReminder, wait);
    }

    // at launch (and when the timer fires): if the time has come, say the requests are back, once
    function checkReminder() {
      var at = readReminder();
      if (!Number.isFinite(at)) return false;
      if (now() < at) { scheduleReminder(); return false; }
      try { storage.removeItem(REMINDER_KEY); } catch (err) { /* ignore */ }
      notify("Your free requests are back. Pick up where you left off!", "success");
      refresh();
      return true;
    }

    render();

    return {
      state: function () { return Object.assign({}, state); },
      render: render,
      refresh: refresh,
      setUser: setUser,
      fromHeaders: fromHeaders,
      fromQuota: fromQuota,
      handleLimit: handleLimit,
      canUseAi: canUseAi,
      showPaywall: showPaywall,
      showGetPremium: showGetPremium,
      showSignIn: showSignIn,
      remindTomorrow: remindTomorrow,
      checkReminder: checkReminder,
      scheduleReminder: scheduleReminder,
      limitMessage: limitMessage,
      closeDialog: closeModal
    };
  }

  return { create: create, renewText: renewText, isHttpsUrl: isHttpsUrl, REMINDER_KEY: REMINDER_KEY, LOW: LOW };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = LinguaHubUsage;
}

if (typeof window !== "undefined") {
  window.LinguaHubUsage = LinguaHubUsage;
}
