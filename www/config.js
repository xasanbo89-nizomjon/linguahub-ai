// LinguaHub AI - centralized runtime API configuration.
//
// Single source of truth for the backend API base URL. Every frontend
// surface (Live Server, Electron file://, Capacitor webview, or the app
// served directly by the Express backend) resolves its URL here instead of
// each script computing/duplicating its own guess.
//
// Resolution order:
//   1. Explicit override: set window.LINGUAHUB_CONFIG = { API_BASE_URL: "..." }
//      in an inline <script> BEFORE this file loads (used for split-origin
//      production deployments, e.g. a static frontend host talking to a
//      separately hosted API).
//   2. Known local dev static-file servers (Live Server on 5500/5501) and
//      app-shell webviews (Electron file://, Capacitor capacitor:// or the
//      default https://localhost host) -> local backend default.
//   3. Otherwise: same-origin (relative URLs). This covers both local
//      development and production when this Express server serves the
//      frontend and the API from the same origin, which is how this
//      project is currently architected. It intentionally never falls
//      back to a hardcoded localhost URL for a non-loopback production
//      origin.

var LinguaHubApiConfig = (function () {
  "use strict";

  var DEV_BACKEND_DEFAULT = "http://127.0.0.1:3000";
  // Android-emulator-only alias for the host machine's own loopback
  // interface (Phase 10). Inside an Android emulator, 127.0.0.1/localhost
  // refers to the emulated device itself, not the host running the
  // backend - 10.0.2.2 is the standard, documented Android emulator
  // redirect to the host's 127.0.0.1. This has no effect on a physical
  // Android device (which needs an explicit API_BASE_URL override with
  // the host's real LAN IP - see docs/android-network-configuration.md)
  // or on iOS/Electron (a distinct protocol, unaffected - see below).
  var ANDROID_EMULATOR_BACKEND_DEFAULT = "http://10.0.2.2:3000";
  var KNOWN_DEV_FRONTEND_PORTS = ["5500", "5501"];

  function normalizeBaseUrl(url) {
    return String(url).trim().replace(/\/+$/, "");
  }

  // An API_BASE_URL override must be a real absolute http(s) URL with no
  // path/query/fragment (it's a *base*, joined with a path later by
  // buildApiUrl) - anything else is almost certainly a typo'd production
  // config, not a value that would ever work. Checked with the platform's
  // own URL parser rather than a hand-rolled regex.
  function isValidBaseUrlOverride(url) {
    var trimmed = String(url).trim();
    if (!trimmed) return false;
    var parsed;
    try {
      parsed = new URL(trimmed);
    } catch (error) {
      return false;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (parsed.search || parsed.hash) return false;
    if (parsed.pathname !== "/" && parsed.pathname !== "") return false;
    return true;
  }

  function computeApiBase(location, override) {
    if (override) {
      if (!isValidBaseUrlOverride(override)) {
        // Fail loudly, not silently: an override this broken would never
        // have worked anyway (every request would 404/fail to resolve),
        // so this is surfaced as clearly as possible in the console
        // rather than quietly sending requests to a malformed URL - but
        // guest chat still needs to keep working, so this falls through
        // to the same auto-detected value a missing override would use,
        // exactly like every other "fail safe, not silently broken"
        // decision in this app (see www/auth.js's header comment for the
        // same philosophy applied to authentication).
        if (typeof console !== "undefined" && console.error) {
          console.error(
            '[LinguaHub AI] window.LINGUAHUB_CONFIG.API_BASE_URL="' + override + '" is not a valid absolute ' +
            "http(s) base URL (no path/query/fragment) - ignoring it and falling back to auto-detection. " +
            "Fix this value before relying on it in production."
          );
        }
        computeApiBase.lastOverrideError = override;
      } else {
        return normalizeBaseUrl(override);
      }
    }

    var protocol = location.protocol;
    var hostname = location.hostname;
    var port = location.port || "";

    // Electron (file://) and Capacitor iOS (capacitor://localhost) share
    // the host machine's own network namespace (an iOS Simulator/Electron
    // process runs directly on the dev machine), so 127.0.0.1 is correct
    // for both.
    if (protocol === "file:" || protocol === "capacitor:") {
      return DEV_BACKEND_DEFAULT;
    }

    // Capacitor Android's default webview origin (https://localhost, no
    // explicit port) never actually serves the Express app - always talk
    // to the local backend by default in this shell. Unlike Electron/iOS
    // above, an Android emulator is its own virtual machine: 127.0.0.1
    // there is the emulator itself, not the host, so the Android-specific
    // 10.0.2.2 alias is required (see the constant's own comment above).
    // A production Android build must set an explicit API_BASE_URL
    // override (priority 1, above) instead of relying on this dev
    // default - see docs/android-network-configuration.md.
    var isCapacitorDefaultHost = protocol === "https:" && hostname === "localhost" && port === "";
    if (isCapacitorDefaultHost) {
      return ANDROID_EMULATOR_BACKEND_DEFAULT;
    }

    var isHttp = protocol === "http:" || protocol === "https:";
    if (!isHttp) {
      return DEV_BACKEND_DEFAULT;
    }

    var isLoopbackHost = hostname === "127.0.0.1" || hostname === "localhost";
    var isKnownDevFrontendPort = KNOWN_DEV_FRONTEND_PORTS.indexOf(port) !== -1;

    if (isLoopbackHost && isKnownDevFrontendPort) {
      // A static dev server (e.g. VS Code Live Server) is NOT the backend.
      return DEV_BACKEND_DEFAULT;
    }

    // Served by this Express app itself: same-origin relative requests,
    // whatever host/port it actually runs on (dev or production).
    return "";
  }

  function buildApiUrl(base, path) {
    var normalizedBase = base ? normalizeBaseUrl(base) : "";
    var normalizedPath = "/" + String(path).replace(/^\/+/, "");
    return normalizedBase + normalizedPath;
  }

  function resolve(location, overrideConfig) {
    var override = overrideConfig && overrideConfig.API_BASE_URL;
    computeApiBase.lastOverrideError = null;
    var apiBase = computeApiBase(location, override);
    return {
      API_BASE_URL: apiBase,
      // Honest configuration-error signal (Phase 11, Task 3): set only
      // when an override was PROVIDED but was invalid, never for the
      // normal "no override at all" case. A future UI could surface this;
      // today it's at minimum always visible in the console (see above).
      API_BASE_URL_CONFIG_ERROR: computeApiBase.lastOverrideError,
      apiUrl: function (path) {
        return buildApiUrl(apiBase, path);
      }
    };
  }

  return {
    DEV_BACKEND_DEFAULT: DEV_BACKEND_DEFAULT,
    ANDROID_EMULATOR_BACKEND_DEFAULT: ANDROID_EMULATOR_BACKEND_DEFAULT,
    KNOWN_DEV_FRONTEND_PORTS: KNOWN_DEV_FRONTEND_PORTS,
    normalizeBaseUrl: normalizeBaseUrl,
    isValidBaseUrlOverride: isValidBaseUrlOverride,
    computeApiBase: computeApiBase,
    buildApiUrl: buildApiUrl,
    resolve: resolve
  };
})();

// Node (tests) export.
if (typeof module !== "undefined" && module.exports) {
  module.exports = LinguaHubApiConfig;
}

// Browser wiring: compute window.LINGUAHUB_CONFIG.API_BASE_URL once, honoring
// any override already set by an inline script before this file loaded.
if (typeof window !== "undefined") {
  var existingOverride = window.LINGUAHUB_CONFIG || {};
  var resolved = LinguaHubApiConfig.resolve(window.location, existingOverride);
  window.LINGUAHUB_CONFIG = Object.assign({}, existingOverride, resolved);
}
