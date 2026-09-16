# LinguaHub AI - production container image (Phase 11).
#
# Builds and runs ONLY the backend (server.js + www/ served statically by
# Express, exactly as it already runs today - see server.js's
# app.use(express.static(...))). Electron and Capacitor are separate,
# unrelated distribution paths (docs/electron-distribution-checklist.md,
# docs/android-capacitor-checklist.md) and are not part of this image.
#
# This file is provided as a production-portability option, NOT a
# deployment - nothing in this phase builds, runs, or publishes it. See
# docs/phase-11-production-preparation.md, Task 21.

# --- Build stage: install dependencies once, reused by the runtime stage
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Production dependencies only - devDependencies (electron, electron-builder,
# playwright, jsdom, axe-core) are test/desktop-build tooling this image
# never needs, and would otherwise roughly double the image size.
RUN npm ci --omit=dev

# --- Runtime stage: minimal image, no build tooling, no devDependencies
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Non-root runtime user - never run the application as root inside the
# container. The "node" official image already ships a "node" user/group;
# this just makes the intent explicit and pins the ownership of what gets
# copied in below.
RUN chown node:node /app
USER node

COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node server.js ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node middleware ./middleware
COPY --chown=node:node www ./www

# main.js (the Electron entry point) is deliberately NOT copied - it's
# the desktop-shell entry point (docs/electron-distribution-checklist.md),
# has no purpose in a headless container, and requiring it would need
# Electron itself (a devDependency, not installed by --omit=dev above).

# Matches server.js's own default (PORT env var, falling back to 3000) -
# overridable the normal container way (`-e PORT=...` / orchestrator env
# injection), never hardcoded elsewhere.
EXPOSE 3000

# No HEALTHCHECK instruction: this project's own /live and /ready
# endpoints (docs/production-healthchecks.md) are designed for an
# orchestrator's own liveness/readiness probes (Kubernetes, ECS, etc.),
# which are the correct, standard place to configure this - a Dockerfile-
# level HEALTHCHECK would duplicate that logic and is redundant (often
# actively unwanted) in an orchestrated deployment. Documented here rather
# than guessed into the image.

# server.js's own graceful-shutdown handler (lib/gracefulShutdown.js)
# listens for SIGTERM directly - no extra init/pid-1 signal-forwarding
# process (e.g. tini) is required as long as the container runtime sends
# SIGTERM to PID 1 directly, which `docker run`/most orchestrators already
# do for the CMD's own process (no shell wrapper below, so `node` runs as
# PID 1 - see the exec-form CMD).
CMD ["node", "server.js"]
