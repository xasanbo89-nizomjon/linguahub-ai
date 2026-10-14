"use strict";

// Covers lib/aiModes.js - the backend-only AI mode registry introduced in
// Phase 6. These are pure Node unit tests (no HTTP, no OpenAI call).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const aiModes = require("../lib/aiModes.js");

const EXPECTED_MODE_IDS = ["general", "codex", "cyber", "deep-thinking", "linguahub-tutor", "ielts-reading", "ielts-listening", "ielts-writing", "ielts-speaking", "vocabulary-coach", "grammar-coach", "platform-help", "image", "voice", "web-search", "translate", "speak", "grammar", "vocabulary", "word-lookup", "try-grammar"];
const EXPECTED_ENABLED = ["general", "codex", "cyber", "deep-thinking", "linguahub-tutor", "ielts-reading", "ielts-listening", "ielts-writing", "ielts-speaking", "vocabulary-coach", "grammar-coach", "platform-help", "translate", "speak", "grammar", "vocabulary", "word-lookup", "try-grammar"];
const EXPECTED_DISABLED = ["image", "voice", "web-search"];

test("MODE_IDS contains the complete stable tutor and legacy mode registry", () => {
  assert.deepEqual(aiModes.MODE_IDS.slice().sort(), EXPECTED_MODE_IDS.slice().sort());
});

test("every id round-trips through isValidModeId/getModeConfig", () => {
  for (const id of aiModes.MODE_IDS) {
    assert.equal(aiModes.isValidModeId(id), true);
    const config = aiModes.getModeConfig(id);
    assert.ok(config, `getModeConfig(${id}) should return a config`);
    assert.equal(config.id, id);
  }
});

test("isValidModeId rejects unknown ids, non-strings, and prototype-pollution-style keys", () => {
  assert.equal(aiModes.isValidModeId("nonexistent"), false);
  assert.equal(aiModes.isValidModeId("General AI"), false, "legacy display labels are not valid ids on the backend");
  assert.equal(aiModes.isValidModeId(""), false);
  assert.equal(aiModes.isValidModeId(null), false);
  assert.equal(aiModes.isValidModeId(undefined), false);
  assert.equal(aiModes.isValidModeId(123), false);
  assert.equal(aiModes.isValidModeId("constructor"), false);
  assert.equal(aiModes.isValidModeId("toString"), false);
  assert.equal(aiModes.isValidModeId("hasOwnProperty"), false);
});

test("getModeConfig returns null for an invalid id instead of throwing or returning a default", () => {
  assert.equal(aiModes.getModeConfig("nonexistent"), null);
});

test("all tutor chat modes are enabled; image/voice/web-search remain disabled", () => {
  for (const id of EXPECTED_ENABLED) {
    assert.equal(aiModes.getModeConfig(id).enabled, true, `${id} should be enabled`);
    assert.equal(aiModes.getModeConfig(id).capability, "chat");
  }
  for (const id of EXPECTED_DISABLED) {
    assert.equal(aiModes.getModeConfig(id).enabled, false, `${id} should be disabled`);
    assert.equal(aiModes.getModeConfig(id).capability, "unavailable");
  }
});

test("disabled modes are honestly inert: no provider, model, or system prompt configured", () => {
  for (const id of EXPECTED_DISABLED) {
    const config = aiModes.getModeConfig(id);
    assert.equal(config.provider, null, `${id}.provider must be null, not a fabricated capability`);
    assert.equal(config.model, null);
    assert.equal(config.systemPrompt, null);
    assert.equal(config.maxOutputTokens, 0);
  }
});

test("every enabled mode has a real, non-empty system prompt and a model on the allowlist", () => {
  for (const id of EXPECTED_ENABLED) {
    const config = aiModes.getModeConfig(id);
    assert.equal(typeof config.systemPrompt, "string");
    assert.ok(config.systemPrompt.length > 20, `${id} system prompt looks too short to be real`);
    assert.ok(aiModes.ALLOWLISTED_MODELS.includes(config.model), `${id}'s model must be on ALLOWLISTED_MODELS`);
    assert.equal(typeof config.temperature, "number");
    assert.ok(config.maxOutputTokens > 0);
    assert.ok(config.timeoutMs > 0);
  }
});

test("deep-thinking deliberately uses a different (stronger) model than general/codex/cyber", () => {
  const deepThinkingModel = aiModes.getModeConfig("deep-thinking").model;
  assert.notEqual(deepThinkingModel, aiModes.getModeConfig("general").model);
  assert.equal(aiModes.getModeConfig("general").model, aiModes.getModeConfig("codex").model);
  assert.equal(aiModes.getModeConfig("general").model, aiModes.getModeConfig("cyber").model);
});

test("deep-thinking does not fake a provider reasoning-effort parameter", () => {
  assert.equal(aiModes.getModeConfig("deep-thinking").reasoning, null);
});

test("cyber mode's system prompt instructs defensive use and declines unauthorized operational help", () => {
  const prompt = aiModes.getModeConfig("cyber").systemPrompt;
  assert.match(prompt, /decline/i);
  assert.match(prompt, /unauthorized/i);
  assert.match(prompt, /defensive/i);
});

test("getDefaultMode returns the enabled 'general' mode", () => {
  const mode = aiModes.getDefaultMode();
  assert.equal(mode.id, "general");
  assert.equal(mode.enabled, true);
});

test("resolveModeOrDefault falls back to default for unknown or disabled ids, passes through valid enabled ids", () => {
  assert.equal(aiModes.resolveModeOrDefault("codex").id, "codex");
  assert.equal(aiModes.resolveModeOrDefault("nonexistent").id, "general");
  assert.equal(aiModes.resolveModeOrDefault("image").id, "general", "disabled modes are not resolved as-is");
  assert.equal(aiModes.resolveModeOrDefault(undefined).id, "general");
});

test("toPublicMetadata exposes only id/label/description/enabled/capability - nothing private", () => {
  for (const id of aiModes.MODE_IDS) {
    const publicMeta = aiModes.toPublicMetadata(aiModes.getModeConfig(id));
    assert.deepEqual(Object.keys(publicMeta).sort(), ["capability", "description", "enabled", "id", "label"]);
    assert.equal(publicMeta.id, id);
  }
});

test("getPublicModes never leaks systemPrompt, model, temperature, limits, tools, or provider", () => {
  const serialized = JSON.stringify(aiModes.getPublicModes());
  for (const id of EXPECTED_ENABLED) {
    const config = aiModes.getModeConfig(id);
    assert.doesNotMatch(serialized, new RegExp(config.systemPrompt.slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(serialized, /gpt-4/, "no model name should ever reach the public payload");
  // Matched as JSON keys specifically (quoted, followed by a colon) so a
  // legitimate description string that happens to contain a plain-English
  // word like "provider" is never a false positive here.
  assert.doesNotMatch(serialized, /"(systemPrompt|temperature|maxOutputTokens|maxInputChars|timeoutMs|reasoning|tools|provider|model|authRequired)":/);
});

test("each mode object and its tools array are genuinely frozen (strict-mode mutation throws, value unchanged)", () => {
  "use strict";
  assert.throws(() => { aiModes.getModeConfig("general").model = "gpt-9000"; }, TypeError);
  assert.throws(() => { aiModes.getModeConfig("general").tools.push("x"); }, TypeError);

  const before = aiModes.getModeConfig("general").model;
  try { aiModes.getModeConfig("general").model = "gpt-9000"; } catch (err) { /* expected in strict mode */ }
  assert.equal(aiModes.getModeConfig("general").model, before, "mutation must not have taken effect");
});

test("FORBIDDEN_REQUEST_FIELDS covers every privileged field a client must never set", () => {
  const required = ["model", "systemPrompt", "system", "temperature", "maxTokens", "max_tokens", "tools", "reasoning"];
  for (const field of required) {
    assert.ok(aiModes.FORBIDDEN_REQUEST_FIELDS.includes(field), `${field} must be in FORBIDDEN_REQUEST_FIELDS`);
  }
});

test("LEGACY_MODE_ALIASES maps every old Phase 1-5 display label to a currently valid stable id", () => {
  for (const [legacyLabel, newId] of Object.entries(aiModes.LEGACY_MODE_ALIASES)) {
    assert.equal(typeof legacyLabel, "string");
    assert.ok(aiModes.isValidModeId(newId), `${legacyLabel} -> ${newId}, but ${newId} is not a valid mode id`);
  }
});

test("ALLOWLISTED_MODELS contains only models actually assigned to an enabled mode, with no duplicates", () => {
  const assigned = new Set(EXPECTED_ENABLED.map((id) => aiModes.getModeConfig(id).model));
  assert.deepEqual(new Set(aiModes.ALLOWLISTED_MODELS), assigned);
  assert.equal(aiModes.ALLOWLISTED_MODELS.length, new Set(aiModes.ALLOWLISTED_MODELS).size);
});
