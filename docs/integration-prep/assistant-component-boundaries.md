# Assistant component boundaries

## Scope of this document

Identifies which pieces of the current plain-JavaScript frontend are
already reusable for a future embedded assistant, and which are tightly
coupled to the standalone page's DOM structure. **Nothing was rewritten
into a component framework** - this project is plain JS/HTML/CSS today,
and stays that way this phase. Where a piece is DOM-coupled, this
document says so plainly rather than pretending otherwise.

## Reusable as-is (pure, no DOM dependency)

These already work identically whether the page around them is the
standalone shell or a future embedded panel, because they never touch
`document` at all:

| Module | What it owns |
|---|---|
| `www/chatStore.js` | Conversation CRUD, persistence, namespacing (guest vs `user:<uid>`), import/export JSON shape, storage limits |
| `www/config.js` | API base URL resolution |
| `www/app-mode.js` | `standalone`/`embedded` resolution (new this phase) |
| `www/strings.js` | Centralized copy (new this phase) |
| `www/context-adapter.js`'s `validate`/`isEmptyContext`/`formatChipLabel` | Page-context validation (new this phase) |
| `www/mode-ui.js`'s `getPromptSuggestions`/`isSelectableMode` | Mode-related pure logic (option-building/fetching are DOM/network, but these two are pure) |

A future integration that wants its own UI (Option A in
[existing-linguahub-chat-handoff.md](./existing-linguahub-chat-handoff.md))
can use these directly, today, with zero changes.

## DOM-coupled, but ID-driven (reusable if the host provides matching structure)

These modules exclusively use `document.getElementById(...)` against
fixed IDs from `index.html` - they don't require the *page* to be this
project's own `index.html`, only that a host page provides elements with
the same IDs in roughly the same relationships. `www/history-ui.js`
already null-guards every element lookup it makes (`if (newChatBtn)
newChatBtn.addEventListener(...)`) - it does not crash if the sidebar-only
elements are absent, which is exactly what made CSS-hiding (rather than
DOM removal) safe for embedded mode this phase.

| Module | DOM dependency |
|---|---|
| `www/history-ui.js` | `#sidebar`, `#conversation-list`, `#new-chat-btn`, etc. - all null-guarded |
| `www/settings-ui.js` | Builds its own dialog DOM; reads `#logout-btn` for delegation |
| `www/theme.js` | `document.documentElement`, `<html data-theme>` |
| `www/toast.js` | Creates/appends its own toast region |
| `www/dialog.js` | Creates/appends its own dialog backdrop |
| `www/markdown.js` | Pure string → sanitized HTML string; no DOM dependency at all beyond what the caller does with the result |

## Tightly DOM-coupled (would need extraction to reuse without this project's exact page)

`www/app.js` owns the actual message-send/stream/edit/regenerate/retry
pipeline, and it is **not** decoupled from the DOM this phase - `sendMessage()`,
`generateAssistantReply()`, `handleRegenerateOrRetry()`,
`handleEditUserMessage()` all read/write real message-wrapper elements
directly (e.g. a message's `.contentEl` property, attached at creation
time in `addMessage()`).

**This was evaluated and deliberately not refactored.** Per this phase's
own constraints ("do not rebuild the project... refactor only if a
tightly coupled DOM dependency truly blocks reuse"):

- For **Option B** (LinguaHub's existing chat route renders this
  project's own components/page structure - see
  [existing-linguahub-chat-handoff.md](./existing-linguahub-chat-handoff.md)),
  this coupling does **not** block reuse at all - the same HTML structure
  embedded means the same DOM coupling works identically.
- For **Option A** (LinguaHub's existing UI calls a decoupled "engine"
  directly, with no shared DOM), this coupling **would** block reuse -
  `sendMessage()` and friends would need to be extracted into functions
  that take/return data instead of touching specific DOM elements.

That extraction is real, non-trivial work (the core of `app.js`'s
message-rendering pipeline), and is exactly the kind of "rebuild" this
phase was told not to do speculatively. It is correctly deferred to
whichever future phase actually picks Option A - see
[integration-checklist.md](./integration-checklist.md).

## The requested reusable-surface list, mapped to reality

| Requested area | Current home | Reusable today? |
|---|---|---|
| Assistant header | `index.html`'s `.header` + `#conversation-title`/`#status`/`#context-chip` | Yes, as markup - not a JS component, but the IDs `app.js` populates are stable and documented |
| LH identity | `.lh-mark` CSS component (Phase 14) | Yes - a pure CSS class, usable anywhere |
| Context chip | `#context-chip`/`#context-chip-text` + `www/context-adapter.js` | Yes - see [context-adapter-contract.md](./context-adapter-contract.md) |
| Message list | `#chat-box` + `app.js`'s `addMessage()`/`renderConversationMessages()` | DOM-coupled (see above) |
| User message / assistant message | `app.js`'s `addMessage()` | DOM-coupled |
| Message actions (copy/edit/regenerate/retry) | `app.js`'s `buildMessageActions()`/delegated `#chat-box` click handler | DOM-coupled |
| Typing state | `app.js`'s `showTypingIndicator()` | DOM-coupled |
| Stop state | `app.js`'s `setBusy()`/`abortActiveGeneration()` | DOM-coupled (element toggles), but the abort logic itself (`AbortController`) is standard and portable |
| Error state | `app.js`'s `.error` class + `message-status-label` | DOM-coupled |
| Composer | `index.html`'s `.composer` + `app.js`'s keydown/auto-resize handlers | DOM-coupled |
| Toast/status hooks | `www/toast.js` (`LinguaHubToast.show(...)`) | Yes - a self-contained, already-portable module |
| Conversation state/service | `www/chatStore.js` | Yes - pure, see table above |
| Streaming client | `app.js`'s `streamChat()`/`fallbackChat()` | Partially DOM-coupled (writes directly into `aiBubble.contentEl`) - the `fetch`/SSE-parsing logic itself is portable, the DOM-writing isn't |
| Markdown renderer | `www/markdown.js` | Yes - pure, see table above |

## Bottom line

A future integration does not need to choose "rewrite everything" vs.
"can't reuse anything." The pure/portable pieces (storage, config, mode
logic, markdown, toasts, the two new adapters) are ready today. The
DOM-coupled UI pieces are ready today **for Option B** (embed this
project's own markup/JS) and would need a scoped extraction effort **only
if** Option A is chosen - a decision this phase correctly leaves to
whoever audits the real LinguaHub repository next.
