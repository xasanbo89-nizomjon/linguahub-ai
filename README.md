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

## Deploy to Vercel

The web version runs on Vercel with no changes: `www/` is served as static files and the Express app (`server.js`) runs as one serverless function (`api/index.js`) that answers `/api/*`, `/health`, `/live`, `/ready` and `/chat`. Streaming chat (`/api/chat/stream`) and speech transcription (`/api/transcribe`) both work there; nothing writes to the local disk. Everything Vercel needs is already in `vercel.json`, `api/index.js` and `.vercelignore`.

1. Push the repository to GitHub and import it in Vercel (**Add New → Project**). Leave the framework as **Other**; the build settings come from `vercel.json` (`npm ci --omit=dev`, no build step, output folder `www`).
2. Add the environment variables below under **Settings → Environment Variables**, then deploy.
3. For Google sign-in, add the Vercel domain under **Firebase console → Authentication → Settings → Authorized domains**. (`www/firebase-config.js` holds the public web config of your Firebase project; it is not a secret and is not an environment variable.)

4. **Deploy the Firestore rules** (needed once, and again whenever `firestore.rules` changes - they stop people writing their own plan or usage count). Either paste the whole file into **Firebase console → Firestore Database → Rules** and press **Publish**, or from this folder run `npx firebase-tools login` and then `npx firebase-tools deploy --only firestore:rules --project <your-project-id>` (`firebase.json` already points at `firestore.rules`).
5. Give someone Premium with `node scripts/set-premium.js <email> <days>` (`0` removes it); it uses the same Firebase variables as the server, from `.env`.

Environment variables (names only; see `.env.example` for what each one does):

| Variable | Needed? |
| --- | --- |
| `OPENAI_API_KEY` | **Required** - chat, translation, word lookup and speech-to-text |
| `FIREBASE_PROJECT_ID` | **Required** since the daily limit: every AI request needs a verified sign-in, and usage is stored in Firestore (set all three) |
| `FIREBASE_CLIENT_EMAIL` | **Required** (same three) |
| `FIREBASE_PRIVATE_KEY` | **Required** (paste the key with its `\n` sequences) |
| `REQUIRE_SIGN_IN` | Optional - `false` (default): guests can use the app with a smaller daily allowance; `true`: every AI request needs a sign-in |
| `GUEST_DAILY_LIMIT` | Optional - guest AI requests per day per IP address (default 10) |
| `GUEST_IMAGE_DAILY_LIMIT` | Optional - guest picture messages per day (default 2) |
| `GUEST_GLOBAL_DAILY_CAP` | Optional - requests per day across ALL guests together (default 2000); then guests are asked to sign in |
| `GUEST_SALT` | Optional but recommended - a secret mixed into the guest IP hash (raw IPs are never stored) |
| `FREE_DAILY_LIMIT` | Optional - free AI requests per day per user (default 10; the day ends at midnight Asia/Tashkent) |
| `PREMIUM_PRICE_LABEL` | Optional - the price text in the paywall (default "Coming soon") |
| `PREMIUM_CONTACT_URL` | Optional - an https link (e.g. a Telegram link) the "Get Premium" dialog opens |
| `FRONTEND_ORIGINS` | Only if another site calls this API (same-origin needs nothing) |
| `MAX_GENERATION_MS` | Optional - longest AI reply in ms; defaults to 55000 on Vercel (the function limit in `vercel.json` is 60 s; raise both together on a plan that allows more) |
| `MAX_MESSAGE_LENGTH` | Optional - lowers a mode's input limit |
| `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX_REQUESTS`, `DEEP_THINKING_RATE_LIMIT_MAX_REQUESTS`, `GENERAL_RATE_LIMIT_MAX_REQUESTS`, `TRANSCRIBE_RATE_LIMIT_MAX_REQUESTS` | Optional - rate limits (defaults are fine) |
| `TRY_RATE_LIMIT_MAX_REQUESTS` | Optional - free sample corrections per IP per day on the landing page (default 3) |
| `TRANSCRIBE_MODEL` | Optional - speech-to-text model (default `whisper-1`) |
| `LOG_LEVEL` | Optional |
| `FIREBASE_CHECK_REVOKED` | Optional - also reject revoked sign-in tokens |
| `LINGUAHUB_INTERNAL_TOKEN` | Optional - only for trusted internal callers |
| `TRUST_PROXY` | Not needed - defaults to `1` on Vercel (set it only to override) |
| `NODE_ENV` | Not needed - Vercel sets `production` |

Not used on Vercel: `PORT`, `GOOGLE_APPLICATION_CREDENTIALS` (a file path - use the three `FIREBASE_*` variables), `SHUTDOWN_TIMEOUT_MS`, `REQUEST_TIMEOUT_MS`, `DATABASE_URL`, `RATE_LIMIT_STORE_URL`.

Good to know: rate limits are counted per function instance (the in-memory limiter), so they are a per-instance safety net, not a global quota; the request body limit on Vercel is 4.5 MB (recordings are capped at 4 MB); the microphone needs HTTPS, which Vercel provides. The desktop-only code (custom title bar, window controls, auto-update) only runs when the page is opened inside the Electron app and is skipped in a browser.

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
