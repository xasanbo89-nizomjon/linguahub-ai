"use strict";

// LinguaHub AI - "try one correction" for first-time visitors (POST /api/try-correct).
//
// The landing page lets someone who has not signed in check ONE sentence for
// real. This is a deliberately small, separate endpoint rather than the chat
// route: one short text in, one normalised correction out, answered by the
// internal "try-grammar" mode (JSON). server.js puts a strict per-IP limiter
// in front of it (a few requests per day) and the page itself remembers that
// the free try was used. Nothing is stored and the text is never logged.

const MAX_CHARS = 300;
const MAX_EDITS = 8;

function clip(value, max) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

// -> { language, corrected, edits: [{ original, correction, explanation }] } | null
function normalizeCorrection(parsed, text) {
  if (!parsed || typeof parsed !== "object") return null;
  const corrected = clip(parsed.corrected, MAX_CHARS * 2) || null;
  const rawEdits = Array.isArray(parsed.edits) ? parsed.edits : [];
  const edits = [];
  for (const raw of rawEdits) {
    if (!raw || typeof raw !== "object") continue;
    const original = typeof raw.original === "string" ? raw.original.slice(0, 120) : "";
    const correction = typeof raw.correction === "string" ? raw.correction.slice(0, 120) : "";
    if (!original.trim() || original === correction) continue;
    // an "original" that is not in the text cannot be shown inline: drop it rather than invent
    if (text.indexOf(original) === -1) continue;
    edits.push({ original, correction, explanation: clip(raw.explanation, 200) });
    if (edits.length >= MAX_EDITS) break;
  }
  if (!corrected && edits.length === 0 && !Array.isArray(parsed.edits)) return null;
  const language = typeof parsed.language === "string" && /^[a-z]{2}$/i.test(parsed.language.trim()) ? parsed.language.trim().toLowerCase() : "";
  return { language, corrected: corrected || text, edits };
}

function parseJson(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : null;
  } catch (error) {
    const match = /\{[\s\S]*\}/.exec(String(text || ""));
    if (!match) return null;
    try { return JSON.parse(match[0]); } catch (err) { return null; }
  }
}

// openai: the SDK client; mode: the "try-grammar" mode config (aiModes.getModeConfig)
function createTryHandler({ openai, mode, logger }) {
  return async function handleTryCorrect(req, res) {
    const body = req.body || {};
    const raw = typeof body.text === "string" ? body.text : "";
    // control characters never belong in a sentence
    const text = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim();
    if (!text) return res.status(400).json({ reply: "❌ Write a sentence first.", requestId: req.id });
    if (text.length > MAX_CHARS) return res.status(400).json({ reply: "❌ Keep it under " + MAX_CHARS + " characters.", requestId: req.id });
    try {
      const completion = await openai.chat.completions.create(
        {
          model: mode.model,
          messages: [{ role: "system", content: mode.systemPrompt }, { role: "user", content: text }],
          temperature: mode.temperature,
          max_tokens: mode.maxOutputTokens,
          response_format: { type: "json_object" }
        },
        { timeout: mode.timeoutMs }
      );
      const reply = completion && completion.choices && completion.choices[0] && completion.choices[0].message ? completion.choices[0].message.content : "";
      const result = normalizeCorrection(parseJson(reply), text);
      if (!result) {
        if (logger) logger.warn("try-correct: unreadable reply", { requestId: req.id });
        return res.status(502).json({ reply: "❌ Couldn't check that sentence.", requestId: req.id });
      }
      return res.json({ result });
    } catch (error) {
      if (logger) logger.error("provider error", { requestId: req.id, category: "openai-try", status: error && error.status });
      return res.status(502).json({ reply: "❌ Couldn't check that sentence.", requestId: req.id });
    }
  };
}

module.exports = { MAX_CHARS, normalizeCorrection, createTryHandler };
