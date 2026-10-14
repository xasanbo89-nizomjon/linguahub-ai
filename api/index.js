"use strict";

// Vercel serverless entry. Every API route (/api/chat, /api/chat/stream,
// /api/transcribe, /api/ai/modes, /api/auth/me ...) plus /health, /live,
// /ready and the legacy /chat is the same Express app that `node server.js`
// runs locally; vercel.json rewrites those paths here, and the page itself
// (www/) is served as static files. The app exports a (req, res) handler and
// only calls listen() when run directly, so nothing starts a server here.
// Streaming replies (text/event-stream) work as-is on the Node runtime.

module.exports = require("../server.js");
