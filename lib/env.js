"use strict";

// LinguaHub AI - centralized production environment validation (Phase 11).
//
// Pure and testable: validateEnv(env) takes a plain object (normally
// process.env) and returns a result describing exactly what's valid,
// what's missing, and what's malformed - it never reads process.env
// itself and never calls process.exit()/console.* directly, so it can be
// unit-tested without touching real environment state. server.js is the
// only caller that decides what to DO with the result (fail fast in
// production, warn-and-continue in development).
//
// Never returns or logs a secret's actual value - only whether it's set
// and, at most, its length (see maskSecret()).

const KNOWN_NODE_ENVS = ["development", "production", "test"];
const KNOWN_LOG_LEVELS = ["debug", "info", "warn", "error", "silent"];

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function maskSecret(value) {
  return isNonEmptyString(value) ? `(set, length ${value.trim().length})` : "(unset)";
}

// Returns a valid port number, or:
//   - null  -> not provided at all (caller should use a default)
//   - undefined -> provided but invalid (caller should error)
function parsePort(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return undefined;
  return n;
}

// Same null/undefined-vs-invalid convention as parsePort, for any
// "positive integer or default" setting (timeouts, limits, windows).
function parsePositiveInt(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return undefined;
  return n;
}

// A CORS Origin value is scheme+host[+port] only - no path, query,
// fragment, or trailing slash. Rejects anything else outright rather than
// silently normalizing it, so a typo'd FRONTEND_ORIGINS entry (e.g. a
// trailing "/" or an accidental "/callback" path) is a loud startup error,
// not a silently-never-matching CORS rule discovered only in production.
function parseOrigins(raw) {
  const entries = String(raw || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  const valid = [];
  const invalid = [];
  for (const entry of entries) {
    let url;
    try {
      url = new URL(entry);
    } catch (error) {
      invalid.push(entry);
      continue;
    }
    const isBareOrigin = (url.pathname === "/" || url.pathname === "") && !url.search && !url.hash && !url.username && !url.password;
    if (!/^https?:$/.test(url.protocol) || !isBareOrigin) {
      invalid.push(entry);
      continue;
    }
    valid.push(url.origin);
  }
  return { valid: Array.from(new Set(valid)), invalid };
}

function firebaseAdminVarsPresent(env) {
  return Boolean(
    isNonEmptyString(env.GOOGLE_APPLICATION_CREDENTIALS) ||
    isNonEmptyString(env.FIREBASE_PROJECT_ID) ||
    isNonEmptyString(env.FIREBASE_CLIENT_EMAIL) ||
    isNonEmptyString(env.FIREBASE_PRIVATE_KEY)
  );
}

function firebaseAdminVarsComplete(env) {
  if (isNonEmptyString(env.GOOGLE_APPLICATION_CREDENTIALS)) return true;
  return Boolean(
    isNonEmptyString(env.FIREBASE_PROJECT_ID) &&
    isNonEmptyString(env.FIREBASE_CLIENT_EMAIL) &&
    isNonEmptyString(env.FIREBASE_PRIVATE_KEY)
  );
}

// TRUST_PROXY accepts only documented, safe shapes: unset (0 - no proxy
// trusted, safe default for local/dev), a non-negative hop count ("1" for
// exactly one reverse proxy - the expected production topology, see
// docs/production-network-and-cors.md), or the literal "true" (trusts an
// unbounded chain - allowed, but always warned about, since a client can
// spoof every hop except the one closest to this process).
function parseTrustProxy(raw, warnings, env) {
  // Vercel always sits behind exactly one proxy that sets X-Forwarded-For
  // itself: trusting that one hop is what makes req.ip (and so the rate
  // limiters) see the real client. An explicit TRUST_PROXY still wins.
  if (!isNonEmptyString(raw)) return env && env.VERCEL ? 1 : 0;
  if (raw === "true") {
    warnings.push(
      'TRUST_PROXY="true" trusts every hop in X-Forwarded-For, which a client can spoof beyond the nearest ' +
      "proxy. Prefer an exact hop count (e.g. TRUST_PROXY=1 for a single reverse proxy) unless the deployment " +
      "topology genuinely needs an unbounded chain."
    );
    return true;
  }
  if (/^\d+$/.test(raw)) return Number(raw);
  return undefined;
}

function validateEnv(env) {
  env = env || {};
  const errors = [];
  const warnings = [];

  const nodeEnv = isNonEmptyString(env.NODE_ENV) ? env.NODE_ENV : "development";
  if (!KNOWN_NODE_ENVS.includes(nodeEnv)) {
    warnings.push(`NODE_ENV="${nodeEnv}" is not one of ${KNOWN_NODE_ENVS.join("/")} - treated as development for defaults.`);
  }
  const isProduction = nodeEnv === "production";

  const parsedPort = parsePort(env.PORT);
  if (parsedPort === undefined) {
    errors.push(`PORT="${env.PORT}" is not a valid port number (must be an integer 1-65535).`);
  }
  const port = parsedPort || 3000;

  if (!isNonEmptyString(env.OPENAI_API_KEY)) {
    const message = "OPENAI_API_KEY is not set - chat requests will fail until it is configured.";
    (isProduction ? errors : warnings).push(message);
  }

  const { valid: frontendOrigins, invalid: invalidOrigins } = parseOrigins(env.FRONTEND_ORIGINS);
  if (invalidOrigins.length > 0) {
    errors.push(
      `FRONTEND_ORIGINS contains malformed entrie(s): ${invalidOrigins.join(", ")} - each must be a bare ` +
      '"https://host" or "http://host" origin (no path, query, or trailing slash).'
    );
  }
  if (isProduction && frontendOrigins.length === 0) {
    errors.push(
      "FRONTEND_ORIGINS must list at least one real production origin when NODE_ENV=production - the built-in " +
      "default origins (127.0.0.1/localhost) are local-development-only, so without this no real browser could " +
      "call this API at all."
    );
  }
  if (isProduction) {
    for (const origin of frontendOrigins) {
      if (/^http:\/\//.test(origin) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(origin)) {
        warnings.push(`FRONTEND_ORIGINS entry "${origin}" uses plain http:// in production - a real production origin should be https://.`);
      }
    }
  }

  const rateLimitWindowMs = parsePositiveInt(env.RATE_LIMIT_WINDOW_MS, 60000);
  if (rateLimitWindowMs === undefined) errors.push(`RATE_LIMIT_WINDOW_MS="${env.RATE_LIMIT_WINDOW_MS}" must be a positive integer (milliseconds).`);

  const rateLimitMaxRequests = parsePositiveInt(env.RATE_LIMIT_MAX_REQUESTS, 30);
  if (rateLimitMaxRequests === undefined) errors.push(`RATE_LIMIT_MAX_REQUESTS="${env.RATE_LIMIT_MAX_REQUESTS}" must be a positive integer.`);

  const deepThinkingRateLimitMaxRequests = parsePositiveInt(env.DEEP_THINKING_RATE_LIMIT_MAX_REQUESTS, 10);
  if (deepThinkingRateLimitMaxRequests === undefined) {
    errors.push(`DEEP_THINKING_RATE_LIMIT_MAX_REQUESTS="${env.DEEP_THINKING_RATE_LIMIT_MAX_REQUESTS}" must be a positive integer.`);
  }

  const transcribeRateLimitMaxRequests = parsePositiveInt(env.TRANSCRIBE_RATE_LIMIT_MAX_REQUESTS, 20);
  if (transcribeRateLimitMaxRequests === undefined) {
    errors.push(`TRANSCRIBE_RATE_LIMIT_MAX_REQUESTS="${env.TRANSCRIBE_RATE_LIMIT_MAX_REQUESTS}" must be a positive integer.`);
  }

  // How many free sample corrections one IP address may request per day
  // (the landing page's "try it"); the page itself only offers one.
  const tryRateLimitMaxRequests = parsePositiveInt(env.TRY_RATE_LIMIT_MAX_REQUESTS, 3);
  if (tryRateLimitMaxRequests === undefined) {
    errors.push(`TRY_RATE_LIMIT_MAX_REQUESTS="${env.TRY_RATE_LIMIT_MAX_REQUESTS}" must be a positive integer.`);
  }

  // The free plan's AI requests per day (resets at midnight in Asia/Tashkent).
  const freeDailyLimit = parsePositiveInt(env.FREE_DAILY_LIMIT, 10);
  if (freeDailyLimit === undefined) errors.push(`FREE_DAILY_LIMIT="${env.FREE_DAILY_LIMIT}" must be a positive integer.`);

  // Sign-in is optional unless REQUIRE_SIGN_IN is "true". Without it, guests share a smaller
  // daily allowance counted per (hashed) IP address - see lib/usage.js consumeGuest().
  let requireSignIn = false;
  if (isNonEmptyString(env.REQUIRE_SIGN_IN)) {
    const flag = env.REQUIRE_SIGN_IN.trim().toLowerCase();
    if (flag === "true") requireSignIn = true;
    else if (flag !== "false") errors.push(`REQUIRE_SIGN_IN="${env.REQUIRE_SIGN_IN}" must be "true" or "false".`);
  }
  const guestDailyLimit = parsePositiveInt(env.GUEST_DAILY_LIMIT, 10);
  if (guestDailyLimit === undefined) errors.push(`GUEST_DAILY_LIMIT="${env.GUEST_DAILY_LIMIT}" must be a positive integer.`);
  const guestImageDailyLimit = parsePositiveInt(env.GUEST_IMAGE_DAILY_LIMIT, 2);
  if (guestImageDailyLimit === undefined) errors.push(`GUEST_IMAGE_DAILY_LIMIT="${env.GUEST_IMAGE_DAILY_LIMIT}" must be a positive integer.`);
  const guestGlobalDailyCap = parsePositiveInt(env.GUEST_GLOBAL_DAILY_CAP, 2000);
  if (guestGlobalDailyCap === undefined) errors.push(`GUEST_GLOBAL_DAILY_CAP="${env.GUEST_GLOBAL_DAILY_CAP}" must be a positive integer.`);
  const guestSalt = isNonEmptyString(env.GUEST_SALT) ? env.GUEST_SALT : "";
  if (!guestSalt && !requireSignIn && isProduction) warnings.push("GUEST_SALT is not set: guest IP hashes use a built-in constant. Set a secret value so the hashes cannot be recomputed from a list of IP addresses.");

  // Shown in the paywall: the price text and where to reach the owner. The link
  // must be a real https:// URL (it becomes a clickable link in the app).
  const premiumPriceLabel = isNonEmptyString(env.PREMIUM_PRICE_LABEL) ? env.PREMIUM_PRICE_LABEL.trim().slice(0, 60) : "Coming soon";
  let premiumContactUrl = null;
  if (isNonEmptyString(env.PREMIUM_CONTACT_URL)) {
    try {
      const parsed = new URL(env.PREMIUM_CONTACT_URL.trim());
      if (parsed.protocol === "https:") premiumContactUrl = parsed.toString();
      else warnings.push("PREMIUM_CONTACT_URL must start with https:// - it is ignored.");
    } catch (err) {
      warnings.push("PREMIUM_CONTACT_URL is not a valid URL - it is ignored.");
    }
  }

  const generalRateLimitMaxRequests = parsePositiveInt(env.GENERAL_RATE_LIMIT_MAX_REQUESTS, 300);
  if (generalRateLimitMaxRequests === undefined) {
    errors.push(`GENERAL_RATE_LIMIT_MAX_REQUESTS="${env.GENERAL_RATE_LIMIT_MAX_REQUESTS}" must be a positive integer.`);
  }

  // Optional ceiling on one AI generation, in ms. On Vercel it defaults to
  // 55 s (the 60 s function limit, minus a margin); elsewhere there is none.
  const maxGenerationMs = parsePositiveInt(env.MAX_GENERATION_MS, env.VERCEL ? 55000 : 0);
  if (maxGenerationMs === undefined) errors.push(`MAX_GENERATION_MS="${env.MAX_GENERATION_MS}" must be a positive integer (milliseconds).`);

  const requestTimeoutMs = parsePositiveInt(env.REQUEST_TIMEOUT_MS, 120000);
  if (requestTimeoutMs === undefined) errors.push(`REQUEST_TIMEOUT_MS="${env.REQUEST_TIMEOUT_MS}" must be a positive integer (milliseconds).`);

  const trustProxy = parseTrustProxy(env.TRUST_PROXY, warnings, env);
  if (trustProxy === undefined) {
    errors.push(`TRUST_PROXY="${env.TRUST_PROXY}" must be "true" or a non-negative integer hop count (e.g. "1").`);
  }

  const authIntended = firebaseAdminVarsPresent(env);
  const authComplete = firebaseAdminVarsComplete(env);
  if (authIntended && !authComplete) {
    warnings.push(
      "Some but not all Firebase Admin variables are set - authenticated routes will stay unconfigured (503) " +
      "until GOOGLE_APPLICATION_CREDENTIALS, or all three of FIREBASE_PROJECT_ID/FIREBASE_CLIENT_EMAIL/" +
      "FIREBASE_PRIVATE_KEY, are set."
    );
  }

  if (isNonEmptyString(env.DATABASE_URL)) {
    warnings.push(
      "DATABASE_URL is set, but no PostgreSQL client is wired into this application (see " +
      "docs/phase-11-production-preparation.md, Task 11) - it is currently unused, not a live connection."
    );
  }

  const logLevelRaw = isNonEmptyString(env.LOG_LEVEL) ? env.LOG_LEVEL.toLowerCase() : "info";
  if (!KNOWN_LOG_LEVELS.includes(logLevelRaw)) {
    warnings.push(`LOG_LEVEL="${env.LOG_LEVEL}" is not one of ${KNOWN_LOG_LEVELS.join("/")} - defaulting to "info".`);
  }
  const logLevel = KNOWN_LOG_LEVELS.includes(logLevelRaw) ? logLevelRaw : "info";

  if (isNonEmptyString(env.RATE_LIMIT_STORE_URL)) {
    let storeUrlValid = true;
    try {
      // eslint-disable-next-line no-new
      new URL(env.RATE_LIMIT_STORE_URL);
    } catch (error) {
      storeUrlValid = false;
    }
    if (!storeUrlValid) {
      errors.push(`RATE_LIMIT_STORE_URL="${env.RATE_LIMIT_STORE_URL}" is not a valid URL.`);
    }
  }

  return {
    ok: errors.length === 0,
    isProduction,
    nodeEnv,
    port,
    frontendOrigins,
    rateLimitWindowMs: rateLimitWindowMs === undefined ? 60000 : rateLimitWindowMs,
    rateLimitMaxRequests: rateLimitMaxRequests === undefined ? 30 : rateLimitMaxRequests,
    deepThinkingRateLimitMaxRequests: deepThinkingRateLimitMaxRequests === undefined ? 10 : deepThinkingRateLimitMaxRequests,
    transcribeRateLimitMaxRequests: transcribeRateLimitMaxRequests === undefined ? 20 : transcribeRateLimitMaxRequests,
    tryRateLimitMaxRequests: tryRateLimitMaxRequests === undefined ? 3 : tryRateLimitMaxRequests,
    freeDailyLimit: freeDailyLimit === undefined ? 10 : freeDailyLimit,
    requireSignIn,
    guestDailyLimit: guestDailyLimit === undefined ? 10 : guestDailyLimit,
    guestImageDailyLimit: guestImageDailyLimit === undefined ? 2 : guestImageDailyLimit,
    guestGlobalDailyCap: guestGlobalDailyCap === undefined ? 2000 : guestGlobalDailyCap,
    guestSalt,
    premiumPriceLabel,
    premiumContactUrl,
    generalRateLimitMaxRequests: generalRateLimitMaxRequests === undefined ? 300 : generalRateLimitMaxRequests,
    maxGenerationMs: maxGenerationMs === undefined ? 0 : maxGenerationMs,
    requestTimeoutMs: requestTimeoutMs === undefined ? 120000 : requestTimeoutMs,
    trustProxy: trustProxy === undefined ? 0 : trustProxy,
    logLevel,
    rateLimitStoreUrl: isNonEmptyString(env.RATE_LIMIT_STORE_URL) ? env.RATE_LIMIT_STORE_URL : null,
    authIntended,
    authComplete,
    errors,
    warnings,
    // Safe to log in full - never a raw secret value, only presence/length.
    summary: {
      NODE_ENV: nodeEnv,
      PORT: String(port),
      OPENAI_API_KEY: maskSecret(env.OPENAI_API_KEY),
      FRONTEND_ORIGINS: frontendOrigins.length ? frontendOrigins.join(", ") : "(none - local defaults only)",
      FIREBASE_PROJECT_ID: maskSecret(env.FIREBASE_PROJECT_ID),
      FIREBASE_CLIENT_EMAIL: maskSecret(env.FIREBASE_CLIENT_EMAIL),
      FIREBASE_PRIVATE_KEY: maskSecret(env.FIREBASE_PRIVATE_KEY),
      GOOGLE_APPLICATION_CREDENTIALS: isNonEmptyString(env.GOOGLE_APPLICATION_CREDENTIALS) ? "(set)" : "(unset)",
      DATABASE_URL: isNonEmptyString(env.DATABASE_URL) ? "(set, unused)" : "(unset)",
      RATE_LIMIT_STORE_URL: isNonEmptyString(env.RATE_LIMIT_STORE_URL) ? "(set)" : "(unset - using in-process limiter)",
      TRUST_PROXY: String(trustProxy === undefined ? 0 : trustProxy),
      LOG_LEVEL: logLevel,
      // Same maskSecret() redaction as OPENAI_API_KEY/FIREBASE_PRIVATE_KEY
      // above - never the real value, only whether it's configured. This
      // token gates trusted LinguaHub page context (lib/internalAuth.js);
      // unset simply means that optional capability stays unavailable -
      // public/guest chat is never affected either way.
      LINGUAHUB_INTERNAL_TOKEN: maskSecret(env.LINGUAHUB_INTERNAL_TOKEN)
    }
  };
}

module.exports = {
  validateEnv,
  parsePort,
  parsePositiveInt,
  parseOrigins,
  maskSecret
};
