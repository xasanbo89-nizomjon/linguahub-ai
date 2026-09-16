"use strict";

// LinguaHub AI - minimal structured logger (Phase 11).
//
// Deliberately small: level filtering, JSON output in production (one line
// per event, easy for any log shipper to parse), a human-readable line in
// development, and field redaction. Not a general observability stack -
// Phase 11 explicitly asks for exactly this and no more.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

const REDACTED = "[REDACTED]";

// Field names that must never appear in a log line, even if a call site
// accidentally passes one in - defense in depth on top of every call site
// already being written to only pass safe metadata (method/route/status/
// duration/requestId/uid/mode), never message content, tokens, or keys.
const SENSITIVE_KEYS = new Set([
  "authorization", "cookie", "cookies", "token", "idtoken", "id_token",
  "apikey", "api_key", "openai_api_key", "firebase_private_key",
  "privatekey", "private_key", "password", "secret", "systemprompt",
  "system_prompt", "message", "messages", "content", "reply", "prompt"
]);

function redact(fields) {
  if (!fields || typeof fields !== "object") return fields;
  const out = {};
  for (const key of Object.keys(fields)) {
    const value = fields[key];
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      out[key] = REDACTED;
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = redact(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function createLogger(options) {
  options = options || {};
  const configuredLevel = String(options.level || process.env.LOG_LEVEL || "info").toLowerCase();
  const threshold = Object.prototype.hasOwnProperty.call(LEVELS, configuredLevel) ? LEVELS[configuredLevel] : LEVELS.info;
  const json = options.json !== undefined ? options.json : process.env.NODE_ENV === "production";
  const write = options.write || ((line) => { process.stdout.write(line + "\n"); });
  const baseFields = options.baseFields || {};

  function emit(level, message, fields) {
    if (LEVELS[level] < threshold) return;
    const safeFields = redact(Object.assign({}, baseFields, fields));
    if (json) {
      write(JSON.stringify(Object.assign({ level, message, time: new Date().toISOString() }, safeFields)));
    } else {
      const suffix = Object.keys(safeFields).length ? " " + JSON.stringify(safeFields) : "";
      write(`[${new Date().toISOString()}] ${level.toUpperCase()} ${message}${suffix}`);
    }
  }

  return {
    level: configuredLevel,
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    // A child logger carries a fixed set of fields (e.g. requestId) on
    // every call, without every call site having to repeat them.
    child: (extraBaseFields) => createLogger(Object.assign({}, options, {
      baseFields: Object.assign({}, baseFields, extraBaseFields)
    }))
  };
}

module.exports = { createLogger, redact, LEVELS, SENSITIVE_KEYS };
