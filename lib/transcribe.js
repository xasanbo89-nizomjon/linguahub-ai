"use strict";

// LinguaHub AI - speech-to-text endpoint (POST /api/transcribe).
//
// Used where the browser's own speech recognition does not exist or does not
// work (Electron, Firefox...): the page records a short clip with
// MediaRecorder and uploads it here; the text comes back as JSON. The OpenAI
// key stays on the server. The clip is held in memory only - nothing is
// written to disk (so this also runs on read-only serverless platforms) and
// nothing is logged except size and outcome.
//
// Limits (all enforced before any provider call):
//   - body size   MAX_AUDIO_BYTES (4 MB: under the 4.5 MB serverless request limit)
//   - minimum     MIN_AUDIO_BYTES (a few hundred bytes is never speech)
//   - type        an audio/* container the transcription API accepts
//   - language    one of the app's five languages, or omitted for auto-detect
//   - rate        the route's limiter (see server.js)

const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
const MIN_AUDIO_BYTES = 1024;
const MAX_TEXT_CHARS = 2000;
const SUPPORTED_LANGUAGES = ["en", "uz", "ar", "ru", "tr"];

// content type (without parameters) -> file name the provider uses to detect the format
const AUDIO_TYPES = {
  "audio/webm": "speech.webm",
  "audio/ogg": "speech.ogg",
  "audio/mp4": "speech.mp4",
  "audio/x-m4a": "speech.m4a",
  "audio/mpeg": "speech.mp3",
  "audio/mp3": "speech.mp3",
  "audio/wav": "speech.wav",
  "audio/x-wav": "speech.wav",
  "audio/wave": "speech.wav"
};

// Raw-body parser type matcher for express.raw().
const RAW_BODY_TYPES = Object.keys(AUDIO_TYPES);

function baseType(contentType) {
  return String(contentType || "").split(";")[0].trim().toLowerCase();
}

// -> { ok: true, fileName, language } | { ok: false, status, message }
function validateUpload({ contentType, body, language }) {
  const type = baseType(contentType);
  if (!Object.prototype.hasOwnProperty.call(AUDIO_TYPES, type)) {
    return { ok: false, status: 415, message: "❌ Unsupported audio format." };
  }
  if (!Buffer.isBuffer(body) || body.length === 0) {
    return { ok: false, status: 400, message: "❌ No audio was received." };
  }
  if (body.length > MAX_AUDIO_BYTES) {
    return { ok: false, status: 413, message: "❌ The recording is too long. Try a shorter one." };
  }
  if (body.length < MIN_AUDIO_BYTES) {
    return { ok: false, status: 422, message: "❌ The recording was too short." };
  }
  let lang;
  if (language !== undefined && language !== "") {
    lang = String(language).toLowerCase().slice(0, 2);
    if (!SUPPORTED_LANGUAGES.includes(lang) || String(language).length > 8) {
      return { ok: false, status: 400, message: "❌ Unsupported language." };
    }
  }
  return { ok: true, fileName: AUDIO_TYPES[type], language: lang };
}

// openai: the SDK client; toFile: OpenAI.toFile. Both injected so tests need no network.
function createTranscribeHandler({ openai, toFile, logger, model }) {
  const modelId = model || "whisper-1";
  return async function handleTranscribe(req, res) {
    const checked = validateUpload({
      contentType: req.headers["content-type"],
      body: req.body,
      language: req.query && req.query.lang
    });
    if (!checked.ok) {
      return res.status(checked.status).json({ text: "", reply: checked.message, requestId: req.id });
    }
    try {
      const file = await toFile(req.body, checked.fileName);
      const result = await openai.audio.transcriptions.create(
        { file, model: modelId, ...(checked.language ? { language: checked.language } : {}) },
        { timeout: 30000 }
      );
      const text = String((result && result.text) || "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARS);
      if (logger) logger.info("transcribed", { requestId: req.id, bytes: req.body.length, chars: text.length });
      return res.json({ text });
    } catch (error) {
      if (logger) logger.error("provider error", { requestId: req.id, category: "openai-transcribe", status: error && error.status });
      const message = error && error.status === 401 ? "❌ Invalid OpenAI API key. Check your .env file." : "❌ Couldn't transcribe the recording.";
      return res.status(502).json({ text: "", reply: message, requestId: req.id });
    }
  };
}

module.exports = {
  MAX_AUDIO_BYTES,
  MIN_AUDIO_BYTES,
  SUPPORTED_LANGUAGES,
  AUDIO_TYPES,
  RAW_BODY_TYPES,
  validateUpload,
  createTranscribeHandler
};
