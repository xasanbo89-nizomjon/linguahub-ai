# Health, Liveness, and Readiness (Phase 11)

Three endpoints, three distinct, standard meanings - not three names for
the same check.

## `GET /health`

Basic service identity/status - safe for a human or a simple load
balancer health check that just wants "is something here and responding."

```json
{"status":"ok","service":"linguahub-ai","timestamp":"...","environment":"production","requestId":"..."}
```

Unauthenticated (must remain reachable regardless of auth configuration -
unchanged since Phase 1). Never discloses a secret, a raw error, or
internal configuration - verified: `tests/server-production.test.js`,
"/health, /live, and /ready responses never contain a secret-shaped
value."

## `GET /live`

**"Is this process alive at all"** - always `200` if the Node event loop
can respond, checking nothing external. This is what an orchestrator's
*liveness* probe should call: if it fails, the orchestrator's correct
response is to restart the process, so it must never fail just because a
slow dependency (OpenAI, Firebase) is having a bad moment - that's what
readiness is for, not liveness. Never makes an external call.

```json
{"status":"alive","requestId":"..."}
```

## `GET /ready`

**"Can this process correctly serve traffic right now"** - reflects only
the dependencies *this deployment's own configuration* actually needs,
never a blanket requirement:

| Check | When it's required | How it's checked |
|---|---|---|
| `openaiKeyConfigured` | always | `Boolean(process.env.OPENAI_API_KEY)` - a config-presence check, **never a live OpenAI API call** (would be slow, costly, and rate-limit-consuming for something that should be cheap and frequent) |
| `firebaseAdminConfigured` | only if this deployment set *any* Firebase Admin variable (see `docs/production-environment.md`'s `authIntended`) | `firebaseAdmin.isConfigured()` - a real, already-computed boolean from `lib/firebaseAdmin.js`, not a new check |

A **guest-only** deployment (no Firebase variables set at all) is
`ready: true` without Firebase - this is correct, not a gap: Firebase was
never configured to be required, so it isn't part of what "ready" means
for that deployment. An **auth-enabled** deployment (any Firebase
variable set) that hasn't fully completed configuration (e.g. only two of
the three discrete vars) is correctly `ready: false` - it declared intent
to run authenticated routes but isn't actually able to yet. Verified:
`tests/server-production.test.js`, "GET /ready returns 200 and reports
openaiKeyConfigured... Guest-only deployment... must not require
Firebase."

```json
{"status":"ready","checks":{"openaiKeyConfigured":true},"requestId":"..."}
```
or, when not ready:
```json
{"status":"not_ready","checks":{"openaiKeyConfigured":true,"firebaseAdminConfigured":false},"requestId":"..."}
```
with HTTP status `503`.

### Database is deliberately NOT part of readiness (today)

`DATABASE_URL` is recognized but unused (see
`docs/production-environment.md`, Task 11) - no code path depends on it,
so including a fake "database ready" check here would be exactly the kind
of false readiness signal Phase 11 explicitly forbids. If a future phase
adds a real database dependency, its readiness check should be added here
following the same pattern: required only when the deployment's own
config indicates the dependency is actually meant to be active.

## Status codes

- `/health`, `/live`: always `200` (they exist to answer "is a response
  possible at all," so a non-200 response - if you get one - already
  answers the liveness question by itself; there is no partial-liveness
  state).
- `/ready`: `200` when every currently-required check passes, `503`
  otherwise - the conventional "temporarily unavailable, don't route
  traffic here yet" status.

## No secret disclosure, ever

None of the three endpoints returns a raw dependency error, an
environment variable value, a stack trace, or any Firebase/OpenAI
configuration detail beyond a plain boolean. Confirmed by direct source
review of `readiness()` in `server.js` (it returns only
`{ ready, checks }`, both structurally incapable of carrying a secret) and
by `tests/server-production.test.js`'s explicit secret-pattern scan of all
three responses.
