# Production Logging (Phase 11)

## What exists

`lib/logger.js` - a small, dependency-free structured logger, deliberately
not a general observability stack. `createLogger({ level, json })`
returns `{ debug, info, warn, error, child }`.

| Requirement | Status |
|---|---|
| Levels: debug/info/warn/error | ✅, plus `silent` (drops everything) |
| Production JSON-friendly logs | ✅ - `json: true` by default when `NODE_ENV=production` (or set explicitly); one parseable JSON object per line, easy for any log shipper (`journald`, a container runtime's own log driver, a managed logging agent) to ingest without a special parser |
| Development-readable mode | ✅ - `json: false` (the default outside production): `[timestamp] LEVEL message {fields}` |
| Request ID in every request log | ✅ - see `docs/production-healthchecks.md`... actually see below, request logging |
| Method, normalized route, status, duration | ✅ - the per-request logging middleware in `server.js` |
| Safe user identifier (uid only, never message content) | ✅ - `req.user.uid` when present, otherwise omitted entirely (never falls back to logging an IP as a stand-in identity field) |
| Mode ID | ✅ - included in provider-error log entries (`{ mode: parsed.mode.id }`) |
| Error category | ✅ - `bad-json` / `too-large` / `cors` / `internal` / `openai` / `openai-stream` |
| No message content by default | ✅ - enforced two ways: no call site anywhere in `server.js` passes chat content to the logger, AND `lib/logger.js`'s `redact()` treats `message`/`messages`/`content`/`reply`/`prompt` as sensitive-by-name defense-in-depth, even if a future call site accidentally did |
| No OpenAI key / Firebase token / Firebase private key / Authorization header / cookies / system prompts / raw imported chat | ✅ - none of these are ever passed to a log call in this codebase (verified by direct source review of every `logger.*`/`console.*` call in `server.js`), and `redact()` additionally strips any field literally named one of these, recursively into nested objects |

## Redaction - defense in depth, not the only safeguard

`lib/logger.js`'s `SENSITIVE_KEYS` set matches field *names*
case-insensitively (`authorization`, `cookie`, `token`, `idtoken`,
`apikey`, `openai_api_key`, `firebase_private_key`, `password`, `secret`,
`systemprompt`, `message`, `messages`, `content`, `reply`, `prompt`, ...),
replacing their value with `[REDACTED]` before a line is ever written -
recursively, so a nested object can't smuggle a sensitive field past it.
This is **defense in depth**, not the primary safeguard: the primary
safeguard is that every logging call site in `server.js` was written to
only ever pass safe metadata in the first place (verified by direct
review, listed in the table above) - `redact()` exists to catch a future
mistake, not to launder an already-unsafe call site.

Verified directly: `tests/logger.test.js`, "a logged call never leaks a
sensitive field, end to end", plus a dedicated structural test carried
over from Phase 10's native-auth adapter pattern
(`tests/native-auth-adapter.test.js` already covers the frontend
equivalent for `www/auth.js`).

## Request logging (new this phase)

Every request gets one structured "request" log line, emitted on
`res.on("finish")` (after the response has actually been sent, so
`res.statusCode` and real duration are both accurate):

```json
{"level":"info","message":"request","time":"...","requestId":"...","method":"GET","route":"/api/ai/modes","status":200,"durationMs":1.42,"uid":"abc123"}
```

`uid` is present only when a request carried a verified identity;
otherwise it's simply absent from the line (not `null`, not an IP
standing in for it - no identity claim is made for a guest request).

## Log level

Controlled by `LOG_LEVEL` (`docs/production-environment.md`), default
`info`. `debug` is available for local troubleshooting but not the
production default (would log every request at a more verbose level than
needed for normal operation - the single "request" summary line at `info`
is already the per-request record).

## What this is NOT

This phase does not introduce a log aggregation service, a metrics
database, distributed tracing, or any external logging dependency -
`lib/logger.js` writes to `stdout` only (via a single, testable `write`
function), which is the correct, standard integration point for virtually
every production log pipeline (a container runtime captures stdout
directly; `systemd` services are captured by `journald`; a process
manager like PM2 captures and rotates it). Shipping stdout somewhere
durable is an infrastructure/deployment decision outside this
application's own code, intentionally not made on anyone's behalf here.
