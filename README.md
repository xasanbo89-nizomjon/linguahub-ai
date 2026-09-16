# LinguaHub AI

A multi-mode AI chat app: Express + OpenAI backend, a vanilla HTML/CSS/JS frontend (no framework, no bundler), with an Electron desktop shell and a Capacitor Android project sharing the same frontend code.

## Status

Phases 1–11 complete. See `docs/` for the full history — each phase's report documents exactly what was verified live, what was automated, what was mocked, and what was never run. Start with `docs/deployment-preflight-checklist.md` for the current state (Phase 11: production environment validation, structured logging, request IDs, multi-tier rate limiting, `/live`/`/ready` health endpoints, graceful shutdown, a production security/CORS/reverse-proxy audit, and Docker readiness — all real code, verified with a real `NODE_ENV=production` run, but **not deployed** — still blocked on a real Firebase project, a real Android SDK/device, and a real production domain/infrastructure).

## Quick start (production-shaped local run)

```bash
NODE_ENV=production PORT=3000 OPENAI_API_KEY=sk-... FRONTEND_ORIGINS=https://your-real-domain.example node server.js
```

See `docs/production-environment.md` for every variable this checks, and
`docs/deployment-preflight-checklist.md` for the full pre-launch
checklist. A minimal, non-root `Dockerfile` also exists for backend-only
container deployments (not built or deployed by this project itself -
see `docs/phase-11-production-preparation.md`, Task 21).

## Quick start (backend + browser)

```bash
npm install
cp .env.example .env        # then fill in OPENAI_API_KEY at minimum
node server.js               # backend on http://127.0.0.1:3000
```

Open `www/index.html` via any static file server (e.g. VS Code's "Live Server" on port 5500) or navigate the backend itself to `http://127.0.0.1:3000/` (it serves the frontend statically too). Guest chat works with no further configuration - Google sign-in requires a real Firebase project (see `docs/firebase-setup.md`).

## Quick start (Electron desktop shell)

```bash
npm start   # runs the backend and Electron together (concurrently)
```

## Running tests

```bash
npm test                       # fast unit/integration suite, no browser/network - see docs for current pass count
npm run test:e2e               # real-browser suites (Playwright + Chromium): smoke, responsive, accessibility,
                                # keyboard, network-failure, storage, security, performance, auth-error-matrix
npm run test:e2e:electron           # real Electron runtime launch
npm run test:e2e:electron:packaged  # real packaged app launch (run `npm run package:dry` first)
```

Both Electron suites launch a real `BrowserWindow`/packaged app. In an
agent sandbox that sets `ELECTRON_RUN_AS_NODE=1` (a guardrail against
accidentally spawning GUI windows), both scripts pass a scoped environment
override to the Electron child process only - no system-wide setting is
touched. See `docs/electron-distribution-checklist.md` for details.

`npm run test:e2e` needs a real `OPENAI_API_KEY` in `.env` (several checks make real chat requests) and downloads Chromium on first use (`npx playwright install chromium`).

## Project layout

- `server.js` - Express backend: chat routes, AI mode registry enforcement, auth middleware wiring, security headers, production hardening (env validation, logging, rate limiting, graceful shutdown - see `docs/phase-11-production-preparation.md`).
- `lib/` - backend-only modules: `aiModes.js` (the mode registry), `contextBuilder.js`, `firebaseAdmin.js`, `electronSecurity.js` (Electron's popup/navigation allowlist, kept separate so it's unit-testable without launching Electron), and (Phase 11) `env.js`/`logger.js`/`requestId.js`/`rateLimiter.js`/`gracefulShutdown.js` - each independently unit-tested, each documented in its own `docs/production-*.md` file.
- `middleware/auth.js` - Firebase ID token verification middleware (optional and required variants).
- `www/` - the entire frontend: plain JS modules (`app.js`, `chatStore.js`, `history-ui.js`, `auth.js`, `dialog.js`, `toast.js`, `settings-ui.js`, `mode-ui.js`, `markdown.js`), CSS (`theme.css` for tokens, `styles.css` for components), and vendored Markdown/sanitization/Capacitor libraries (`www/vendor/`, checked in rather than CDN-loaded — `auth.js` picks a web or native-Android backend at load time; see `docs/capacitor-native-auth.md`).
- `main.js` - the Electron entry point.
- `android/`, `capacitor.config.json` - the Capacitor Android project (shares `www/` as its `webDir`).
- `tests/` - the fast unit/integration suite (`node:test`, no external test framework).
- `e2e/` - real-browser suites (Playwright) plus their shared harness (`e2e/harness.js` starts a real backend + a throwaway static server per run).
- `docs/` - one report per phase, plus setup guides (`firebase-setup.md`) and final-state reports (`release-readiness-checklist.md`, `accessibility-final-report.md`, etc.).

## Configuration

See `.env.example` for every backend environment variable, with inline explanations. At minimum you need `OPENAI_API_KEY`. Firebase (both the frontend's `www/firebase-config.js` and the backend's `FIREBASE_*`/`GOOGLE_APPLICATION_CREDENTIALS` variables) is optional - the app runs correctly in guest-only mode with neither configured, and fails safely (never fakes a signed-in state) if only one side is configured.

## What this app does NOT do

- No fake AI capabilities: Image AI, Voice AI, and Web Search modes are visibly, honestly disabled in the UI and rejected by the backend - there is no real provider integration behind them yet.
- No client-controlled AI behavior: the frontend selects a mode by a stable id only; it can never supply or override a system prompt, model name, temperature, or token limit - the backend (`lib/aiModes.js`) is the sole source of truth.
- No cloud sync: chat history is LocalStorage-only, namespaced per guest/signed-in-user. There is no server-side chat storage.
