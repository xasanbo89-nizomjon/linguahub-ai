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
//     AI feature while signed out - but only when the server requires a sign-in
//     (REQUIRE_SIGN_IN=true). By default guests use the app with their own, smaller
//     daily allowance (the same counter, the same paywall plus a "Sign in for more"
//     note) and are asked to sign in only when the guests' global cap is reached or
//     for more pictures. The page learns which mode it is in from GET /api/usage.
// The numbers come from GET /api/usage and from the X-Usage-* headers (and the
// "quota" field) of every AI reply, so the counter is always what the server says.

var LinguaHubUsage = (function () {
  "use strict";

  var REMINDER_KEY = "linguahub-ai:premium-reminder";
  var LOW = 2;
  var LIMIT_CODES = ["DAILY_LIMIT_REACHED", "GUEST_CAP_REACHED", "GUEST_IMAGE_LIMIT_REACHED"];
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
    var state = { plan: null, premium: false, guest: false, requireSignIn: false, limit: null, remaining: null, resetAt: null, premiumUntil: null, priceLabel: "Coming soon", contactUrl: null };
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
      state.plan = null; state.premium = false; state.guest = false; state.limit = null; state.remaining = null; state.resetAt = null; state.premiumUntil = null;
      render();
    }

    function setFromServer(info) {
      if (!info) return;
      if (typeof info.requireSignIn === "boolean") state.requireSignIn = info.requireSignIn;
      if (typeof info.guest === "boolean") state.guest = info.guest;
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

    // Reads plan, numbers and the sign-in mode from the server. Signed in: the account's own numbers;
    // otherwise the guest's (unless the server requires a sign-in, which it says with a 401).
    async function refresh() {
      try {
        var headers = Object.assign({}, await opts.getAuthHeaders());
        var response = await opts.fetch(opts.apiUrl("/api/usage"), { headers: headers });
        if (response.status === 401) {
          var denied = null;
          try { denied = await response.json(); } catch (err) { denied = null; }
          if (denied && denied.requireSignIn === true) { clear(); state.requireSignIn = true; }
          return null;
        }
        if (!response.ok) return null;
        var body = await response.json();
        setFromServer(body);
        return body;
      } catch (err) {
        return null; // the counter simply stays hidden until the next reply carries the numbers
      }
    }

    function setUser(user) {
      if (!user) clear(); // the signed-out numbers are the guest's: read them afresh
      refresh();
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
        var buttons = [button("Maybe later", "lh-btn-secondary", close)];
        if (state.guest) {
          // no account yet: signing in is the way to more (every account has its own daily allowance)
          dialog.appendChild(el("p", "paywall-note paywall-signin", "Sign in for more: every account gets its own free requests each day."));
          if (typeof opts.isSignInAvailable !== "function" || opts.isSignInAvailable()) {
            buttons.push(button("Sign in for more", "lh-btn-secondary paywall-signin-btn", function () { close(); if (opts.signIn) opts.signIn(); }));
          }
        }
        buttons.push(button("Get Premium", "lh-btn-primary paywall-get", function () { showGetPremium(); }));
        dialog.appendChild(actionsRow(buttons));
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

    function showSignIn(message) {
      var available = typeof opts.isSignInAvailable === "function" ? opts.isSignInAvailable() : true;
      return openModal("Sign in to continue", function (dialog, close) {
        dialog.appendChild(el("p", "lh-dialog-message", available
          ? (message || "It's free. Sign in to use the AI tutor - your chats, words and progress stay with your account.")
          : "Signing in isn't available in this version of the app, so the AI tutor can't be used here yet."));
        var buttons = [button(available ? "Not now" : "Close", "lh-btn-secondary", close)];
        if (available) buttons.push(button("Sign in with Google", "lh-btn-primary signin-go", function () { close(); if (opts.signIn) opts.signIn(); }));
        dialog.appendChild(actionsRow(buttons));
      }, "signin-required");
    }

    // The page's gate before any AI feature. Signed in: yes. Signed out: yes as a guest - unless the
    // server requires a sign-in, then the friendly dialog and no.
    function canUseAi() {
      if (opts.isSignedIn && opts.isSignedIn()) return true;
      if (!state.requireSignIn) return true;
      showSignIn();
      return false;
    }

    // the server answered 401 AUTH_REQUIRED: it requires a sign-in
    function handleAuthRequired() {
      state.requireSignIn = true;
      showSignIn();
    }

    // the server refused for a limit (429): the daily limit opens the paywall; the guests' global cap and
    // the guests' picture limit ask for a sign-in
    function handleLimit(body) {
      var info = body && typeof body === "object" ? body : {};
      if (info.code === "GUEST_CAP_REACHED" || info.code === "GUEST_IMAGE_LIMIT_REACHED") {
        showSignIn(messageFor(info.code));
        return;
      }
      setFromServer({ plan: "free", premium: false, guest: info.guest === true ? true : undefined, limit: typeof info.limit === "number" ? info.limit : state.limit, remaining: 0, resetAt: info.resetAt, priceLabel: info.priceLabel, contactUrl: info.contactUrl });
      showPaywall();
    }

    function limitMessage() {
      return "You've used all your free requests for today. " + renewText(state.resetAt, formatLocal) + (state.guest ? " Sign in for more." : "");
    }

    function messageFor(code) {
      if (code === "GUEST_CAP_REACHED") return "Free use without an account is busy right now. Sign in to continue - it's free.";
      if (code === "GUEST_IMAGE_LIMIT_REACHED") return "You've used today's free pictures. Sign in to send more - it's free.";
      if (code === "AUTH_REQUIRED") return "Sign in to continue - it's free.";
      return limitMessage();
    }

    // The one place the page hands a failed AI response to: a limit or a required sign-in is shown
    // (paywall / sign-in dialog) and described in one friendly sentence. -> { code, message } or null.
    function handleErrorBody(status, body) {
      if (!body || typeof body !== "object") return null;
      if (status === 429 && LIMIT_CODES.indexOf(body.code) !== -1) {
        handleLimit(body);
        return { code: body.code, message: messageFor(body.code) };
      }
      if (status === 401 && body.code === "AUTH_REQUIRED") {
        handleAuthRequired();
        return { code: "AUTH_REQUIRED", message: messageFor("AUTH_REQUIRED") };
      }
      return null;
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
      handleAuthRequired: handleAuthRequired,
      handleErrorBody: handleErrorBody,
      messageFor: messageFor,
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

  return { create: create, LIMIT_CODES: LIMIT_CODES, renewText: renewText, isHttpsUrl: isHttpsUrl, REMINDER_KEY: REMINDER_KEY, LOW: LOW };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = LinguaHubUsage;
}

if (typeof window !== "undefined") {
  window.LinguaHubUsage = LinguaHubUsage;
}
