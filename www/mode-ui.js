// LinguaHub AI - mode selector UI.
//
// Owns the #mode-select element: fetches the backend's public mode
// metadata (id/label/description/enabled/capability only - see
// lib/aiModes.js toPublicMetadata()) and builds its <option> elements from
// that response. The frontend never invents a mode id, a capability, or an
// "available" state of its own - everything rendered here is exactly what
// the backend just reported, so Image AI/Voice AI/Web Search show up
// honestly disabled instead of silently missing or fake-enabled.

var LinguaHubModeUI = (function () {
"use strict";

var DEFAULT_MODE_ID = "general";

// Real-only prompt starters per mode (Task 5's "mode-specific empty-state
// prompt suggestions") - purely a composer-prefill convenience, never a
// claim about a capability the backend doesn't actually have. Falls back to
// "general" for any mode without its own list (including disabled modes,
// which the select won't let a user land on anyway).
// "icon" (Phase 13 UI polish) is a single decorative glyph rendered in the
// empty-state card - purely cosmetic, never read by any test or a11y tree
// item beyond aria-hidden decoration (see app.js's renderEmptyStateCards).
var MODE_PROMPT_SUGGESTIONS = {
general: [
{ label: "Ask a question", hint: "Get a clear, direct answer", prompt: "Can you help me understand ", icon: "◆" },
{ label: "Improve writing", hint: "Clarity, tone, grammar", prompt: "Improve the clarity and tone of this text:\n\n", icon: "✎" },
{ label: "Translate text", hint: "Any language pair", prompt: "Translate the following text to English:\n\n", icon: "◈" },
{ label: "Study and learn", hint: "Beginner-friendly explanations", prompt: "Explain this topic like I'm a beginner: ", icon: "✦" }
],
codex: [
{ label: "Explain code", hint: "Paste code for a walkthrough", prompt: "Explain what this code does:\n\n", icon: "◇" },
{ label: "Debug an error", hint: "Paste the error and code", prompt: "Help me debug this error:\n\n", icon: "◆" },
{ label: "Review code", hint: "Style, bugs, best practices", prompt: "Review this code for bugs and style issues:\n\n", icon: "✎" },
{ label: "Write a function", hint: "Describe what you need", prompt: "Write a function that ", icon: "✦" }
],
cyber: [
{ label: "Explain a vulnerability", hint: "How it works and how to fix it", prompt: "Explain how this vulnerability works and how to fix it:\n\n", icon: "◆" },
{ label: "Secure my code", hint: "Review for security issues", prompt: "Review this code for security issues:\n\n", icon: "◈" },
{ label: "Threat model", hint: "Plan defenses for a system", prompt: "Help me threat-model this system: ", icon: "✦" },
{ label: "Incident response", hint: "What to do next", prompt: "I'm responding to a security incident. Here's what I know so far: ", icon: "◇" }
],
"deep-thinking": [
{ label: "Weigh a decision", hint: "Compare options carefully", prompt: "Help me think through this decision carefully: ", icon: "◆" },
{ label: "Analyze a problem", hint: "Break it into parts", prompt: "Break this problem down step by step: ", icon: "◈" },
{ label: "Plan a project", hint: "Structured, detailed plan", prompt: "Help me create a detailed step-by-step plan for: ", icon: "✎" },
{ label: "Evaluate an argument", hint: "Strengths, weaknesses, gaps", prompt: "Evaluate the strengths and weaknesses of this argument:\n\n", icon: "✦" }
]
};

function getPromptSuggestions(modeId) {
return MODE_PROMPT_SUGGESTIONS[modeId] || MODE_PROMPT_SUGGESTIONS[DEFAULT_MODE_ID];
}

// Small, honest static fallback used ONLY if the live endpoint can't be
// reached (backend down, offline Electron/Capacitor launch before a
// connection exists) - kept in sync with lib/aiModes.js by
// tests/mode-ui.test.js, never used to fabricate a capability the backend
// hasn't actually confirmed. enabled/disabled state matches the real
// registry as of Phase 6.
var OFFLINE_FALLBACK_MODES = [
{ id: "general", label: "Free chat", description: "A broad, helpful assistant for everyday questions, writing, and multilingual conversation.", enabled: true, capability: "chat" },
{ id: "codex", label: "Codex AI", description: "A coding assistant for debugging, architecture, review, and secure code.", enabled: true, capability: "chat" },
{ id: "cyber", label: "Cyber AI", description: "A defensive cybersecurity assistant for secure coding, vulnerability explanation, and threat modeling.", enabled: true, capability: "chat" },
{ id: "deep-thinking", label: "Deep Thinking", description: "Slower, structured analysis for complex or ambiguous questions - more reasoning, longer answers.", enabled: true, capability: "chat" },
{ id: "image", label: "Image AI", description: "Image generation is not yet connected to a provider in this deployment.", enabled: false, capability: "unavailable" },
{ id: "voice", label: "Voice AI", description: "Voice input/output is not yet connected to a provider in this deployment.", enabled: false, capability: "unavailable" },
{ id: "web-search", label: "Web Search", description: "Live web search is not yet connected to a provider in this deployment.", enabled: false, capability: "unavailable" }
];

function buildOption(mode) {
var opt = document.createElement("option");
opt.value = mode.id;
opt.textContent = mode.enabled ? mode.label : (mode.label + " (unavailable)");
if (mode.description) opt.title = mode.description;
if (!mode.enabled) opt.disabled = true;
return opt;
}

function populateSelect(selectEl, modes) {
selectEl.textContent = "";
modes.forEach(function (mode) {
selectEl.appendChild(buildOption(mode));
});

var hasEnabledDefault = modes.some(function (m) { return m.id === DEFAULT_MODE_ID && m.enabled; });
if (hasEnabledDefault) {
selectEl.value = DEFAULT_MODE_ID;
} else {
var firstEnabled = modes.find(function (m) { return m.enabled; });
if (firstEnabled) selectEl.value = firstEnabled.id;
}
}

async function fetchModes() {
var apiUrl = (window.LINGUAHUB_CONFIG && window.LINGUAHUB_CONFIG.apiUrl)
? window.LINGUAHUB_CONFIG.apiUrl("/api/ai/modes")
: "/api/ai/modes";
var response = await fetch(apiUrl);
if (!response.ok) throw new Error("Server responded " + response.status);
var data = await response.json();
if (!data || !Array.isArray(data.modes)) throw new Error("Malformed /api/ai/modes response");
return data.modes;
}

// Fetches the live registry and populates selectEl's <option>s from it.
// Never throws - falls back to OFFLINE_FALLBACK_MODES (and reports
// usedFallback: true) if the backend can't be reached, so the UI still
// renders a usable (if possibly stale) selector rather than an empty one.
async function init(selectEl) {
var modes;
var usedFallback = false;
try {
modes = await fetchModes();
} catch (err) {
modes = OFFLINE_FALLBACK_MODES;
usedFallback = true;
}

populateSelect(selectEl, modes);
return { modes: modes, usedFallback: usedFallback };
}

function isSelectableMode(modes, modeId) {
return modes.some(function (m) { return m.id === modeId && m.enabled; });
}

return {
DEFAULT_MODE_ID: DEFAULT_MODE_ID,
OFFLINE_FALLBACK_MODES: OFFLINE_FALLBACK_MODES,
init: init,
populateSelect: populateSelect,
getPromptSuggestions: getPromptSuggestions,
isSelectableMode: isSelectableMode
};
})();

if (typeof module !== "undefined" && module.exports) {
module.exports = LinguaHubModeUI;
}

if (typeof window !== "undefined") {
window.LinguaHubModeUI = LinguaHubModeUI;
}
