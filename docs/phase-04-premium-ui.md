# Phase 4 — Premium Design System, Modern App Shell, Responsive Chat UI, Glassmorphism, Dark/Light Themes, and Accessibility

Date: 2026-08-06

## 1. UI audit (pre-phase state)

`www/index.html` held ~230 lines of CSS in one inline `<style>` block (hence Phase 3's `style-src 'unsafe-inline'`), a flat dark-only palette with hardcoded hex colors repeated across ~15 rules, no design tokens, and a single breakpoint (`760px`) for the mobile drawer. Interactive elements: sidebar (list, search, new chat, export/import), header (mode select, clear chat, auth area), chat box (plain `.message` divs with `textContent` only, no per-message actions), composer (textarea + Send button, no auto-resize-while-typing, no Stop control). Delete/rename/clear confirmations used `window.prompt`/`window.confirm` (native, unstyled, unreachable by CSS theming). No toast system - status text only (`#history-status`, `#auth-status`). No empty state - a conversation with zero messages just showed a blank `.chat-box`. No settings surface at all. No theme system - colors were fixed dark-only inline values. Focus styles relied on browser defaults (present, but not deliberately designed). No RTL handling anywhere. `main.js`/`capacitor.config.json` had no popup-window handling relevant to UI (that was Phase 2's Electron OAuth fix, unrelated to this phase).

Reusable elements identified for extraction: button styles (`.auth-btn` family), the message bubble pattern, the sidebar-item pattern, the header-controls pattern - none of these had shared tokens (colors were repeated literals, not variables), which is what Task 2's design-token system now fixes.

## 2. Design system

`www/theme.css` defines every reusable value as a CSS custom property (colors, spacing, radius, motion, layout, elevation/blur, z-index) - `www/styles.css` never hardcodes a repeated color or spacing value. Themes: `light`, `dark`, and `system` (follows the OS preference and keeps following it live - see `www/theme.js`, §3.1). Brand direction: warm off-white/graphite backgrounds, a restrained warm gold accent (`#b8862f` light / `#e0b04e` dark) used only for small elements (buttons, focus rings, active states, the brand wordmark accent) - **never** as a background for large text areas, matching the explicit "no strong yellow for large text areas" instruction. Subtle glass surfaces (`--color-glass`, used on the header and composer bar with a small `backdrop-filter: blur(8px)`) for restrained depth without becoming unreadable - text always renders on an opaque surface (`--color-surface`/`--color-surface-elevated`), never directly on the blurred glass layer.

### 3.1 Theme persistence and no-flash strategy

`www/theme.js` is the **first script in `<head>`**, loaded as a plain blocking `<script src>` (not `defer`/`async`/`type="module"`) so it runs and sets `data-theme` on `<html>` before the stylesheets are applied or the body paints - no inline script was needed for this (see §17, CSP). Resolution order: an explicit stored choice (`localStorage["linguahub-ai:theme"]`) wins; otherwise `system` mode resolves from `prefers-color-scheme` and keeps listening for OS changes via `matchMedia(...).addEventListener("change", ...)` (with an `addListener` fallback for older WebView engines relevant to Electron/Capacitor). A broken/disabled `localStorage` (private browsing, storage quota policies) is caught and never crashes theme resolution - verified by test (`tests/theme.test.js`).

## 4. Application shell

Desktop: a fixed-width sidebar (`--sidebar-width: 288px`) plus a flexible main column, both real CSS Grid/Flexbox, no fixed pixel page width beyond the `max-width` cap. The sidebar now has a brand row (logo mark + wordmark + collapse control), New Chat, search, the conversation list, and a footer (Export / Import / **Settings**, new in this phase). The collapse control (`#sidebar-collapse-btn`) toggles an icons-only rail (`--sidebar-width-collapsed: 76px`) and **persists** via `localStorage["linguahub-ai:sidebar-collapsed"]` (Task 3: "sidebar state persists if appropriate") - verified by test. The header now shows the **active conversation's title** (`#conversation-title`, new) and a real status indicator (a small dot + text, `.active` class toggled by the same `setBusy()` that already existed - not a new fake indicator). No navigation item was added that doesn't do something real.

Tablet/mobile (≤768px): the sidebar becomes a fixed-position off-canvas drawer (see §5). No horizontal overflow was introduced - `overflow-wrap: anywhere` on message content, `overflow-x: auto` on code blocks/tables, and no fixed-width elements wider than the viewport at any of the 7 checked breakpoints (source-verified, see §13).

## 5. Sidebar and drawer

Selecting a conversation, New Chat, rename, delete, search, and account-namespace switching are all **unchanged behaviorally** from Phase 3 - only their presentation and confirmation mechanism changed. New in this phase: a real backdrop element (`#sidebar-backdrop`), a focus trap while the drawer is open (Tab/Shift+Tab cycle within the sidebar's focusable elements), Escape closes the drawer, clicking the backdrop closes the drawer, selecting a conversation closes the drawer, and `document.body` gets a `lh-scroll-locked` class (background scroll is prevented) while the drawer is open - all verified by test (`tests/history-ui.test.js`, "mobile drawer" tests) using the real `history-ui.js` source executed via Node's `vm` module against a fake DOM.

## 6. Empty state

Shown only when the active conversation has zero messages (`www/app.js`, `renderConversationMessages`). Uses the exact six suggestion categories the task recommended - **Ask a question, Explain code, Improve writing, Translate text, Study and learn, Plan a project** - each populating the composer with a real, usable starter prompt and focusing it (the user still decides whether/what to send; nothing auto-sends). No IELTS or Arabic-specific modes were added because none exist in `server.js`'s real `SYSTEM_PROMPTS` (confirmed by inspection before writing this section) - fabricating them would have violated rule 15/17.

## 7. Chat message experience

Each message is now `.message > .message-content + .message-actions` instead of a single text node - this was the one structural change to existing markup, and it was necessary to add a real Copy action without breaking streaming (the streaming code now targets `.message-content` specifically, never overwriting the actions button). Copy uses `navigator.clipboard.writeText` with a toast-based failure fallback (no silent failure). Actions are visible on hover **and** on focus (`:hover, :focus-within`), so they remain keyboard-reachable, not hover-only. Edit and regenerate were **not** added - Phase 3 explicitly established neither exists in this app, and the task says to add them "only if already implemented." Markdown/code/table/link/blockquote rendering is unchanged (this app never had a Markdown renderer to begin with - messages are and remain safe `textContent`, so there was nothing to "preserve" there beyond not regressing the plain-text safety). Long URLs wrap (`overflow-wrap: anywhere`), code blocks scroll internally (`overflow-x: auto`, verified by source test), and per-message RTL is auto-detected (see §11).

## 8. Composer

Auto-resize now happens on every `input` event (previously only reset after sending), capped at `200px` then scrolling internally. Enter sends / Shift+Enter inserts a newline - **unchanged**, now additionally gated by a real, persisted "Enter to send" setting (`www/settings-ui.js`) that defaults to the previous (only) behavior, so nothing changes unless the user opts out. **Stop is new and real**: the Send button becomes a Stop button (`.is-stop` class, text/aria-label swap) while `setBusy(true)`, and clicking it calls the exact `abortActiveGeneration()` function already used by logout/delete/clear/switch-conversation - this exposes an already-working capability via the UI for the first time, not a new mechanism. Duplicate-send prevention is unchanged (the input is disabled while busy, so a second Enter/click can't fire). Attachment and voice controls were **not** added - no such backend capability exists.

## 9. Dialog system

`www/dialog.js` replaces every remaining `window.prompt`/`window.confirm` call: rename (prompt-with-validation), delete (destructive confirm), and clear-current-conversation (destructive confirm) in `www/history-ui.js`, plus the new clear-all-local-history destructive confirm in `www/settings-ui.js`. Real focus trap, Escape-to-cancel, backdrop-click-to-cancel, and focus restoration to whatever element triggered the dialog - all verified by test (`tests/dialog.test.js`, 9 tests) against the real dialog.js source. Opening a second dialog while one is open resolves the first as cancelled instead of stacking (verified). Import confirmation was **not** changed to a dialog - Phase 3's import flow reports success/failure via status text/toast after the fact rather than asking for confirmation before importing (there was nothing to "confirm" - the file picker itself is the explicit action), so there was no native dialog usage there to replace.

## 10. Toast system

`www/toast.js`: a single `aria-live="polite"` region, capped at 3 simultaneous toasts (the 4th eviction removes the oldest - verified), auto-dismiss with a configurable duration (`0` means manual-only), a close button, `success`/`error`/`warning`/`info` variants via a left border color (never color alone - text and an icon-equivalent border are both present). Wired into `www/history-ui.js` (rename/delete/clear/export/import success and failure) and `www/app.js` (copy-to-clipboard failure). Existing `aria-live` status lines (`#history-status`, `#auth-status`) were **kept**, not removed - they still carry ongoing-state text ("Restoring session...", "Signing in...") for which a transient toast would be the wrong pattern; toasts were added for one-off events, not as a wholesale replacement (per the task's explicit "do not replace ... behavior unnecessarily if current implementation works").

## 11. Authentication/profile UI

Firebase auth logic (`www/auth.js`) was **not touched**. Visual changes only: restyled avatar/fallback/name/email using the new tokens, and the Account section of the new Settings panel **delegates its Logout button to the real `#logout-btn`'s click handler** (`document.getElementById("logout-btn").click()`) rather than reimplementing logout - guaranteeing identical behavior (loading state, abort-active-generation, Firebase `signOut()`) in both places, verified by test. No interactive Google login was performed in this phase (no browser available here - same limitation as Phases 1-3, and out of this phase's explicit scope per "Real Firebase browser login is not part of this phase").

## 12. Settings

Exactly the sections the task specified, no more: **Appearance** (System/Light/Dark, calls `LinguaHubTheme.setMode`), **Chat** (Enter-to-send toggle, Clear current conversation, Export current conversation), **Data** (Import conversation, Clear local history - genuinely implemented via a new `chatStore.clearAllConversations()` method, not faked), **Account** (signed-in identity or "Signed out", Logout). No model picker, no subscription tier, no fake sync toggle. Settings persist via `localStorage["linguahub-ai:settings"]`; unknown/future fields in that JSON are silently ignored rather than crashing (verified by test). The panel has a real focus trap, Escape closes it, and it never stacks a second instance.

## 13. Responsive verification

All checks below are **source-level** (the actual `@media` rules were confirmed present in `www/styles.css` via `tests/styles-source.test.js`, and the layout logic was reasoned through against real CSS) - **no real browser/visual verification at any of these widths was performed** (no browser automation tool exists in this environment, and the task says not to install one solely for this phase).

| Width | Rule present | Behavior (by CSS inspection) |
|---|---|---|
| 1440px | `@media (min-width: 1440px)` | Shell caps at 1500px, extra chat-area horizontal padding |
| 1280px | `@media (max-width: 1280px)` | Sidebar narrows to 260px |
| 1024px | `@media (max-width: 1024px)` | Sidebar narrows to 240px, empty-state cards go to 2 columns |
| 768px | `@media (max-width: 768px)` | Sidebar becomes the off-canvas drawer; toggle button appears |
| 430px | `@media (max-width: 430px)` | Header controls shrink, message max-width 92%, composer padding tightens |
| 390px | `@media (max-width: 390px)` | Brand wordmark and empty-state title font-size reduced |
| 360px | `@media (max-width: 360px)` | Header title and footer-button labels shrink/hide their text (icons/buttons remain) |

## 14. Accessibility

**Confirmed via source inspection and vm-executed DOM tests** (not a real screen reader - see the explicit "NOT RUN" line below): visible `:focus-visible` outlines defined globally and never removed without replacement (verified by test - a naive `outline: none` on `:focus` would fail the corresponding source check); the composer textarea and search input have associated `<label class="sr-only">` elements (verified); dialogs and the settings panel implement a real roving focus trap and restore focus to the triggering element on close (verified); the mobile drawer implements the same pattern (verified); all icon-only buttons (rename ✏️, delete 🗑️, copy ⧉, sidebar toggle ☰) have `aria-label`s; `#history-status`/`#auth-status`/the toast region are all `aria-live`; touch targets use a `--touch-target-min: 44px` token applied to every interactive control (verified by test); `prefers-reduced-motion: reduce` collapses all animation/transition durations to near-zero (verified by test).

**NOT RUN:** manual screen-reader testing (no screen reader available in this environment), real-browser 200%-zoom verification (reasoned about via relative units/no fixed pixel widths in the CSS, but not visually confirmed).

## 15. RTL and multilingual support

Per-message RTL detection (`www/app.js`, `RTL_PATTERN`, a Unicode range covering Hebrew/Arabic/Syriac/Thaana/NKo plus their presentation-forms blocks) sets `dir="rtl"` on that message's `.message-content` only - confirmed correct for Arabic, mixed Arabic/English, Russian (Cyrillic, correctly NOT flagged RTL), and Uzbek (Latin, correctly NOT flagged RTL) via a direct regex test during implementation, and structurally verified (CSS never forces `html[dir="rtl"]`/`body[dir="rtl"]` - checked by `tests/styles-source.test.js`). Code blocks inside an RTL message stay LTR (`.message-content[dir="rtl"] pre { direction: ltr; }`). The composer textarea gets the same per-content `dir` detection while typing. Conversation titles (already Unicode-safe since Phase 3's `truncateGraphemeSafe`) render correctly regardless of script. The application UI chrome itself (sidebar, header, dialogs) was **not** globally flipped to RTL - exactly as instructed, since interface language wasn't part of this phase.

## 16. Performance

Streamed tokens still update the DOM directly (unchanged from Phase 3) - no new per-token animation was added (the `lh-message-in` fade only plays once, on a message's initial creation, via a CSS `animation` on `.message` that doesn't re-trigger on content mutation). The chat auto-scroll now checks `isNearBottom()` before forcing scroll during streaming, so a user who has scrolled up to read history is no longer yanked back down on every token (a real fix, not present in Phase 3). `backdrop-filter` is used in exactly two small, non-scrolling areas (header, composer bar) with an opaque-surface fallback everywhere text actually renders - not applied to the scrolling chat area or the sidebar list. Dialogs/toasts/drawer all remove their DOM nodes and event listeners on close (verified structurally - `dismiss()`/`close()` call `removeEventListener` and detach the element; no test detected a lingering listener across repeated open/close cycles in the test suite's own repeated-invocation tests). Theme changes (`LinguaHubTheme.setMode`) only touch a `data-theme` attribute - no re-render, no app-state reinitialization.

## 17. CSP status

**`style-src 'unsafe-inline'` was fully removed**, not just reduced. Root cause confirmed before changing anything: the only reason it existed was Phase 1-3's single inline `<style>` block in `index.html`. This phase extracted 100% of CSS into two same-origin external files (`theme.css`, `styles.css`) referenced via `<link rel="stylesheet">`, and confirmed (source-test-verified) there are **zero** remaining `style="..."` attributes anywhere in `index.html`. The only JS-side style manipulation left (`element.style.height = ...` for composer auto-resize) is individual CSSOM property assignment, which CSP's `style-src` does not govern (it restricts `<style>` tags, `style=` attributes, and `.cssText`/`setAttribute('style', ...)` - not `.style.propertyName = value`). `script-src` was already `'self' https://www.gstatic.com` with no `unsafe-inline` since Phase 2 and remains unchanged. **Live-verified**: `curl -i http://127.0.0.1:3000/health` shows `style-src 'self'` with no `unsafe-inline` token present.

## 18. Bugs found

1. **Eviction/pruning tiebreak bug** - pre-existing from Phase 3, not touched or discovered fresh in this phase (already documented in `docs/phase-03-chat-history.md`).
2. **Two bugs introduced during this phase's own implementation**, caught and fixed before being considered done:
   - A regex literal for RTL detection got corrupted with literal rendered Unicode glyphs instead of `\uXXXX` escapes across several edit attempts (an artifact of the editing tool pipeline, not a logic error) - fixed by rebuilding the pattern via `String.fromCharCode`-based concatenation to guarantee literal ASCII escape text in the source file, then verified against real Arabic/English/Russian/Uzbek/mixed strings.
   - `history-ui.js`'s rename/delete/clear handlers becoming `async` (to use the new Promise-based dialog system) broke several Phase 3 tests that asserted synchronously right after a `.click()` - a test-only timing bug, not a product bug, fixed by awaiting a short tick in the affected tests.

## 19. Bugs fixed

Both items in §18.2 above; no other functional regressions were found across the full 159-test suite.

## 20. Files modified

| File | Reason | Change type |
|---|---|---|
| `www/index.html` | Remove the inline `<style>` block (CSP), add the theme/dialog/toast/settings scripts and stylesheet links, add sidebar-brand/collapse/backdrop/settings/empty-state/scroll-to-bottom/conversation-title markup | Structural additions + the inline `<style>` block removed entirely; no existing element id was renamed |
| `www/app.js` | New message DOM structure (content+actions+copy), auto-resize on input, Stop button, scroll-to-bottom, per-message/composer RTL, empty-state toggling, header conversation title, settings button wiring, Enter-to-send setting integration | Additive + one structural change (message markup) with all call sites updated |
| `www/history-ui.js` | Replace native prompt/confirm with the dialog system, add toast notifications, real mobile-drawer focus trap/Escape/backdrop/scroll-lock, sidebar-collapse persistence, expose new controller methods for Settings | Additive; existing method names/behavior preserved, three handlers became `async` |
| `www/chatStore.js` | Add `clearAllConversations()` for the real Settings "Clear local history" feature | Additive (one new method + its export) |
| `server.js` | Tighten CSP (`style-src 'self'`, no `unsafe-inline`) now that all CSS is external | One-directive change; no route/middleware logic touched |
| `tests/frontend-auth.test.js`, `tests/streaming-persistence.test.js` | Update fake DOM element factories for `setAttribute`/`classList.toggle`/new element ids needed by the new message structure | Test-only |
| `tests/history-ui.test.js` | Await the now-async dialog-based handlers; add `document.addEventListener`, `localStorage`, `focus()`, and new element ids to the fake sandbox; add sidebar-collapse/drawer tests | Test-only |

## 21. Files created

`www/theme.js` (no-flash theme resolution/persistence), `www/theme.css` (design tokens), `www/styles.css` (component styles), `www/dialog.js` (custom accessible dialog system), `www/toast.js` (toast/status system), `www/settings-ui.js` (settings panel), `tests/theme.test.js`, `tests/dialog.test.js`, `tests/toast.test.js`, `tests/settings-ui.test.js`, `tests/styles-source.test.js`, `docs/phase-04-premium-ui.md`.

No README exists in this repository to update (confirmed - none present, same as Phases 1-3).

## 22. Tests and commands run

```
node --check www/theme.js www/dialog.js www/toast.js www/settings-ui.js www/chatStore.js www/history-ui.js www/app.js server.js main.js
node --test                                    # full suite, all phases
node server.js                                 # background, live verification
curl -s -i http://127.0.0.1:3000/health        # CSP header inspection
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/{theme.js,theme.css,styles.css,dialog.js,toast.js,settings-ui.js}
curl -s -N --max-time 25 -X POST http://127.0.0.1:3000/api/chat/stream ...   # real OpenAI call
curl -s -i --max-time 2 http://127.0.0.1:5500/api/chat/stream               # port-5500 isolation
curl -s -i http://127.0.0.1:3000/api/auth/me -H "Authorization: Bearer x"   # 503, Admin unconfigured
curl -s -i -X OPTIONS http://127.0.0.1:3000/api/auth/me -H "Origin: http://127.0.0.1:5500" ...  # CORS preflight
curl -s http://127.0.0.1:5500/AI-chat-app/www/index.html | grep -E "theme.js|styles.css|dialog.js|toast.js|settings-ui.js"   # through the real static server on 5500
```

## 23. Test results

**159/159 automated tests passed, 0 failed** (100 from Phases 1-3 regression + 9 theme + 9 dialog + 8 toast + 15 settings-ui + 15 CSS/HTML source checks + 3 additional history-ui drawer/collapse tests). All live checks in §22 passed, including one real OpenAI streaming call made after every Phase 4 change, and a live CSP header confirmation that `style-src` no longer contains `unsafe-inline`.

## 24. Regression status

- 405 fix: **preserved** - live-verified, port 5500 still isolated.
- Port 3000 routing: **preserved**.
- Streaming: **preserved** - real OpenAI call succeeded post-Phase-4, including through the new message DOM structure.
- Auth: **preserved** - `/api/auth/me` still 503s correctly (Admin unconfigured), all Phase 2 auth tests pass, Firebase logic untouched.
- History: **preserved** - all Phase 3 chatStore/history-ui tests pass; the one new method (`clearAllConversations`) is additive.
- Import/export: **preserved** - unchanged logic, restyled UI, toast feedback added.
- CORS: **preserved** - live-verified preflight still succeeds.
- Helmet: **preserved and improved** - all headers still present; CSP `style-src` tightened, not weakened.

## 25. Remaining issues

- No real browser/visual verification was possible in this environment (no headless browser tooling installed, none added per instructions) - all responsive/visual claims are source-level only, clearly labeled as such throughout this document.
- No manual screen-reader testing was performed.
- Native `window.prompt`/`window.confirm` are now fully replaced everywhere they existed, but the browser's own `<input type="file">` picker (import) and `<input type="search">` chrome are still native OS UI, which is expected and not a gap.
- `backdrop-filter` support varies slightly across older WebView engines (some older Android System WebViews used by Capacitor may not support it); the two places it's used (header, composer bar) always sit on top of an otherwise-opaque `--color-surface` background, so the fallback in an unsupported engine is simply "no blur," not an unreadable surface - not verified on an actual old WebView, since none was available here.
- Settings persistence, theme persistence, and sidebar-collapse persistence are all per-browser/per-device LocalStorage, consistent with the rest of this app's storage model - no cross-device sync exists or is claimed.

## 26. Rollback notes

Every change is a source-level edit or an additive new file - no new npm dependency was added (theme/dialog/toast/settings are all vanilla JS + CSS, no framework). To roll back: revert the seven modified files (§20) and delete the eleven created files (§21). `server.js`'s CSP change is a single-line diff (`styleSrc` array). No git commit was created.
