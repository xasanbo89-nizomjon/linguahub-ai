require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const path = require("path");
const OpenAI = require("openai");

const { authenticateRequired, authenticateOptional } = require("./middleware/auth");
const aiModes = require("./lib/aiModes.js");
const { buildContext } = require("./lib/contextBuilder.js");
const internalAuth = require("./lib/internalAuth.js");
const contextValidator = require("./lib/contextValidator.js");
const firebaseAdmin = require("./lib/firebaseAdmin.js");
const { validateEnv } = require("./lib/env.js");
const { createLogger } = require("./lib/logger.js");
const { requestIdMiddleware } = require("./lib/requestId.js");
const { createMemoryLimiter, defaultKeyFn } = require("./lib/rateLimiter.js");
const { createShutdownHandler } = require("./lib/gracefulShutdown.js");
const transcribe = require("./lib/transcribe.js");

// Phase 11: validated once at module load, not per-request. In production
// a missing/malformed *required* value is a loud startup failure (see the
// require.main guard below) rather than a silent bad default; outside
// production every problem is a warning so local dev never needs a full
// production-shaped .env. See docs/production-environment.md.
const envResult = validateEnv(process.env);

const logger = createLogger({ level: envResult.logLevel, json: envResult.isProduction });

if (envResult.warnings.length > 0) {
  for (const warning of envResult.warnings) logger.warn(warning);
}
if (!envResult.ok) {
  for (const error of envResult.errors) logger.error(error);
}

const app = express();
const PORT = envResult.port;

// Reverse-proxy trust (Phase 11). Defaults to 0 (trust nothing - req.ip is
// the direct socket address) unless TRUST_PROXY is explicitly set, so a
// bare `node server.js` with no proxy in front of it is never fooled by a
// client-supplied X-Forwarded-For. See docs/production-network-and-cors.md
// for the expected single-reverse-proxy production topology
// (TRUST_PROXY=1).
app.set("trust proxy", envResult.trustProxy);

app.use(requestIdMiddleware);

// Structured request log: method, normalized route, status, duration,
// request id, and (only when a verified identity exists) the Firebase
// uid - never message content, never a header value, never a token. See
// docs/production-logging.md for the full redaction policy.
app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint();
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    logger.info("request", {
      requestId: req.id,
      method: req.method,
      route: (req.route && req.baseUrl + req.route.path) || req.path,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
      uid: req.user && req.user.uid ? req.user.uid : undefined
    });
  });
  next();
});

if (!process.env.OPENAI_API_KEY) {
  console.warn("⚠️  OPENAI_API_KEY is not set. Chat requests will fail until it is configured in .env.");
}

// Security headers, including a CSP scoped to what this app actually loads:
// same-origin scripts/styles, the Firebase Web SDK from Google's CDN, and
// the Firebase Auth REST/iframe endpoints used by Google sign-in. See
// docs/phase-02-authentication.md and docs/phase-04-premium-ui.md ("CSP
// status") for the rationale behind every directive and exception, and
// docs/production-security.md (Phase 11) for the production-only additions
// below (HSTS, Permissions-Policy).
app.use(
helmet({
contentSecurityPolicy: {
useDefaults: false,
directives: {
defaultSrc: ["'self'"],
scriptSrc: ["'self'", "https://www.gstatic.com"],
scriptSrcAttr: ["'none'"],
// As of Phase 4 all CSS lives in same-origin external files
// (theme.css, styles.css) - no more inline <style> block or style=
// attributes anywhere, so 'unsafe-inline' is no longer needed here.
// Individual CSSOM property assignments (element.style.foo = ...,
// used for the composer's auto-resize height) are NOT governed by
// style-src and are unaffected by this restriction.
styleSrc: ["'self'"],
imgSrc: ["'self'", "data:", "https://*.googleusercontent.com"],
connectSrc: [
"'self'",
"https://identitytoolkit.googleapis.com",
"https://securetoken.googleapis.com"
],
frameSrc: ["https://*.firebaseapp.com", "https://accounts.google.com"],
fontSrc: ["'self'"],
objectSrc: ["'none'"],
baseUri: ["'self'"],
formAction: ["'self'"],
frameAncestors: ["'self'"]
}
},
// Firebase's signInWithPopup relies on window.opener communication with
// the popup; the stricter default same-origin COOP breaks that handshake.
crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
// COEP's require-corp would block the gstatic-hosted Firebase SDK and
// Google profile-photo images, which don't send a CORP header for us.
crossOriginEmbedderPolicy: false,
// Only meaningful over a real HTTPS connection (browsers ignore HSTS
// received over plain HTTP) - safe to send unconditionally, since a
// local http://127.0.0.1 dev session simply won't have it acted upon.
// 180 days + subdomains, without "preload" (preload submission is an
// operator decision this project doesn't make on anyone's behalf).
strictTransportSecurity: { maxAge: 15552000, includeSubDomains: true }
})
);

// Permissions-Policy is not part of Helmet 8's own API (confirmed by
// inspecting its exports - it dropped built-in support for this header
// years ago since the spec was still in flux, and recommends setting it
// directly). This app uses no camera/geolocation/USB/payment API anywhere
// (confirmed by source review) - deny them all by default. The microphone
// is allowed for this origin only (self - never third-party frames) since
// Phase 14's voice chat uses the browser's Web Speech API (www/voice.js);
// the browser still asks the user for permission before any capture.
// Clipboard access (the Copy feature) is governed by the separate
// Clipboard API permission model, not Permissions-Policy, so it's
// unaffected by this list.
app.use((req, res, next) => {
res.setHeader("Permissions-Policy", "camera=(), microphone=(self), geolocation=(), payment=(), usb=()");
next();
});

const DEFAULT_ALLOWED_ORIGINS = [
"http://127.0.0.1:5500",
"http://localhost:5500",
"http://127.0.0.1:3000",
"http://localhost:3000",
"capacitor://localhost",
"http://localhost"
];

// Production/staging origins are added via FRONTEND_ORIGINS, validated at
// startup by lib/env.js (malformed entries are a startup error, not a
// silently-ignored one) - never touching code. Example:
// FRONTEND_ORIGINS=https://app.example.com,https://example.com
const ALLOWED_ORIGINS = Array.from(new Set([...DEFAULT_ALLOWED_ORIGINS, ...envResult.frontendOrigins]));

app.use(cors({
origin(origin, callback) {
// no Origin header: Electron file://, curl, mobile webviews - see
// docs/production-network-and-cors.md ("Electron/Capacitor origin
// handling") for why this is safe and unavoidable (CORS is a
// browser-enforced mechanism; a non-browser client that omits Origin
// bypasses it regardless of what this server does).
if (!origin || ALLOWED_ORIGINS.includes(origin)) {
callback(null, true);
} else {
// Safe to log: an Origin header is just a hostname, never a secret.
logger.warn("cors origin rejected", { origin });
callback(new Error("Not allowed by CORS"));
}
},
allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json({ limit: "10mb" }));

// Phase 11 general-purpose rate limiter (see lib/rateLimiter.js and
// docs/production-rate-limiting.md). Registered here, immediately after
// body parsing and before ANY route (including static assets, /health,
// /live, /ready) - Express matches middleware in registration order, so a
// limiter registered after a route would never even see requests to that
// route. This is the basic per-IP DoS backstop that covers every endpoint;
// the stricter, identity-aware chat/deep-thinking limiters are layered on
// top of it further down, only on the actual AI-generation routes.
const generalLimiter = createMemoryLimiter({
windowMs: 60000,
max: envResult.generalRateLimitMaxRequests,
keyFn: (req) => `ip:${req.ip || "unknown"}`,
name: "general"
});
app.use(generalLimiter);

// Static asset caching (Phase 11, Task 15). This project has no
// bundler/hashing build step (a deliberate, unchanged architecture
// decision - see README.md), so no asset filename changes when its
// content does. Long/immutable caching would risk serving a stale
// app.js/styles.css indefinitely after a real deploy - unsafe without a
// cache-busting mechanism this phase does not add. index.html (the SPA
// shell, and the only page runtime config like www/config.js's resolved
// API base can meaningfully change per-deploy through) is explicitly
// never cached; everything else gets a short, revalidated cache as a
// modest middle ground. See docs/production-environment.md.
app.use(express.static(path.join(__dirname, "www"), {
setHeaders(res, filePath) {
if (path.basename(filePath) === "index.html") {
res.setHeader("Cache-Control", "no-cache");
} else {
res.setHeader("Cache-Control", "public, max-age=300, must-revalidate");
}
}
}));

const openai = new OpenAI({
apiKey: process.env.OPENAI_API_KEY
});

// Phase 11: three endpoints with three distinct, standard meanings.
//   /health - basic service identity/status, safe for a human or a
//             load balancer's basic health check.
//   /live   - "is this process alive at all" - always 200 if the event
//             loop can respond, checks nothing external, so an
//             orchestrator's liveness probe never restarts a healthy
//             process just because a dependency is slow.
//   /ready  - "can this process correctly serve traffic right now",
//             reflecting only the dependencies THIS deployment's own
//             configuration actually requires (see readiness() below) -
//             never a blanket "Firebase must be configured" for a
//             deliberately guest-only deployment. Never makes a live
//             OpenAI call (slow, costly, and rate-limit-consuming) -
//             only checks that a key is present.
app.get("/health", (req, res) => {
res.json({
status: "ok",
service: "linguahub-ai",
timestamp: new Date().toISOString(),
environment: process.env.NODE_ENV || "development",
requestId: req.id
});
});

app.get("/live", (req, res) => {
res.status(200).json({ status: "alive", requestId: req.id });
});

function readiness() {
const checks = {};
checks.openaiKeyConfigured = Boolean(process.env.OPENAI_API_KEY);

// Only required when this deployment's own env actually intends to run
// authenticated routes (see lib/env.js's authIntended) - a guest-only
// deployment with no Firebase variables set at all is READY without
// Firebase, by design (see docs/phase-10-firebase-and-android.md and
// docs/phase-02-authentication.md's access policy).
if (envResult.authIntended) {
checks.firebaseAdminConfigured = firebaseAdmin.isConfigured();
}

// DATABASE_URL is currently unused (see lib/env.js/docs/phase-11-
// production-preparation.md, Task 11) - not included in readiness since
// no code path actually depends on it yet; adding a real dependency
// here without a real connection would be exactly the kind of fake
// readiness signal Phase 11 forbids.

const allOk = Object.values(checks).every(Boolean);
return { ready: allOk, checks };
}

app.get("/ready", (req, res) => {
const result = readiness();
res.status(result.ready ? 200 : 503).json({
status: result.ready ? "ready" : "not_ready",
checks: result.checks,
requestId: req.id
});
});

// Authenticated-only: returns the identity Firebase verified for this
// request. All values come from the verified token, never from anything
// the client sent directly - see middleware/auth.js.
app.get("/api/auth/me", authenticateRequired, (req, res) => {
res.json({ user: req.user });
});

// Public mode metadata only (Task 4) - id/label/description/enabled/capability.
// Never exposes systemPrompt, model, temperature, or limits; see
// lib/aiModes.js toPublicMetadata() for the exhaustive allowlist.
app.get("/api/ai/modes", (req, res) => {
res.json({ modes: aiModes.getPublicModes() });
});

// System prompts, models, temperatures, and limits are no longer defined
// here - lib/aiModes.js is now the single backend-authoritative source for
// all of that (Task 2/Task 6/Task 7/Task 8). Nothing in this file may set
// or override a mode's provider config; it may only look one up by id.

// Optional operator-set ceiling on top of each mode's own maxInputChars -
// unset by default, so a mode's configured limit (e.g. codex's higher
// 12000, for pasting more code) is authoritative rather than silently
// capped down to one global default. Only takes effect when an operator
// actually sets it.
const MAX_MESSAGE_LENGTH_OVERRIDE = process.env.MAX_MESSAGE_LENGTH ? Number(process.env.MAX_MESSAGE_LENGTH) : null;

// Accepts either the current schema ({ messages: [...], mode }) or the
// legacy single-message schema ({ message, mode }) used by earlier phases,
// for backward compatibility (Task 5). Any privileged field present in the
// body - model, systemPrompt, temperature, tools, ... - is rejected
// outright rather than silently ignored, per aiModes.FORBIDDEN_REQUEST_FIELDS.
function validateChatBody(req, res) {
const body = req.body || {};

// Every validation failure below carries requestId (Phase 11, Task 8) so
// a client-reported error can always be correlated to the exact log line
// without this response ever needing to expose anything internal.
function badRequest(message) {
res.status(400).json({ reply: message, requestId: req.id });
return null;
}

// 403, distinct from badRequest's 400 - this is an authorization failure
// (is the caller even allowed to supply trusted context at all), not a
// content-validation failure. Never includes the token itself, provided
// or expected, in the response - only a fixed, safe message.
function forbidden(message) {
res.status(403).json({ reply: message, requestId: req.id });
return null;
}

const presentForbiddenFields = aiModes.FORBIDDEN_REQUEST_FIELDS.filter((field) =>
Object.prototype.hasOwnProperty.call(body, field)
);
if (presentForbiddenFields.length > 0) {
return badRequest(`❌ This request may not set: ${presentForbiddenFields.join(", ")}.`);
}

// Trusted LinguaHub page context (Task: trusted-context transport
// contract) - completely optional, and only ever reachable by an
// authenticated internal LinguaHub backend caller. Ordinary public/guest
// chat requests never include a "context" key at all, so this block never
// runs for them and their behavior is completely unchanged. Checked here,
// early, as an access-control gate - before mode/message validation -
// because "is this caller allowed to supply context" is an authorization
// question, not a content-validation one.
let trustedContext = null;
if (Object.prototype.hasOwnProperty.call(body, "context")) {
const providedToken = internalAuth.getProvidedTokenFromRequest(req);
if (!internalAuth.verifyInternalToken(providedToken)) {
logger.warn("trusted context rejected: missing or invalid internal token", { requestId: req.id });
return forbidden("❌ Trusted context requires valid internal authentication.");
}
const contextResult = contextValidator.sanitizeContext(body.context);
if (!contextResult.ok) {
logger.warn("trusted context rejected: failed validation", { requestId: req.id, reason: contextResult.reason });
return badRequest(`❌ Invalid trusted context: ${contextResult.reason}.`);
}
trustedContext = contextResult.context;
}

let modeId;
if (body.mode === undefined || body.mode === null) {
modeId = aiModes.DEFAULT_MODE_ID;
} else if (typeof body.mode === "string") {
modeId = body.mode;
} else {
return badRequest("❌ Invalid mode.");
}

if (!aiModes.isValidModeId(modeId)) {
return badRequest(`❌ Unknown mode "${modeId}".`);
}

const mode = aiModes.getModeConfig(modeId);
if (!mode.enabled) {
return badRequest(`❌ "${mode.label}" is not available yet.`);
}

let rawMessages;
if (Array.isArray(body.messages)) {
rawMessages = body.messages;
} else if (typeof body.message === "string") {
if (!body.message.trim()) {
return badRequest("❌ Message is required.");
}
rawMessages = [{ role: "user", content: body.message }];
} else {
return badRequest("❌ Message is required.");
}

if (rawMessages.length === 0) {
return badRequest("❌ Message is required.");
}

for (const entry of rawMessages) {
if (!entry || typeof entry !== "object") {
return badRequest("❌ Invalid message format.");
}
// Only user/assistant may come from the client - a client-supplied
// "system" role is rejected outright, never silently dropped or
// folded into the real system prompt (Task 5/Task 6).
if (entry.role !== "user" && entry.role !== "assistant") {
return badRequest("❌ Invalid message role.");
}
if (typeof entry.content !== "string" || !entry.content.trim()) {
return badRequest("❌ Message content is required.");
}
}

const lastMessage = rawMessages[rawMessages.length - 1];
if (lastMessage.role !== "user") {
return badRequest("❌ The last message must be from the user.");
}

const maxChars = MAX_MESSAGE_LENGTH_OVERRIDE ? Math.min(mode.maxInputChars, MAX_MESSAGE_LENGTH_OVERRIDE) : mode.maxInputChars;
if (lastMessage.content.length > maxChars) {
return badRequest(`❌ Message is too long (limit ${maxChars} characters).`);
}

return { rawMessages, mode, trustedContext };
}

// Phase 11 production rate limiting, continued (generalLimiter itself is
// registered much earlier, right after body parsing - see above; Express
// matches middleware in registration order, so it has to be wired before
// any route, including /health/static, to actually cover them). The
// remaining two tiers apply only to the real AI-generation routes:
//   - chatLimiter - the real per-user/per-guest AI-generation budget,
//      keyed by verified uid where available (falls back to IP for guests
//      and for any malformed/absent token, so a bad Authorization header
//      can never grant a fresh budget).
//   - deepThinkingLimiter - a stricter secondary gate that only counts
//      requests for the most expensive mode (Deep Thinking - the larger
//      model, larger output budget, and longer timeout of all four
//      enabled modes, see lib/aiModes.js), keyed the same way so
//      alternating modes can never bypass it.
// The in-process MemoryStore is correct for local development, tests, and
// a genuine single-instance deployment; a horizontally-scaled deployment
// needs a shared store (RATE_LIMIT_STORE_URL) - see
// docs/production-rate-limiting.md for exactly what that does and does
// not currently do in this codebase.
const chatLimiter = createMemoryLimiter({
windowMs: envResult.rateLimitWindowMs,
max: envResult.rateLimitMaxRequests,
keyFn: defaultKeyFn,
name: "chat"
});

const deepThinkingLimiter = createMemoryLimiter({
windowMs: envResult.rateLimitWindowMs,
max: envResult.deepThinkingRateLimitMaxRequests,
keyFn: defaultKeyFn,
name: "deep-thinking",
skip: (req) => !(req.body && req.body.mode === "deep-thinking")
});

async function handleChat(req, res) {

const parsed = validateChatBody(req, res);
if (!parsed) return;

const context = buildContext(parsed.mode, parsed.rawMessages, { trustedContext: parsed.trustedContext });

try {

const completion = await openai.chat.completions.create(
{
model: parsed.mode.model,
messages: context.messages,
temperature: parsed.mode.temperature,
max_tokens: parsed.mode.maxOutputTokens,
// Learning-workspace modes (translate, grammar, ...) answer with one JSON
// object: ask the provider for JSON mode. Every other mode is unchanged.
...(parsed.mode.responseFormat === "json" ? { response_format: { type: "json_object" } } : {})
},
{ timeout: parsed.mode.timeoutMs }
);

// Authoritative usage metadata (Task: usage accounting integration prep).
// completion.usage is populated by OpenAI itself on every real non-stream
// response - never estimated/computed here. It's typed optional by the
// SDK, so a genuinely absent value still degrades to `usage: null` rather
// than a fabricated 0/0 - see docs/production-security.md's "never fake
// a number" precedent (the same principle this project already applies
// to auth/config fallbacks). completion.model is the actual identifier
// OpenAI reports for this response (may be a more specific dated
// snapshot than the requested parsed.mode.model) - never anything the
// client could have influenced (model remains a
// FORBIDDEN_REQUEST_FIELDS entry, unchanged).
const usage = completion.usage
? { inputTokens: completion.usage.prompt_tokens, outputTokens: completion.usage.completion_tokens }
: null;

res.json({
reply: completion.choices[0].message.content,
model: completion.model,
usage
});

} catch (error) {

logger.error("provider error", { requestId: req.id, mode: parsed.mode.id, category: "openai", status: error?.status });

const message =
error?.status === 401
? "❌ Invalid OpenAI API key. Check your .env file."
: "❌ Error connecting to AI";

res.status(500).json({ reply: message, requestId: req.id });

}

}

async function handleChatStream(req, res) {

const parsed = validateChatBody(req, res);
if (!parsed) return;

const context = buildContext(parsed.mode, parsed.rawMessages, { trustedContext: parsed.trustedContext });

res.setHeader("Content-Type", "text/event-stream");
res.setHeader("Cache-Control", "no-cache");
res.setHeader("Connection", "keep-alive");
// Reverse proxies that buffer responses (notably Nginx) will otherwise
// hold every chunk until the stream ends, defeating streaming entirely -
// this header is Nginx's own documented opt-out signal (see
// docs/production-sse-proxy.md for the full proxy-config story; Nginx
// additionally needs `proxy_buffering off;` in its own config, which this
// response header alone cannot force from the application side).
res.setHeader("X-Accel-Buffering", "no");
res.flushHeaders?.();

// Cancel the upstream OpenAI request if the client disconnects (e.g. the
// user closes the tab or aborts the fetch) instead of letting it run to
// completion in the background. Note: this must listen on the *response*,
// not the request - `req`'s "close" fires as soon as the (small, already
// fully-buffered) JSON body has been read, long before the client actually
// disconnects, which would abort every request instantly.
const abortController = new AbortController();
let clientDisconnected = false;
res.on("close", () => {
clientDisconnected = true;
abortController.abort();
});

// Also bound total generation time to the resolved mode's own budget
// (Task 8), independent of client disconnect, so a slow/hanging provider
// call can't hold the connection and rate-limit slot open indefinitely.
const timeoutHandle = setTimeout(() => {
abortController.abort();
}, parsed.mode.timeoutMs);

try {

const stream = await openai.chat.completions.create(
{
model: parsed.mode.model,
messages: context.messages,
temperature: parsed.mode.temperature,
max_tokens: parsed.mode.maxOutputTokens,
stream: true,
// The provider-supported mechanism for authoritative streaming usage
// (Task: usage accounting integration prep) - OpenAI's own documented
// opt-in (see node_modules/openai's ChatCompletionStreamOptions type).
// With this set, every delta chunk gains a `usage: null` sibling field
// (chunk.choices is untouched, so existing delta extraction below is
// unaffected) and one additional final chunk arrives with an EMPTY
// choices array and the real usage totals - never estimated. If the
// stream is interrupted before that final chunk arrives, usage simply
// stays unavailable (handled below as `usage: null`, never a guess).
stream_options: { include_usage: true }
},
{ signal: abortController.signal }
);

// Populated from the real provider stream only - see the finally-arriving
// usage chunk below. Never defaulted to 0/0; stays null if genuinely
// unavailable (e.g. the stream was interrupted before OpenAI sent it).
let finalUsage = null;
// Every chunk already carries the real model id (SDK type: non-optional
// `model: string`) - captured defensively in case a future/alternate
// response ever omits it, falling back to the backend-resolved mode's
// own model id (still never client-influenced - see FORBIDDEN_REQUEST_FIELDS).
let finalModel = null;

for await (const chunk of stream) {
if (chunk.model) finalModel = chunk.model;
const delta = chunk.choices[0]?.delta?.content;
if (delta) {
res.write(`data: ${JSON.stringify({ delta })}\n\n`);
}
if (chunk.usage) {
finalUsage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens };
}
}

if (!res.writableEnded) {
// One additional, safe metadata event after generation genuinely
// completes - never sent on the abort/timeout/error paths below, since
// there is no real "usage for this completed generation" to report
// there. Contains only the model id and token counts - no prompt/
// completion text, no internal provider fields, nothing beyond what
// the existing delta events and this response already establish is
// safe to send a client.
res.write(`data: ${JSON.stringify({ type: "done", model: finalModel || parsed.mode.model, usage: finalUsage })}\n\n`);
res.write("data: [DONE]\n\n");
res.end();
}

} catch (error) {

if (clientDisconnected) {
// Client already disconnected; nothing left to write.
return;
}

if (abortController.signal.aborted) {
// The mode's own timeout elapsed while the connection was still open -
// tell the client honestly instead of leaving the request hanging.
if (!res.writableEnded) {
res.write(`data: ${JSON.stringify({ error: "❌ The request took too long and was stopped." })}\n\n`);
res.end();
}
return;
}

logger.error("provider error", { requestId: req.id, mode: parsed.mode.id, category: "openai-stream", status: error?.status });

const message =
error?.status === 401
? "❌ Invalid OpenAI API key. Check your .env file."
: "❌ Error connecting to AI";

if (!res.writableEnded) {
res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
res.end();
}

} finally {
clearTimeout(timeoutHandle);
}

}

// Chat stays guest-accessible (hybrid policy - see docs/phase-02-authentication.md
// "Authentication policy"): authenticateOptional attaches a verified req.user
// when a valid Firebase ID token is sent, but never rejects the request when
// one isn't. It never trusts anything the client claims about its own identity.
// Phase 11: authenticateOptional now runs BEFORE the rate limiters (it used
// to run after), because chatLimiter/deepThinkingLimiter key by req.user.uid
// when present - keying by uid was impossible under the old order, since
// req.user didn't exist yet when the limiter ran.
// Speech-to-text for places without a working browser speech recognition
// (Electron, Firefox). The clip arrives as a raw audio body (no multipart
// parser needed), is limited in size and rate, and is held in memory only.
const transcribeLimiter = createMemoryLimiter({
windowMs: envResult.rateLimitWindowMs,
max: envResult.transcribeRateLimitMaxRequests,
keyFn: defaultKeyFn,
name: "transcribe"
});
const handleTranscribe = transcribe.createTranscribeHandler({
openai,
toFile: OpenAI.toFile,
logger,
model: process.env.TRANSCRIBE_MODEL || undefined
});
app.post(
"/api/transcribe",
authenticateOptional,
transcribeLimiter,
express.raw({ type: transcribe.RAW_BODY_TYPES, limit: transcribe.MAX_AUDIO_BYTES }),
handleTranscribe
);

app.post("/chat", authenticateOptional, chatLimiter, deepThinkingLimiter, handleChat);

app.post("/api/chat", authenticateOptional, chatLimiter, deepThinkingLimiter, handleChat);
app.post("/api/chat/stream", authenticateOptional, chatLimiter, deepThinkingLimiter, handleChatStream);

// Unmatched /api/* requests get a safe JSON 404 instead of Express's
// default HTML page (registered after the real routes above so it only
// catches what nothing else matched).
app.use("/api", (req, res) => {
res.status(404).json({ reply: "❌ Not found.", requestId: req.id });
});

// Centralized error handler: malformed JSON, oversized payloads, blocked
// CORS origins, and any other uncaught error all get a safe JSON response
// with no stack trace or internal detail leaked to the client. Every
// response includes requestId so an operator can find the matching log
// line without this endpoint ever needing to expose anything internal.
app.use((err, req, res, next) => {
if (res.headersSent) {
return next(err);
}

const isBodyParseError = err.type === "entity.parse.failed" || (err instanceof SyntaxError && err.status === 400);
const isTooLarge = err.type === "entity.too.large";
const isCorsRejection = err.message === "Not allowed by CORS";

logger.error("request error", {
requestId: req.id,
category: isBodyParseError ? "bad-json" : isTooLarge ? "too-large" : isCorsRejection ? "cors" : "internal",
errorName: err.name
});

if (isBodyParseError) {
return res.status(400).json({ reply: "❌ Invalid request body.", requestId: req.id });
}

if (isTooLarge) {
return res.status(413).json({ reply: "❌ Request body is too large.", requestId: req.id });
}

if (isCorsRejection) {
return res.status(403).json({ reply: "❌ Origin not allowed.", requestId: req.id });
}

res.status(500).json({ reply: "❌ Unexpected server error.", requestId: req.id });
});

// Phase 11 graceful shutdown. Handles SIGTERM (the standard signal an
// orchestrator/process manager sends before killing a container/process)
// and SIGINT (Ctrl+C in a terminal): stop accepting new connections, let
// in-flight requests finish, then force-close anything still lingering
// after a bounded timeout - directly reusing the lesson from the Phase 10
// port-5500 leak (a plain server.close(callback) can hang indefinitely on
// a lingering keep-alive connection; closeIdleConnections()/
// closeAllConnections() plus a bounded fallback timer is what actually
// guarantees termination). The handler itself lives in
// lib/gracefulShutdown.js (unit-tested there directly - see that file's
// header comment for why a real OS signal can't be used to verify this
// end-to-end in this specific sandboxed Windows environment).
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 10000;

if (require.main === module) {
if (!envResult.ok && envResult.isProduction) {
logger.error("refusing to start: invalid production environment configuration", { errorCount: envResult.errors.length });
process.exit(1);
}

const server = app.listen(PORT, () => {
logger.info("server started", { port: PORT, nodeEnv: envResult.nodeEnv, ...envResult.summary });
console.log(`🚀 LinguaHub AI running on http://localhost:${PORT}`);
});

// Bounds any single request/response cycle (distinct from each AI mode's
// own generation timeout in lib/aiModes.js, which only bounds the
// upstream provider call) - protects against a slow-loris-style hung
// connection tying up a worker indefinitely.
server.requestTimeout = envResult.requestTimeoutMs;
server.headersTimeout = Math.min(envResult.requestTimeoutMs, 65000);

const shutdown = createShutdownHandler(server, [generalLimiter, chatLimiter, deepThinkingLimiter, transcribeLimiter], {
timeoutMs: GRACEFUL_SHUTDOWN_TIMEOUT_MS,
logger
});
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
}

module.exports = app;
