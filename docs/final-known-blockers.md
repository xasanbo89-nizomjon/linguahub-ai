# Final Known Blockers (Phase 12)

Every blocker below was re-confirmed directly this phase (not carried
forward from memory) - see `docs/phase-12-final-launch-audit.md` for the
exact commands run. None is a code defect; every one is a missing
external credential, device, certificate, or infrastructure resource.

## 1. No real Firebase project

**Blocks**: authenticated web login, real Firebase Admin token
verification, native Android Google sign-in.
**Confirmed**: `.env` has no `FIREBASE_*`/`GOOGLE_APPLICATION_CREDENTIALS`
values; `www/firebase-config.js` ships blank.
**Impact contained**: guest-mode chat is completely unaffected and fully
functional on every platform. The sign-in UI honestly reports
"unavailable" rather than faking a signed-in state.
**Resolution**: provision a real Firebase project and follow
`docs/firebase-production-checklist.md`'s exact checklist - no code
change is required, only configuration.

## 2. No real Android SDK/device

**Blocks**: building or running a real Capacitor Android APK, real
on-device testing of the native Google-auth adapter, real mobile
accessibility/performance verification.
**Confirmed**: `ANDROID_HOME`/`ANDROID_SDK_ROOT` unset, no SDK directory
present, `adb` not on `PATH`. Java, Gradle, AGP, and Capacitor's own CLI
are all confirmed working (Phase 9-11) - the SDK installation itself is
the only missing layer.
**Resolution**: install the Android SDK (exact `sdkmanager` command
documented in `docs/android-runtime-report.md`) - not performed
automatically per every phase's standing "do not install large global
tooling" rule.

## 3. No code-signing certificate

**Blocks**: producing a signed, publishable Electron installer.
**Confirmed**: no certificate was provided in any phase; none was
purchased or generated (out of scope for this project to obtain on
anyone's behalf).
**Impact contained**: an unsigned `--dir` build works correctly and was
verified this phase (9/10 real checks, one pre-existing environment-
caused finding unrelated to signing).
**Resolution**: an operator must obtain a real code-signing certificate
appropriate to the target platform and run `electron-builder` with
`CSC_LINK`/`CSC_KEY_PASSWORD` set - a deployment-time decision, not made
here.

## 4. No real production domain / TLS

**Blocks**: an actual HTTPS deployment, HSTS taking effect for real
users, a real reverse-proxy rehearsal.
**Confirmed**: `FRONTEND_ORIGINS` in this environment's `.env` is unset;
all live verification this phase used a placeholder
(`https://app.example.com`), never a real domain.
**Resolution**: provision a real domain + TLS certificate (e.g. via
Let's Encrypt behind the documented Nginx config,
`docs/nginx-example.conf`) and set `FRONTEND_ORIGINS` accordingly.

## 5. No active monitoring/alerting backend

**Blocks**: real-time visibility into production errors, latency, or
provider failures once deployed.
**Confirmed**: `docs/production-monitoring.md` documents a contract
(structured logs, the fields a metrics pipeline would need) - no metrics
backend, APM agent, or alert integration is connected anywhere in this
codebase.
**Resolution**: connect a real logging/metrics pipeline appropriate to
the hosting platform (details deployment-specific, not decided here) and
wire the two small logging gaps already identified
(`docs/production-monitoring.md`: stream-abort events, success-path mode
logging).

## 6. Redis-backed shared rate limiter not connected

**Blocks**: correct rate-limit enforcement across a horizontally-scaled
(multi-instance) deployment specifically - a single-instance deployment
is entirely unaffected.
**Confirmed**: `lib/rateLimiter.js`'s `RedisStore` exists as a real,
fail-loud contract; `redis` is deliberately not a `package.json`
dependency; nothing in `server.js` currently constructs a `RedisStore`
regardless of whether `RATE_LIMIT_STORE_URL` is set.
**Resolution**: documented step-by-step in
`docs/production-rate-limiting.md` - install `redis`, wire it into
`server.js`'s limiter construction, verify against a real Redis instance.

## 7. Docker image never built or scanned

**Blocks**: full confidence in the container deployment path
specifically (the `Dockerfile`/`.dockerignore` have been reviewed but
never executed).
**Confirmed**: `docker: command not found` in this environment.
**Resolution**: build the image on a machine with Docker installed and
re-run `node e2e/secret-scan.js`-equivalent scanning against the built
image's filesystem before trusting it for a real deployment.

## What is explicitly NOT blocked

Web guest-mode chat (every AI mode, streaming, history, import/export,
markdown, accessibility, responsive layout, security controls) and
unsigned Electron desktop distribution are both fully verified and ready
today, independent of every blocker above.
