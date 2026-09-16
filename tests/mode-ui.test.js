"use strict";

// Executes the real www/mode-ui.js source via Node's vm module against the
// shared fake DOM (tests/helpers/fakeDom.js) and a scripted fetch - the same
// pattern used for auth.js/app.js in tests/frontend-auth.test.js. Covers
// GET /api/ai/modes population, honest fallback when the backend can't be
// reached, and the mode-specific prompt suggestions.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { createFakeElement } = require("./helpers/fakeDom");

const MODE_UI_SRC = fs.readFileSync(path.join(__dirname, "..", "www", "mode-ui.js"), "utf8");

const REAL_MODES = [
  { id: "general", label: "General AI", description: "A broad assistant.", enabled: true, capability: "chat" },
  { id: "codex", label: "Codex AI", description: "A coding assistant.", enabled: true, capability: "chat" },
  { id: "cyber", label: "Cyber AI", description: "A defensive security assistant.", enabled: true, capability: "chat" },
  { id: "deep-thinking", label: "Deep Thinking", description: "Structured analysis.", enabled: true, capability: "chat" },
  { id: "image", label: "Image AI", description: "Not available in this deployment.", enabled: false, capability: "unavailable" },
  { id: "voice", label: "Voice AI", description: "Not available in this deployment.", enabled: false, capability: "unavailable" },
  { id: "web-search", label: "Web Search", description: "Not available in this deployment.", enabled: false, capability: "unavailable" }
];

function buildSandbox({ fetchImpl } = {}) {
  const sandbox = {
    console,
    fetch: fetchImpl,
    document: { createElement: (tag) => createFakeElement(tag) },
    LINGUAHUB_CONFIG: { apiUrl: (p) => `http://127.0.0.1:3000${p}` }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(MODE_UI_SRC, sandbox, { filename: "mode-ui.js" });
  return sandbox;
}

function makeFetch(modes, { fail = false } = {}) {
  return async () => {
    if (fail) throw new Error("simulated network failure");
    return { ok: true, status: 200, json: async () => ({ modes }) };
  };
}

test("init() fetches GET /api/ai/modes and builds one <option> per mode, in order", async () => {
  const sandbox = buildSandbox({ fetchImpl: makeFetch(REAL_MODES) });
  const selectEl = createFakeElement("select");

  const result = await sandbox.LinguaHubModeUI.init(selectEl);

  assert.equal(result.usedFallback, false);
  assert.equal(selectEl.children.length, 7);
  assert.deepEqual(selectEl.children.map((o) => o.value), REAL_MODES.map((m) => m.id));
});

test("init() marks disabled modes' <option> elements as disabled, and labels them '(unavailable)'", async () => {
  const sandbox = buildSandbox({ fetchImpl: makeFetch(REAL_MODES) });
  const selectEl = createFakeElement("select");
  await sandbox.LinguaHubModeUI.init(selectEl);

  const imageOption = selectEl.children.find((o) => o.value === "image");
  assert.equal(imageOption.disabled, true);
  assert.match(imageOption.textContent, /unavailable/);

  const generalOption = selectEl.children.find((o) => o.value === "general");
  assert.equal(generalOption.disabled, false);
  assert.doesNotMatch(generalOption.textContent, /unavailable/);
});

test("init() selects 'general' by default when it is present and enabled", async () => {
  const sandbox = buildSandbox({ fetchImpl: makeFetch(REAL_MODES) });
  const selectEl = createFakeElement("select");
  await sandbox.LinguaHubModeUI.init(selectEl);
  assert.equal(selectEl.value, "general");
});

test("a network failure falls back to the honest offline mode list instead of throwing or leaving the select empty", async () => {
  const sandbox = buildSandbox({ fetchImpl: makeFetch(null, { fail: true }) });
  const selectEl = createFakeElement("select");

  const result = await sandbox.LinguaHubModeUI.init(selectEl);

  assert.equal(result.usedFallback, true);
  assert.ok(selectEl.children.length > 0, "the select must still be populated, not left empty");
  assert.ok(result.modes.some((m) => m.id === "general" && m.enabled));
});

test("a malformed backend response (no modes array) is treated as a failure and falls back honestly", async () => {
  const sandbox = buildSandbox({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ notModes: [] }) })
  });
  const selectEl = createFakeElement("select");
  const result = await sandbox.LinguaHubModeUI.init(selectEl);
  assert.equal(result.usedFallback, true);
});

test("a non-ok HTTP response is treated as a failure and falls back honestly", async () => {
  const sandbox = buildSandbox({
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) })
  });
  const selectEl = createFakeElement("select");
  const result = await sandbox.LinguaHubModeUI.init(selectEl);
  assert.equal(result.usedFallback, true);
});

test("the offline fallback's enabled/disabled split matches the real backend registry", async () => {
  const sandbox = buildSandbox({});
  const fallback = sandbox.LinguaHubModeUI.OFFLINE_FALLBACK_MODES;
  const byId = Object.fromEntries(fallback.map((m) => [m.id, m]));
  assert.equal(byId.general.enabled, true);
  assert.equal(byId.codex.enabled, true);
  assert.equal(byId.cyber.enabled, true);
  assert.equal(byId["deep-thinking"].enabled, true);
  assert.equal(byId.image.enabled, false);
  assert.equal(byId.voice.enabled, false);
  assert.equal(byId["web-search"].enabled, false);
});

test("isSelectableMode is true only for a known AND enabled mode id", async () => {
  const sandbox = buildSandbox({});
  const { isSelectableMode } = sandbox.LinguaHubModeUI;
  assert.equal(isSelectableMode(REAL_MODES, "general"), true);
  assert.equal(isSelectableMode(REAL_MODES, "image"), false, "known but disabled");
  assert.equal(isSelectableMode(REAL_MODES, "nonexistent"), false, "unknown id");
});

test("getPromptSuggestions returns real, non-empty suggestions for every enabled mode", async () => {
  const sandbox = buildSandbox({});
  const { getPromptSuggestions } = sandbox.LinguaHubModeUI;
  for (const modeId of ["general", "codex", "cyber", "deep-thinking"]) {
    const suggestions = getPromptSuggestions(modeId);
    assert.ok(Array.isArray(suggestions) && suggestions.length > 0, `${modeId} should have suggestions`);
    for (const s of suggestions) {
      assert.equal(typeof s.label, "string");
      assert.equal(typeof s.prompt, "string");
      assert.ok(s.label.length > 0 && s.prompt.length > 0);
    }
  }
});

test("getPromptSuggestions falls back to general's list for an unknown/disabled mode id", async () => {
  const sandbox = buildSandbox({});
  const { getPromptSuggestions } = sandbox.LinguaHubModeUI;
  assert.deepEqual(getPromptSuggestions("image"), getPromptSuggestions("general"));
  assert.deepEqual(getPromptSuggestions("nonexistent"), getPromptSuggestions("general"));
});

test("prompt suggestions are genuinely mode-specific, not the same list reused for every mode", async () => {
  const sandbox = buildSandbox({});
  const { getPromptSuggestions } = sandbox.LinguaHubModeUI;
  const general = getPromptSuggestions("general").map((s) => s.label);
  const codex = getPromptSuggestions("codex").map((s) => s.label);
  const cyber = getPromptSuggestions("cyber").map((s) => s.label);
  assert.notDeepEqual(general, codex);
  assert.notDeepEqual(codex, cyber);
});
