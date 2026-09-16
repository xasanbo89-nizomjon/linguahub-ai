# Production Monitoring and Alerting (Phase 11)

## Honest status: a documented contract, not active monitoring

**No metrics backend, APM agent, or alerting integration is connected in
this codebase.** This document defines what should be measured and
alerted on, and exactly where in the code each signal is already
available (from Phase 11's structured logging) versus what a future phase
would need to add. Nothing here should be read as "monitoring is live" -
it explicitly is not, per this phase's own rule against claiming
monitoring is active unless actually connected.

## What already exists today (Phase 11): structured logs as the substrate

Every request already produces one structured log line (`docs/production-logging.md`)
with exactly the fields a metrics pipeline would need to derive most of
the list below *by parsing logs* - the cheapest, most honest form of
"monitoring" available without adding a new dependency:

```json
{"level":"info","message":"request","requestId":"...","method":"POST","route":"/api/chat/stream","status":200,"durationMs":842.1,"uid":"abc123"}
```

A log-based metrics pipeline (e.g. a sidecar that tails stdout and
computes counters/histograms, or a managed logging service's own
built-in metrics-from-logs feature) could derive request count, error
count (`status >= 500`), and latency percentiles from this alone, with
zero application code changes.

## Metrics/events this app could expose, and their current status

| Signal | Current status | Where the raw signal already exists |
|---|---|---|
| Process health | **available via `/live`** (real, active) | `GET /live`, `docs/production-healthchecks.md` |
| Readiness | **available via `/ready`** (real, active) | `GET /ready`, same doc |
| Request count | derivable from logs (not aggregated) | the "request" log line, every request |
| Error count (4xx/5xx) | derivable from logs (not aggregated) | `status` field on the same log line |
| Response latency | derivable from logs (not aggregated) | `durationMs` field |
| AI request latency | derivable from logs, but not separated from general latency yet | same `durationMs`, on `/api/chat*` routes specifically |
| AI provider failures | **logged, not counted** | `logger.error("provider error", { mode, category, status })` in `handleChat`/`handleChatStream` |
| Rate-limit hits | **logged as 429s in the request line, not counted separately** | the same "request" log line where `status === 429` |
| Stream aborts | not currently logged as a distinct event | `res.on("close")` in `handleChatStream` sets `clientDisconnected` but does not emit a log line - **a real, small gap**, see below |
| Authentication failures | **logged** via `middleware/auth.js`'s existing `console.warn("[auth] token verification failed:", ...)` (unchanged since Phase 2) - not yet routed through the Phase 11 structured logger | `middleware/auth.js` |
| Mode usage | derivable from logs (`route` + request body is not logged, but mode is present on error-path logs only, not success-path) - **a real, small gap**, see below | partial |
| Active requests (in-flight gauge) | not tracked | would need a simple counter incremented/decremented around each request |
| Graceful shutdown status | **logged** (`"shutdown started"` / `"shutdown complete"` / forced-close warnings) | `lib/gracefulShutdown.js` |

### Two real, small gaps found while writing this document

1. **Stream aborts aren't logged as their own event** - `handleChatStream`
   already correctly detects and handles a client disconnect
   (`clientDisconnected`), but doesn't log it, so "how often do users stop
   generations early" isn't currently observable even from logs. Left
   as-is this phase (out of the explicit Phase 11 scope of adding new
   logging call sites beyond what's already specified) but documented
   here precisely so it isn't lost.
2. **Successful chat requests don't log which mode was used** - only the
   *error* path currently includes `mode` in its log fields; a successful
   request's "request" log line has `route` but not `mode`, since mode
   lives in the request body (deliberately never logged in full, to avoid
   ever logging message content alongside it - see
   `docs/production-logging.md`). A future phase wanting real mode-usage
   metrics would need to add `mode` as its own explicit field on the
   per-request log line (not the whole body), which is safe to do (a mode
   id like `"general"`/`"deep-thinking"` is not sensitive) but wasn't
   added this phase to keep this phase's logging changes minimal and
   exactly scoped to what was specified.

## No public, unauthenticated sensitive metrics endpoint

This phase does **not** add a `/metrics` endpoint (Prometheus-style or
otherwise). `/health`/`/live`/`/ready` remain the only unauthenticated
introspection endpoints, and all three are deliberately limited to
booleans/timestamps - never request counts, error rates, or anything that
could give an attacker operational insight into the deployment. If a
future phase adds a real metrics endpoint, it should not be publicly
reachable without authentication (a separate internal port, an IP
allowlist, or a bearer-token-protected route - a decision for that future
phase, not assumed here).

## What a future "real monitoring" phase would need to add

1. Pick a metrics backend appropriate to the deployment target (a
   managed APM product, Prometheus + Grafana, or a log-based metrics
   pipeline reading the structured logs above - not decided here, since
   it depends on where this app actually gets deployed, which is unknown
   at this phase).
2. Add the two logging gaps above (stream-abort events, mode on the
   success path).
3. Wire an actual exporter/agent - genuinely connected, verified against
   a real backend, never simulated.

None of this is done in Phase 11. This document exists so that work is
well-specified, not so this phase can claim it's finished.
