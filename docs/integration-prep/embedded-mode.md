# Embedded mode

## The concept

This app now runs in one of two modes, resolved once at load time by
`www/app-mode.js`:

- **`standalone`** (default, zero configuration) - today's real, only-used
  deployment. Full app: its own sidebar, conversation history, profile/
  login, Import/Export, mode selector. Nothing about this changed.
- **`embedded`** - not used anywhere today. Reserved for a future
  LinguaHub-hosted panel. Simplifies a small, explicitly-named set of UI
  surfaces so the assistant doesn't duplicate controls LinguaHub's own
  shell will already provide.

This is **not** a fork. There is one codebase, one set of HTML element
IDs, one CSS file, one set of JS modules. Embedded mode is a small set of
CSS/config deltas layered on top of the exact same app, not a second build.

## How it's configured

Mirrors `www/config.js`'s own documented override pattern exactly - the
same `window.LINGUAHUB_CONFIG` object, set by an inline `<script>` before
`config.js`/`app-mode.js` load:

```html
<script>
  window.LINGUAHUB_CONFIG = {
    APP_MODE: "embedded",           // "standalone" (default) | "embedded"

    // Optional per-feature overrides - each independently turns a piece
    // of embedded mode's default simplification back on, without forking
    // app-mode.js. Omit any of these to take the mode's own default.
    SHOW_IMPORT_EXPORT: false,      // default: false in embedded, true in standalone
    SHOW_MODE_SELECTOR: false,      // default: false in embedded, true in standalone
    SHOW_ACCOUNT_UI: false          // default: false in embedded, true in standalone
  };
</script>
<script src="theme.js"></script>
<script src="app-mode.js"></script>
```

Nothing in this repository sets `APP_MODE` to `"embedded"` - this is
entirely inert until a future host page does it. `app-mode.js` stamps
`[data-app-mode]` and three `[data-show-*]` attributes onto `<html>`
before first paint (same reasoning as `[data-theme]`), which `styles.css`
uses to hide the relevant controls with no flash of the standalone UI.

## What changes in embedded mode (and why)

| Surface | Standalone | Embedded (default) | Why |
|---|---|---|---|
| Import/Export (sidebar icons + Settings dialog rows) | Visible | Hidden | Task 2 product decision - a student-facing embedded assistant shouldn't expose raw conversation-file import/export. The underlying functions (`history-ui.js`'s `exportActiveConversation`/`triggerImport`) are untouched. |
| Account/profile card (sidebar) + `#auth-status` feedback line (main column) + Settings "Account" section | Visible | Hidden | LinguaHub's own shell owns the signed-in session - no duplicate Google sign-in button, profile card, or "Sign-in is unavailable" status text (see [shared-auth-contract.md](./shared-auth-contract.md)). |
| Mode selector (`#mode-select`) | Visible | Hidden | A single automatic/general experience for students, not an exposed Codex/Cyber/Deep-Thinking picker. `lib/aiModes.js`'s registry is unchanged; `modeSelect.value` still resolves to `"general"` while hidden. |
| Sidebar collapsed state on first load | Expanded | Collapsed (icon rail) | Task 12 - a narrow embedded panel (~420-480px) shouldn't default to a persistent 272px history rail. Reuses the existing, already-tested collapse mechanism; an explicit user toggle (either mode) is always remembered afterward. |
| Everything else (streaming, history, search, New Chat, Stop/Edit/Regenerate/Retry, Markdown, themes, responsive behavior, accessibility) | Unchanged | Unchanged | Not named by any task as needing to change. |

All hiding is **`display: none` via CSS, never DOM removal**. This isn't
a style preference - `www/app.js` has several unconditional, top-level
`elementRef.addEventListener(...)` calls (e.g. `#login-btn`,
`#logout-btn`) that would throw if that element didn't exist in the DOM at
all. CSS-hiding satisfies "hidden in embedded, not globally deleted"
(the Task 2 product decision) both as a product requirement and as a
structural necessity of the current architecture.

## What was deliberately NOT hidden in embedded mode

- **Conversation history / search / New Chat.** These aren't "duplicate
  global navigation" - LinguaHub's own page navigation is about lessons/
  tests/modules, not the assistant's own chat history, which is the
  assistant's *own* memory (the same way a ChatGPT-style panel keeps its
  own history sidebar even when embedded in a larger product). Nothing in
  Tasks 1-13 names this as something to hide, only to make non-dependent
  on full standalone width (see the sidebar-collapse-by-default row
  above).
- **Theme toggle / Settings button.** Still real, non-conflicting,
  genuinely useful controls for the assistant panel itself.

If a real integration later decides either of these should also be
hidden or simplified, the same `[data-app-mode="embedded"]` /
`window.LinguaHubAppMode` mechanism is the place to add it - no new
abstraction needed.

## Panel-size readiness (Task 12)

Verified, not rebuilt: the existing responsive breakpoints already reach
down to 360px, and the mobile off-canvas sidebar drawer already engages
under `max-width: 768px` - both already covered by
`e2e/responsive.js` (real-browser screenshots + overflow checks at every
required width). A genuine `<iframe>` embed at 420-480px gets this
behavior automatically, because an iframe has its own real viewport that
CSS media queries measure directly.

**What is explicitly NOT solved here:** a *non-iframe* embed (LinguaHub
rendering this assistant's content directly inside a narrow column of a
wide page) would not automatically get the mobile-width CSS, because
`@media` queries respond to the page's viewport width, not a container's
width - the panel could be narrow while the browser window is wide. This
would need either CSS Container Queries or a LinguaHub-supplied width
class in a future phase. This is a known, explicitly-deferred decision -
see [integration-checklist.md](./integration-checklist.md) - not
something this phase's "do not convert the app into the panel now"
instruction permits solving today.

## Testing

- `tests/app-mode.test.js` - pure resolver tests (mode defaults, every
  per-feature override, non-boolean values ignored).
- `tests/settings-ui.test.js` - Settings dialog renders/hides Export/
  Import/Account rows correctly per mode.
- `tests/history-ui.test.js` - sidebar collapse-by-default behavior per
  mode, and that an explicit user choice always wins over the mode
  default.
- `tests/integration-prep.test.js` - source-level checks (script load
  order, CSS rules exist and are correctly scoped, hidden elements stay in
  the DOM).
- Real-browser verification: see the Integration Prep final report's
  "Browser verification" section for embedded-preview screenshots.
