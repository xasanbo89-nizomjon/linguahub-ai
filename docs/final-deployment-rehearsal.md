# Final Deployment Rehearsal (Phase 12)

A dry run of every step a real deployment would require - **nothing was
deployed, published, signed, or uploaded**. Every check below was
actually executed against this real repository and a real running
process unless explicitly marked otherwise.

## 1. Backend start command

```
node server.js
```
Verified twice this phase: once under development defaults, once under a
full production-shaped environment (`NODE_ENV=production PORT=3000
OPENAI_API_KEY=... FRONTEND_ORIGINS=https://app.example.com
TRUST_PROXY=1 LOG_LEVEL=info`). Both start cleanly; the production
variant additionally logs a redacted config summary as its first line.

## 2. Frontend/static build output

**No build step exists or is needed.** `www/` is the deployable frontend
as-is (no bundler, no transpilation - a deliberate, unchanged
architecture decision) - `server.js`'s `express.static(path.join(__dirname,
"www"))` serves it directly. Deployment of the frontend is simply
deployment of the backend; there is no separate frontend artifact to
build or upload.

## 3. Docker build

**NOT RUN** - Docker is not installed in this development environment
(`docker: command not found`). The `Dockerfile` and `.dockerignore`
(Phase 11) were re-reviewed by direct inspection this phase and confirmed
accurate: the runtime stage copies `package.json`, `server.js`, `lib/`
(all five Phase 11 modules included automatically via directory copy),
`middleware/`, and `www/`; deliberately excludes `main.js` (Electron-only,
irrelevant in a container); runs as a non-root `node` user; and
`package-lock.json` (required by the build stage's `npm ci`) is confirmed
present in the repository. **This is a real, standing gap in this
rehearsal** - the Dockerfile has never been built, only reviewed - stated
plainly rather than assumed to work.

## 4. Environment variable checklist

Every variable `lib/env.js` recognizes, and what a real deployment must
set, is documented in `.env.example` and `docs/production-environment.md`
(Phase 11, re-verified accurate this phase - no variable was added or
removed). At minimum for a guest-only production launch:
`NODE_ENV=production`, `OPENAI_API_KEY`, `FRONTEND_ORIGINS`. For an
authenticated launch, additionally the three `FIREBASE_*` Admin variables
(or `GOOGLE_APPLICATION_CREDENTIALS`) - not set in this environment
(`docs/final-known-blockers.md`).

## 5. Reverse proxy configuration

`docs/nginx-example.conf` (Phase 11) - a complete, documentation-only
Nginx example covering TLS termination, HTTP→HTTPS redirect, SSE-specific
`proxy_buffering off`/extended timeouts on `/api/chat/stream`, real
client-IP forwarding, and no-cache on private API routes. Re-reviewed
this phase, unchanged, still accurate to the current `server.js`.

## 6. HTTPS/TLS requirements

This application has no TLS-termination code of its own (by design -
that's the reverse proxy's job, see above). `server.js` sends HSTS
unconditionally (harmless over plain HTTP - browsers only act on it after
receiving it over real HTTPS), verified live this phase.

## 7. Domain requirements

None hardcoded anywhere in this codebase (confirmed by this phase's own
bug sweep). A real deployment sets its real domain via `FRONTEND_ORIGINS`
(CORS) and, if serving a split-origin frontend, `API_BASE_URL` on the
frontend side - both mechanisms verified live this phase against a
placeholder domain (`https://app.example.com`), never a real one.

## 8. SSE proxy behavior

Verified live this phase: a real streamed request returns
`Content-Type: text/event-stream`, `Cache-Control: no-cache`, and
`X-Accel-Buffering: no` (Nginx's own buffering opt-out signal) -
unchanged from Phase 11.

## 9. Health/readiness probes

`/health`, `/live`, `/ready` all re-verified live this phase, including
under the full production-shaped boot. `/ready` correctly reports
`ready: true` for this guest-only configuration without requiring
Firebase.

## 10. Process startup/shutdown

Startup: verified live, both dev and production modes, including the
correct hard-fail (exit code 1) when required production config is
missing. Shutdown: the handler logic is unit-tested
(`tests/gracefulShutdown.test.js`, 7/7); real OS-signal delivery could not
be exercised end-to-end in this Windows sandbox (the same platform
limitation Phase 11 found and documented, reproduced again this phase via
a second, independent mechanism - see
`docs/phase-12-final-launch-audit.md`, Task 8).

## 11. Production origin configuration

Verified live: a request from the configured production origin is
allowed; a request from an unrecognized origin is rejected with a safe
403; local dev defaults remain unaffected.

## 12. Secret injection strategy

Documented, unchanged since Phase 11: environment variables only, via
`.env` locally (never committed - `.gitignore`'d) or a real platform
secrets mechanism in production (a container orchestrator's secret store,
a cloud provider's secrets manager, or `systemd`'s `EnvironmentFile=`) -
never hardcoded in source, never baked into a Docker image layer
(`.dockerignore` excludes `.env` and every known credential-file pattern
from the build context entirely).

## What this rehearsal proves, and what it doesn't

**Proves**: this application's own code is correctly production-shaped -
it validates its config, serves the right headers, streams correctly,
and starts/stops cleanly, all verified against a real running process.
**Does not prove**: that a real Nginx config, a real Docker build, a real
TLS certificate, or a real multi-instance deployment behaves identically
- none of those exist in this environment to test against. That gap is
the honest, primary reason this phase's acceptance decision is not
"READY FOR PRODUCTION" outright.
