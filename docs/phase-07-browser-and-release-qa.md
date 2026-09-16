# Phase 7 — Browser and Release QA

Real browser runtime verification and release hardening for LinguaHub AI. Builds on Phases 1–6 (405 fix, auth, chat history, premium UI, chat experience, AI modes) without rebuilding or redesigning anything. This document is the detailed record; see the chat transcript for the numbered final report.

## 1. Runtime audit (Task 1)

Reviewed before any changes: `package.json` scripts, `main.js` (Electron), `capacitor.config.json` + `android/`, `www/config.js` (API URL resolution), `www/firebase-config.js` + `.env` (Firebase state), `server.js` (CSP/CORS/Helmet), `www/index.html` + `www/styles.css` + `www/theme.css` (responsive/accessibility source), `www/history-ui.js`/`dialog.js`/`toast.js`/`settings-ui.js` (interactive component structure).

Findings:
1. **Browser-testable now**: the entire frontend, real backend, real OpenAI-backed chat (a working key is already in `.env`), all Phase 1–6 features.
2. **Requires Firebase credentials**: real Google sign-in, `/api/auth/me` success path. Not configured in this environment (verified: blank `www/firebase-config.js`, no Admin env vars) — see `docs/firebase-setup.md`.
3. **Requires OpenAI credentials**: real chat generation. Already available and used for all live checks in this phase.
4. **Requires Electron runtime**: `main.js`-specific behavior. Attempted live; blocked by this sandbox's `ELECTRON_RUN_AS_NODE=1` — see `docs/electron-verification.md`.
5. **Requires Capacitor runtime**: Android/iOS WebView-specific behavior. Not available in this environment — see `docs/capacitor-verification.md`.
6. **Requires a real device**: on-device keyboard, safe-area, touch, and native-OAuth behavior for Capacitor.
7. **Release blockers found and fixed this phase**: see §15/§16.
8. **Files potentially requiring modification**: identified correctly in advance — `www/styles.css`, `www/theme.css`, `www/history-ui.js`, `www/app.js`, `www/index.html` all ended up changed; `server.js` and the AI-mode/chat-store layers did not need changes.
9. **Regression risk**: all CSS/JS changes were scoped and re-verified against the full 271-test Phase 1–6 baseline plus new tests; no architecture, routing, or provider-integration change was made.
10. **Verification plan executed**: install Playwright + axe-core → smoke test → responsive/visual → accessibility → keyboard → network/storage/security/performance → Electron/Capacitor/Firebase audits → full regression → docs.

## 2. Browser automation setup (Task 2)

No existing browser automation tool was present. Added exactly one browser-automation dependency, **Playwright** (`^1.62.1`, devDependency), plus **axe-core** (`^4.13.0`, devDependency) specifically for Task 5's automated accessibility scanning — both single-purpose, justified, no overlapping frameworks. Playwright's bundled Chromium (both the full binary and the headless-shell variant) was downloaded via `npx playwright install chromium`.

Harness (`e2e/harness.js`): starts the real `server.js` (port 3000, real `.env` key) as a child process, waits for `/health`; starts a minimal same-repo static file server (`e2e/static-server.js`, ~50 lines, no new dependency) on port 5500 standing in for a dev "Live Server", mirroring exactly how this project has been manually tested since Phase 1; launches one headless Chromium context; tears down the browser, static server, and backend child process in a `finally` block on every run, including on failure. Verified no process or port is left behind after any run (checked via `tasklist`/`netstat` in this session).

Every script wires `page.on('console')`, `page.on('pageerror')`, `page.on('request'/'response'/'requestfailed')` and asserts on real DOM/network state — not simulation. `e2e/results.js` gives every script an identical `[PASS]/[FAIL]/[INFO]` console format plus a saved JSON report under `e2e/results/`.

`npm run test:e2e` (`e2e/run-all.js`) runs all 9 non-Electron suites in sequence, each in its own isolated process. `npm run test:e2e:electron` runs the Electron suite separately (needs a non-sandboxed machine — see §9). Neither is part of the default `npm test`, which stays exactly the fast, network-free 271→275-test unit suite.

## 3. Smoke test results (Task 3) — `e2e/smoke.js`, 38/38 passed

Real browser, real backend, real OpenAI key for generation/stop/edit/regenerate/retry; a scoped, clearly-labeled **mocked** route only for the two items (Markdown/code-block rendering, code-copy) that need deterministic content to assert on — live streaming itself is proven separately with the real provider in the same run. All 37 checklist items plus the port-5500 and no-405 checks passed. Full breakdown in `e2e/results/smoke.json`.

## 4. Responsive verification (Task 4) — `e2e/responsive.js`, 38/38 passed

All 7 required viewports (1440×900, 1280×800, 1024×768, 768×1024, 430×932, 390×844, 360×800) checked for: no horizontal page overflow, composer visibility, internal code-block scrolling, mobile-drawer open/close with backdrop, settings-button touch-target size and on-screen position, settings dialog fitting without overflow. Screenshots saved per viewport (`e2e/screenshots/<width>x<height>-full.png`, plus drawer-open shots for the 4 mobile widths and a settings-dialog shot at 360×800).

Two real defects were found and fixed via this suite — see §15.

## 5. Visual QA (Task 5→7 cross-reference)

Screenshots were actually opened and visually inspected (not just captured): 1440×900 desktop (light), theme-dark.png, 390×844 mobile, 360×800 drawer-open (twice — before and after the footer-button fix). Confirmed: clean spacing/typography, correct RTL/LTR mixed rendering, readable code blocks and tables, working dark-theme settings dialog with correct button/toggle styling, no clipped or overlapping controls after the two fixes below. No further visual defects found; no redesign performed.

## 6. Accessibility QA (Task 5) — `e2e/accessibility.js`, 15/15 passed

axe-core injected into the real page in 4 real states (empty state, populated conversation with markdown/code/table/RTL, settings dialog open, mobile drawer open). This is **automated tooling**, explicitly not a substitute for real screen-reader testing (NVDA/JAWS/VoiceOver) — none was performed, and none is claimed.

Confirmed and fixed (critical/serious, all now zero): 6 color-contrast violations and 1 nested-interactive violation — see §15. One structural improvement (moderate `landmark-one-main`/`region`) was also safely applied (`role="banner"`/`role="main"` + `aria-label` on the sidebar). Remaining moderate `region` findings (2 nodes — minor UI chrome like the auth-status line and composer not wrapped in a landmark) are documented, not fixed, per the phase's "document, don't force full coverage" allowance. Also checked and passing: single `<h1>`, no duplicate IDs, no unlabeled icon-only buttons, mode selector has an accessible name, disabled modes use real `<option disabled>` semantics, `prefers-reduced-motion` is honored live, and toast/live-region `aria-live="polite"` announces correctly.

## 7. Keyboard QA (Task 6) — `e2e/keyboard.js`, 26/26 passed

Real `page.keyboard.press()` sequences (not source reading) for: composer Enter/Shift+Enter, Stop, message-action buttons (Copy/Edit/Regenerate/Retry) including the `:focus-within` visibility rule, mode selector, theme buttons (Enter and Space), the settings dialog, the **real** `LinguaHubDialog` focus trap (rename) — Shift+Tab wraps to the last control, Tab from the last wraps back to the first, Escape cancels and restores focus to the exact button that opened it — delete confirm/cancel, clear-chat confirm/cancel, the mobile drawer's own focus trap (Shift+Tab from the true first element correctly wraps to the true last; Escape closes and restores focus to the toggle button), and the sign-in control (confirmed *disabled*, not fake-enabled, given no real Firebase project — see §8).

One real, confirmed keyboard-accessibility bug was found and fixed — see §15. No "profile menu" widget exists in this app (Sign in/Logout are plain buttons); documented as fact, not a defect.

## 8. Firebase readiness (Task 8) — status: **not configured**

Confirmed directly: `www/firebase-config.js` ships every field blank; `.env` contains only `OPENAI_API_KEY`, none of the four Admin-credential variables. This is the intended safe-default state, not a bug.

Live-verified in this state (real browser): the sign-in button is honestly `disabled` with the exact message *"Sign-in is unavailable: Firebase is not configured for this app."* (never fake-enabled); guest chat works completely normally end-to-end (all of §3–§7 ran as a guest); `/api/auth/me` was already covered failing safely with `503` in the existing unit suite (`tests/auth.test.js`, unchanged, still passing).

**Real Google login was NOT verified** — there is no real Firebase project in this environment, and this report does not claim otherwise. A complete, secret-free setup guide for whoever configures one is at `docs/firebase-setup.md` (Task 9), including the exact real-login verification checklist to run once a project exists.

## 9. Electron (Task 10)

Source-verified in full (contextIsolation/nodeIntegration, popup allowlist, `file://` → backend resolution, download/clipboard behavior) — all correct, no changes needed. A genuine runtime-launch script (`e2e/electron.js`, using Playwright's `_electron` support against the real backend) was written and attempted; it could not complete because this session's sandbox sets `ELECTRON_RUN_AS_NODE=1`, which prevents `main.js`'s `require("electron")` from returning the real Electron API — root-caused precisely via a direct `electron.exe main.js` invocation, not assumed. This is an environment property, not a project defect, and was not worked around. Full detail and the exact reproduction in `docs/electron-verification.md`. Packaging (`electron-builder`) was not run — out of scope for a QA phase.

## 10. Capacitor (Task 11)

Source-verified: `config.js`'s origin resolution for `capacitor://` and the Android WebView default origin, CORS allowlist already includes `capacitor://localhost`, `AndroidManifest.xml` reviewed (default cleartext-blocking behavior, `INTERNET` permission present, no custom network security config). No Android SDK/emulator/device is available in this environment, so nothing beyond source review was possible — stated plainly, not implied. One concrete, actionable gap was found and documented (not fixed, since it can't be verified without a real device): no dev-time cleartext allowance exists for connecting an emulator to a local backend. Full detail, including the explicit native-auth-plugin recommendation (not installed, per instructions), in `docs/capacitor-verification.md`.

## 11. Network failure QA (Task 12) — `e2e/network-failures.js`, 15/15 passed

Real Playwright route interception against the real frontend for: 401, 403, 429, 500, backend completely unreachable (`connectionrefused`), an indefinitely-hung request resolved by user Stop, a malformed (non-SSE-conformant) stream body, and an empty/zero-delta stream. In every case: the message settles to a real terminal status (never stuck "streaming"), the user's original prompt is preserved, no raw stack trace or internal path leaks into the UI, Retry is offered after a failure, the composer/Send button resets and stays usable, and no runaway toast accumulation occurs. No defects found in this area — confirms the abort/error-handling work from Phases 1–6 holds up under real, varied failure injection.

## 12. Storage QA (Task 13) — `e2e/storage.js`, 15/15 passed

Real LocalStorage behavior via real reloads: refresh restores the active conversation and its messages; New Chat never erases prior conversations; rename/delete/clear each affect only the targeted conversation and persist across reload; search finds by title/content; the guest namespace uses a real `...:guest` LocalStorage key (not a shared/bare key); deliberately corrupted JSON in that key does not crash the app on load and the app remains fully usable afterward; per-conversation mode selection persists across switching away and back; a `stopped` message restores as `stopped` after reload, never silently stuck; `chatStore.LIMITS.maxNamespaceBytes` (the proactive-pruning quota) is present and sane.

Two real, confirmed defects were found and fixed via this suite — see §15.

## 13. Security QA (Task 14) — `e2e/security.js`, 18/18 passed

Source scan of every `www/*.js` file for OpenAI-key-shaped or private-key-shaped strings (none found); confirmed `server.js` never echoes `OPENAI_API_KEY` in a response; confirmed `GET /api/ai/modes`'s response (checked live, real network bytes) contains no system prompt, model name, or key. A disabled mode cannot be forced through the UI (browser rejects a `selectOption` attempt on a `disabled` `<option>`) and is independently rejected by the backend even via a hand-crafted request (defense in depth). A client-supplied `model` override is rejected with `400`, never silently honored. CSP and Helmet headers were re-read at the real network level (Playwright's `APIRequestContext`, not in-page `fetch()` — see the note in §15 about why that distinction matters) and confirmed present and unchanged: full CSP string with no `unsafe-inline`/`unsafe-eval`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`. Markdown-rendered `<script>`, `onerror=`, and `javascript:` payloads were all confirmed inert (no execution, sanitized out) in a real rendered message. A hand-crafted malicious import (script tag + `onerror` image in the title) was confirmed to render as inert text, never execute. An exported conversation JSON was confirmed to contain no system-prompt fragments or secrets. CORS cross-origin rejection itself is not testable from in-page JS (browsers forbid scripts from spoofing the `Origin` header) — already covered by the existing Node-level `tests/server.test.js` check, not duplicated here.

## 14. Performance QA (Task 15) — `e2e/performance.js`, 7/7 passed

Lightweight Playwright-native timing, no new framework added. Indicative measurements from one run on one machine, not a formal benchmark: initial render+mode-bootstrap ~1.0s, theme switch ~290ms, mobile drawer open ~190–260ms (includes its real 320ms CSS transition budget), dialog open ~400ms, toast appearance ~350ms, rendering a freshly-seeded 150-message conversation ~370ms, search debounce ~275ms (matches the app's own 250ms debounce), JS heap growth after 15× New Chat + 10× settings-dialog open/close + 5× real generation cycles ~0MB (no leak observed). No confirmed regressions found; nothing fixed in this section.

## 15. Bugs found (all confirmed via real browser reproduction before any fix)

1. **`[hidden]` elements stayed visually rendered.** Author CSS rules that set `display` directly (`.empty-state{display:flex}`, `.user-profile{display:flex}`, `.user-avatar-fallback{display:flex}`) beat the browser's built-in `[hidden]{display:none}` UA-stylesheet rule (author origin always wins over user-agent origin, regardless of matching specificity) — the empty-state welcome card rendered on top of an active, populated conversation. Found visually inspecting the first responsive screenshot.
2. **Sidebar footer buttons went completely blank at ≤360px width.** A `@media (max-width:360px)` rule hid `.sidebar-footer-btn span` (Export/Import/Settings) alongside `#clear-chat-btn span` — but only `#clear-chat-btn` has no icon fallback *and* lives in the cramped header where the space saving is needed; the sidebar-footer buttons have no icon either but live in the roomy mobile drawer with no space pressure, so hiding their only content left three unlabeled, blank buttons. Found visually inspecting the 360px drawer screenshot.
3. **Rename/Delete buttons were completely unreachable by keyboard.** The `.conversation-item` row's own `keydown` handler (Enter/Space → select this conversation) didn't check `event.target`, so it fired — calling `preventDefault()` and selecting the wrong conversation — even when a nested Rename/Delete `<button>` had focus, silently swallowing the key event the button's own native "activate on Enter/Space" behavior needed. Found via real `page.keyboard.press("Enter")` testing; confirmed with a manual `dispatchEvent` control test proving the click handler itself was fine.
4. **Color-contrast failures (6, all "serious" per axe-core).** `--color-text-muted` (`#7a7566`) fell to 3.99:1 against the active list-item's tinted background (needs 4.5:1); `--color-accent` used as literal text color on white (`.sidebar-brand-accent`) measured 3.23:1; syntax-highlighter token colors (`.tok-keyword`, lifted from a real dark-editor theme) measured as low as **1.28:1** against the code block's actual rendered background, because that background was a `rgba(0,0,0,0.28)` alpha-blend over a variable underlying surface color rather than the fixed near-black the token colors were designed against.
5. **`nested-interactive` ARIA violation.** `role="option"` (inside a `role="listbox"`) strictly disallows focusable descendants, but each conversation row legitimately contains real Rename/Delete buttons — axe-core correctly flagged this as a serious semantic violation (separate from, but related to, bug 3 above).
6. **The header conversation title never live-updated.** `#conversation-title` is only set inside `renderConversationMessages()` (conversation switch/restore) — auto-titling on a brand-new conversation's first message updates the sidebar (via `refreshList()`) but not the separate header element, which stayed stuck on "New Chat" for the rest of the session until the user switched away and back or reloaded. Found via a real-reload storage test comparing the header text before and after.
7. **A generation stopped before any content arrived silently vanished from storage on reload.** `chatStore.saveMessage()` correctly rejects empty-content messages by design — but the friendly `"(Stopped - no response received)"` placeholder was only ever written into the DOM, never into what got persisted (`rawText`, captured before the placeholder substitution), so the entire assistant turn disappeared after a reload, leaving no record it was ever attempted. Found via a real-reload storage test.

Two false leads were investigated and correctly ruled out before any fix was made (documented so the reasoning is auditable, not just the conclusion): a `.message.ai{opacity:0.6}` reading and a settings-dialog color reading that both turned out to be the real CSS entrance-transition (120ms/200ms) caught mid-animation by a test that didn't wait long enough — re-verified after adding proper settle waits, confirming both were test artifacts, not app bugs.

## 16. Bugs fixed (exact changes)

| # | File | Change |
|---|---|---|
| 1 | `www/styles.css` | Added a global `[hidden]{display:none !important;}` rule (verified no component relies on `hidden` + a non-`none` display simultaneously — none of `dialog.js`/`toast.js`/`settings-ui.js`/`markdown.js`/`mode-ui.js` use the `hidden` attribute at all, they append/remove from the DOM instead). |
| 2 | `www/styles.css` | Narrowed the `@media (max-width:360px)` rule to `#clear-chat-btn span` only, removing `.sidebar-footer-btn span`. |
| 3 | `www/history-ui.js` | Added `if (e.target !== item) return;` at the top of the conversation item's `keydown` handler. |
| 4a | `www/theme.css` | Darkened `--color-text-muted` (both the fallback and light-theme blocks) from `#7a7566` to `#6a6558` — same hue, passes ≥5:1 against every surface color this theme uses. Dark theme's own `--color-text-muted` was untouched (not flagged). |
| 4b | `www/styles.css` | Added a light-theme-only override, `:root[data-theme="light"] .sidebar-brand-accent{color:#8f6a1c;}` — narrowly scoped to this one text usage; the shared `--color-accent` token itself is untouched (it's also used as a background elsewhere with its own separate, already-passing contrast-safe text color). Dark theme's accent-as-text (already ~8.5–9:1) was untouched. |
| 4c | `www/styles.css` | `.message-content pre`'s `background` changed from `rgba(0,0,0,0.28)` (alpha-blend, theme-dependent effective color) to a fixed `#14151a`, with an explicit `color:#f1efe9` for plain (non-highlighted) code text. Verified via WCAG relative-luminance calculation before applying: all three hardcoded token colors reach 6.5–10.7:1 against this fixed background. |
| 5 | `www/index.html`, `www/history-ui.js` | `#conversation-list`'s `role="listbox"` → `role="list"`; each item's `role="option"` → `role="listitem"`; `aria-selected` → `aria-current="true"` (only present on the active item, per ARIA best practice — `listitem` doesn't support `aria-selected`, and `aria-current` is valid on any element). |
| 5b | `www/index.html` | Added `role="banner"` to `.header`, `role="main" aria-label="Conversation"` to `.chat-scroll-wrapper`; left `<aside>`'s implicit `role="complementary"` alone after an explicit `role="navigation"` attempt was found invalid for that element by axe-core's `aria-allowed-role` check and reverted. |
| 6 | `www/app.js` | `sendMessage()` now sets `conversationTitleEl.textContent = saveResult.conversation.title` immediately after a successful save, using the title `chatStore` just auto-derived. |
| 7 | `www/app.js` | `generateAssistantReply()`'s persistence call now uses `rawText || aiBubble.contentEl.textContent` (falls back to whatever is actually displayed, including the placeholder set moments earlier) instead of the pre-placeholder empty `rawText`. |

Every fix was the smallest change that resolved the confirmed defect; no component was redesigned, no architecture changed, no working Phase 1–6 feature was touched beyond these exact lines.

## 17. Files modified

| Path | Reason | Type |
|---|---|---|
| `www/styles.css` | Fixes 1, 2, 4b, 4c | CSS fix |
| `www/theme.css` | Fix 4a | CSS token fix |
| `www/history-ui.js` | Fixes 3, 5 | JS + ARIA fix |
| `www/index.html` | Fix 5, 5b | ARIA/landmark markup |
| `www/app.js` | Fixes 6, 7 | JS logic fix |
| `package.json` | Added `playwright`/`axe-core` devDependencies, `test:e2e`/`test:e2e:electron` scripts | Tooling |
| `tests/styles-source.test.js` | Added the `[hidden]` regression guard | Test |
| `tests/history-ui.test.js` | Added the nested-interactive keydown regression test | Test |
| `tests/streaming-persistence.test.js` | Added the empty-content-persistence and header-title regression tests | Test |

## 18. Files created

- `e2e/harness.js`, `e2e/static-server.js`, `e2e/results.js` — shared test infrastructure
- `e2e/smoke.js`, `e2e/responsive.js`, `e2e/empty-state.js`, `e2e/accessibility.js`, `e2e/keyboard.js`, `e2e/network-failures.js`, `e2e/storage.js`, `e2e/security.js`, `e2e/performance.js`, `e2e/electron.js` — the 10 e2e suites
- `e2e/run-all.js` — orchestrator for `npm run test:e2e`
- `e2e/screenshots/*.png` and `e2e/results/*.json` — captured evidence
- `docs/phase-07-browser-and-release-qa.md`, `docs/firebase-setup.md`, `docs/electron-verification.md`, `docs/capacitor-verification.md`

## 19. Tests and commands

```
npm test                       # fast unit/integration suite (no browser, no network) - 275 tests
npm run test:e2e               # all 9 real-browser suites (needs a live OpenAI key in .env)
npm run test:e2e:electron      # Electron runtime suite (needs a non-sandboxed machine)
node e2e/smoke.js
node e2e/responsive.js
node e2e/empty-state.js
node e2e/accessibility.js
node e2e/keyboard.js
node e2e/network-failures.js
node e2e/storage.js
node e2e/security.js
node e2e/performance.js
node e2e/electron.js
npx playwright install chromium   # one-time browser binary install
```

## 20. Test results

- **Unit/integration** (`npm test`): 275/275 passing (271 pre-existing + 4 new Phase 7 regression tests). One transient Node test-runner IPC flake (`Unable to deserialize cloned data...`) was observed twice during this session's many `npm test` runs; both times the specific file (`tests/auth.test.js`) was confirmed passing 12/12 in isolation, and a full-suite re-run immediately after was clean — a `node --test` worker-process artifact, not a real failure, and not hidden (documented here).
- **Browser** (`npm run test:e2e`): 180/180 passing across smoke (38), responsive (38), empty-state regression (8), accessibility (15), keyboard (26), network-failures (15), storage (15), security (18), performance (7).
- **Accessibility**: 15/15 (see §6); 0 critical/serious violations remaining; 2 moderate `region` nodes and 0 minor violations documented as accepted.
- **Visual**: manually inspected, see §5; no outstanding defects.
- **NOT RUN**: Electron runtime completion (sandbox blocker, see §9), any real Firebase login (no project configured, see §8), any real Capacitor/Android device or emulator run (see §10), electron-builder packaging (out of scope), real screen-reader testing (never claimed).

## 21. Regression status

Phases 1–6 remain fully intact: the original 271-test baseline still passes unchanged (now 275 with 4 additions), every Phase 1–6 feature was exercised live and working during this phase's smoke/storage/network/security suites (streaming, stop, edit, regenerate, retry, all 4 enabled AI modes, guest/user namespace isolation, import/export, theming, dialogs, toasts, Markdown/code rendering), and no architectural change was made — every fix in §16 is a targeted CSS/attribute/small-JS-logic change.

## 22. Remaining issues (not hidden)

- 2 moderate axe `region` findings remain (composer/auth-status area not wrapped in a landmark) — documented, not fixed, per the phase's own "document minor/moderate remaining issues" allowance.
- No real Firebase project exists in this environment — real Google login, `/api/auth/me` success path, and the Capacitor-specific OAuth limitation are all unverified beyond source review.
- No Android SDK/emulator/device available — Capacitor runtime entirely unverified beyond source review; one concrete gap (no dev-time cleartext network security config) is documented but not fixed (can't be verified without a device).
- Electron runtime verification script exists and is correct but could not complete in this sandboxed session (`ELECTRON_RUN_AS_NODE=1`) — needs to be run once on a normal developer machine.
- No safe-area-inset CSS exists (relevant mainly if/when an iOS platform is ever added — none exists today).
- `package.json`'s `name`/`build.appId` still read the pre-rename `xasan-ai`/`com.xasan.ai` — cosmetic, no functional impact, not part of this phase's scope.
- Performance numbers in §14 are indicative (one run, one machine), not a formal benchmark baseline.

## 23. Production readiness score: 78%

Reasoning: the web application itself (backend, frontend, chat, history, modes, security posture, accessibility, keyboard support, responsive layout, error handling) is now thoroughly, genuinely verified in a real browser and in good shape — that's the largest share of the score. Held back from higher: no real Firebase project (auth is a named product feature that's currently unverifiable end-to-end), no real Electron/Capacitor runtime verification completed (both blocked by environment, not by defects), and no formal performance baseline. None of these are code defects — they're verification gaps this specific environment couldn't close, and are documented precisely enough that closing them is a well-defined, scoped follow-up rather than open-ended work.

## 24. Phase 8 recommendation

Configure a real Firebase project (using `docs/firebase-setup.md`) and run its verification checklist; separately, run `npm run test:e2e:electron` on a normal developer machine and a real Android device/emulator pass using `docs/capacitor-verification.md`'s checklist. Only after those three verification gaps close would a further hardening or pre-release phase be the right next step — not before, since redoing browser QA without first closing the three genuinely-unverified surfaces would mostly re-confirm what this phase already established.
