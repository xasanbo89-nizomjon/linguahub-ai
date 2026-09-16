# Phase 5 — Advanced Chat Experience

Date: 2026-08-06

## 1. Audit (pre-phase state)

A repo-wide search confirmed, before writing any code: no Markdown rendering existed anywhere (`.textContent` only, both roles identical); no `marked`/`markdown-it`/`DOMPurify`/`highlight.js`/`Prism` dependency existed; no code-block treatment existed (plain text, no language label, no highlighting, no copy button); `AbortController`-based Stop already existed (Phase 4) but only as a generic "cancel whatever's running" primitive, not wired to any per-message action; no edit/regenerate/retry existed at all; the typing state was a text-only status line ("LinguaHub AI is thinking..."), not a dedicated indicator element. Critically: `server.js`'s `handleChat`/`handleChatStream` build the OpenAI `messages` array as exactly `[{role:"system",...}, {role:"user", content: parsed.message}]` — **no prior conversation turns are ever sent**. This one fact drove several design decisions below (see §12).

## 2. Markdown

`www/markdown.js` wraps `marked` (parsing) configured with a custom fenced-code renderer, immediately followed by `DOMPurify.sanitize()` as the actual security boundary (marked's raw output is never trusted or inserted on its own). Supported: paragraphs, headings (h1-h6), unordered/ordered lists, tables, blockquotes, links, inline code, fenced code blocks, horizontal rules, line breaks (`breaks: true`). If `marked.parse()` throws, the source text is preserved as escaped, readable plain text (`<p>` + `<br>`) rather than losing the message - verified by test with a real parser failure. **User messages are never run through this pipeline** - unchanged from every prior phase, plain `textContent` only, exactly matching "user messages remain plain text unless existing architecture intentionally supports Markdown" (it doesn't, so it stays plain).

## 3. Security and sanitization

DOMPurify runs with an explicit allow-list (`ALLOWED_TAGS`/`ALLOWED_ATTR`), `FORBID_TAGS` for `script/style/iframe/object/embed/form/input/textarea/svg/math`, `FORBID_ATTR` for `style/onerror/onload/onclick`, and an `afterSanitizeAttributes` hook that forces `target="_blank" rel="noopener noreferrer"` onto every link. Verified against a real adversarial battery (via genuine jsdom + the actual vendored libraries, not a simulation): `<script>` removed entirely; `onerror`/event-handler attributes stripped; `javascript:` URLs (including mixed-case and whitespace-padded variants) neutralized; `<iframe>`, `<object>`, `<embed>`, `<form>`/`<input>` all removed; inline `style` attributes (a common CSS-based XSS vector) stripped. All 12 adversarial cases and the full markdown test suite (26 tests) pass. No code is ever executed - highlighting and rendering only ever produce escaped text wrapped in `<span>`/structural tags.

## 4. Code blocks

Fenced code blocks render as `.code-block` (language label + Copy button in a header, `<pre><code dir="ltr">` body). Syntax highlighting is a small **hand-rolled, dependency-free** tokenizer (`highlightCode()` in `www/markdown.js`) covering keywords/strings/comments/numbers for JavaScript/TypeScript, Python, Bash, SQL, JSON, CSS, Java (with common aliases like `js`/`ts`/`py`/`sh` normalized). This was a deliberate choice, not an oversight: `highlight.js`/Prism ship as either a full bundle (large) or as CommonJS modules requiring a bundler to assemble a language subset - this project has no bundler and the phase's own rule against adding a large dependency without justification pointed toward a minimal, self-contained alternative instead of forcing a build step into an otherwise build-free frontend. Unrecognized languages fall back to plain (still HTML-escaped) text - never raw/unescaped output. Code always renders `dir="ltr"` regardless of surrounding RTL content, horizontal overflow is contained (`overflow-x: auto` on `.code-block pre`, verified by source test), and raw code text round-trips exactly through the highlighter (verified: extracting `.textContent` from real rendered+highlighted HTML reproduces the original source byte-for-byte).

## 5. Copy actions

One delegated click listener on `#chat-box` (see §16) handles: message-level copy (user or assistant - copies `wrapper.rawText`, the literal source text, never the rendered HTML or a hidden label) and code-block copy (copies `codeElement.textContent`, i.e. the raw code only, never the highlighting markup). Both use the Clipboard API with a toast-based success/error result via `www/toast.js`; code-copy also gives brief inline "Copied" button-text feedback. No secrets are ever in scope to copy - copy buttons only ever read from `wrapper.rawText`/`.message-content`/`.code-block code`, never from anything token/auth-related.

## 6. Stop generation

Reused, not reimplemented: the exact `activeChatAbortController`/`abortActiveGeneration()` mechanism already verified in Phases 1-4 (frontend `AbortController` → `fetch(..., {signal})` → connection drop → backend's own `res.on("close")`-driven `AbortController` cancels the upstream OpenAI request - see `server.js`, unchanged in this phase). New in this phase: the Send button visibly becomes a **Stop** button while generating (added in Phase 4) and clicking it now correctly triggers the full status/persistence pipeline via the shared `generateAssistantReply()` (see §9) - the partial response is preserved, marked `status:"stopped"`, gets its own authoritative Markdown render, and is never treated as an error (no error toast on intentional stop - verified by test in `tests/streaming-persistence.test.js`, unchanged assertion from Phase 3, still passing). Logout/delete/clear/switch-conversation all still abort generation the same way (Phase 3/4 behavior, unchanged, all 197 tests including those specific ones still pass).

## 7. Typing indicator

A small three-dot bounce (`.typing-indicator`, `role="status"`, `aria-label="LinguaHub AI is generating a response"`) is shown the instant the assistant placeholder bubble is created, and is replaced by the first real token the moment it arrives (`streamChat`'s delta handler clears it via `if (!receivedAny) contentEl.textContent = ""` before appending) - verified by test. It never re-appears after that point in the same generation, and a page refresh never shows one (restored messages always carry a final status, never "streaming" - chatStore already normalizes stale streaming to stopped on read, from Phase 3). Reduced-motion is respected globally (Phase 4's `prefers-reduced-motion` rule already collapses the bounce animation). No per-token animation exists anywhere - the indicator itself doesn't animate per-token, it animates on its own fixed 1.2s loop only while visible.

## 8. Edit prompt

**Chosen behavior (Task 8, option matching the task's own "preferred for this architecture" description): replace the selected user message, and after explicit confirmation remove every message after it, then send the edited text as a new turn.** Implementation: clicking Edit on a user message swaps its content for an inline `<textarea>` preloaded with the original text (`maxlength` enforced at 8000, matching the backend's default `MAX_MESSAGE_LENGTH`); Escape cancels with zero side effects (verified: original message unchanged, edit UI torn down); Enter (respecting the existing Enter-to-send setting) or a Save button confirms; an empty/whitespace-only value is rejected with an inline error and the edit stays open (verified); if any messages exist after the edited one, `LinguaHubDialog.confirm(...)` asks before truncating - declining leaves the conversation byte-for-byte untouched (verified: message array serialized before/after is identical). On confirm, `chatStore.replaceMessages()` truncates to everything **before** the edited message, the view re-renders from that point, and the edited text is sent through the exact same `sendMessage()` path as a brand-new message - no special-cased send logic to drift out of sync. **A real bug was found and fixed while writing these tests**: the very first version of this phase's `sendMessage()` never attached the newly-created user message's id to its DOM wrapper, so Edit silently did nothing on any user message (`dataset.messageId` was `undefined`, so `handleEditUserMessage` returned immediately). Fixed by creating the message object before calling `addMessage()` instead of after, and passing its id through - see §19.

## 9. Regenerate

A single shared function, `generateAssistantReply(conversationId, userText, mode, assistantMessageId, aiBubble)`, is now the **only** place that runs a generation into a bubble and persists the outcome - used identically by a brand-new send, Regenerate, and Retry, so none of the three can drift apart or double-implement the streaming/fallback/status logic. Regenerate: finds the user message immediately preceding the target assistant message in the stored array (`findUserPromptForAssistant`), aborts any active generation first, resets the **same** assistant message id back to a streaming placeholder (typing indicator shown again), and calls `generateAssistantReply` with that same id - the store's `saveMessage` is an upsert by id, so the result **replaces** the existing message rather than appending a new one (verified: message count stays at 2, id is unchanged, across a full regenerate cycle). The conversation's mode metadata is preserved and reused. If no corresponding user message can be found (a defensive case that shouldn't occur in normal use), a clear toast error is shown and nothing is attempted - no fake regeneration. Per Task 9's explicit "do not automatically regenerate multiple responses" - Regenerate only ever acts on the single message whose button was clicked.

## 10. Retry

Implemented as the exact same `handleRegenerateOrRetry` path as Regenerate (Task 10 and Task 9 describe functionally identical mechanics - replace the target assistant message using the same original prompt - differing only in *when* the button is offered). The only difference is which action button `buildMessageActions()` shows: **Retry** appears only when `status === "failed"`; **Regenerate** appears when `status` is `"complete"` or `"stopped"`; the two are mutually exclusive on any given message (verified by test). Retry does not duplicate the user message (it was never touched) and replaces the failed assistant message in place (verified: message count unchanged, same id, across a retry cycle where every request is made to fail).

## 11. Continue generation

**Not implemented - genuinely unavailable, not hidden or faked.** Confirmed by inspection (unchanged from Phase 1 through this phase): `server.js` sends OpenAI exactly one system message and one user message per request; it has no concept of "resume this partial assistant text" and no endpoint that accepts one. Per Task 11's explicit instruction ("Only implement if backend can receive: prior assistant partial response; conversation context; an explicit continue intent safely... If unsupported: do not show the control"), no Continue button exists anywhere in the UI, and none was added to the message-actions builder. Adding a "Continue" button that just resends a generic "continue" prompt (with no real context-carrying capability) would have been exactly the fake behavior the task explicitly prohibits.

## 12. Message statuses

Unchanged 4-state model from Phase 3 (`streaming`/`complete`/`stopped`/`failed`), now with full UI-affordance parity: `chatStore.sanitizeMessage` still unconditionally converts a restored `"streaming"` status to `"stopped"` on read (so a hard crash mid-token never leaves a message stuck "streaming" forever - unchanged, re-verified). `refreshMessageActions()` keeps the action buttons in sync with status transitions (streaming → complete/stopped/failed) without ever leaving stale buttons (e.g. a Retry button lingering on a message that just succeeded after Retry was clicked). Failed messages store only the same sanitized, secret-free error string already used since Phase 1 (`"❌ Error connecting to AI: ..."` built from a caught `Error.message`, never a raw provider error object or a stack trace) - unchanged. Stopped messages with zero accumulated text render `"(Stopped - no response received)"` instead of a blank bubble (new, small, real fix for a genuine edge case Task 16 calls out - "no blank assistant bubble").

## 13. Scroll behavior

`isNearBottom()` (Phase 4, unchanged) gates every auto-scroll decision: `addMessage()`, the streaming delta loop, and `renderConversationMessages()`'s restore-scroll all check it before forcibly scrolling, so a user who has scrolled up to read history is never yanked back down mid-stream - verified again in this phase's new scroll tests (button visibility toggling correctly based on `scrollTop`/`scrollHeight`/`clientHeight`, and click-to-bottom hiding the button and scrolling correctly). The scroll-to-bottom button appears exactly when the user is not near the bottom and disappears once they return there or click it. No change was needed to add explicit throttling to the `scroll` event listener itself in this phase - the handler is a cheap arithmetic comparison plus a `hidden` toggle with no DOM writes when the value doesn't change, well within a single frame budget even at native scroll-event frequency; a heavier component swap was judged unnecessary for a check this cheap.

## 14. RTL and multilingual

Per-message RTL detection (Phase 4's `RTL_PATTERN`, unchanged) still applies per-`.message-content`/composer, never globally. New in this phase: verified through the full Markdown pipeline specifically (not just plain text) - Arabic and mixed Arabic/English content renders correctly through `marked` + `DOMPurify` without corruption (verified by test); code blocks stay LTR unconditionally via `dir="ltr"` on `.lh-code`, independent of the surrounding message's direction (verified); Markdown tables are unaffected by RTL detection (it only ever touches the top-level content container's `dir` attribute, not table internals).

## 15. Performance

No full-conversation rerender per token (unchanged architecture: only the single active `.message-content` node is touched during streaming, via `textContent +=`). Markdown parsing/sanitization/highlighting now run **exactly once** per settled message (on stream completion, stop, or failure) - never during active streaming, and never repeated for a message that's already been rendered (restored-from-history messages render once on load, not once per re-render of the list). The delegated single click listener on `#chat-box` (§16) means the action-button count no longer creates new listeners as messages/actions are added, removed, or refreshed - a real, measurable reduction from the naive per-button-listener pattern Phase 4 originally used for the copy button. `AbortController` instances are always nulled out in `generateAssistantReply`'s `finally` block (unchanged); no new timers were introduced that aren't cleared (the "Copied" button-text reset `setTimeout` is a fire-and-forget 1.2s reset with no accumulation risk, matching the existing copy-feedback pattern from Phase 4).

## 16. Accessibility

Verified (source + DOM-integration tests): the typing indicator carries `role="status"`/`aria-label`; the new status label (`.message-status-label`) uses `role="status"`; all message actions have explicit `aria-label`s (not icon-only with no name - "Copy your message", "Copy response", "Edit message", "Retry this response", "Regenerate response"); the edit textarea has `aria-label="Edit your message"`; the edit-confirmation dialog reuses Phase 4's already-accessible `LinguaHubDialog` (focus trap, Escape, focus restoration - unchanged, re-verified this phase doesn't regress it). Per Task 18's explicit "do not announce every streamed token" - nothing here uses a live region during the token-by-token phase; only the initial typing-indicator and final status changes are ever announced. **Manual screen-reader and 200%-zoom testing were NOT performed** (no such tooling in this environment - same limitation carried from Phase 4).

## 17. CSP and dependencies

`marked` and `DOMPurify` are vendored as their official prebuilt browser bundles (`node_modules/marked/lib/marked.umd.js`, `node_modules/dompurify/dist/purify.min.js`) copied verbatim into `www/vendor/` and loaded via plain same-origin `<script src>` tags - **no CDN, no bundler, no `unsafe-eval`, and no CSP change was needed at all**: `script-src 'self' https://www.gstatic.com` (unchanged since Phase 2) already covers same-origin files. Both libraries are self-contained UMD builds with zero `require()` calls, confirmed before use. The custom syntax highlighter adds no dependency and no CSP surface whatsoever (pure string/regex logic). Verified live: `curl -i /health` shows the CSP header byte-for-byte unchanged from the end of Phase 4. Verified: the app - including the new vendor scripts - still loads correctly through the real static server active on port 5500 in this environment (Live Server compatibility), and Electron/Capacitor were not touched by this phase (no code path here depends on the frontend's origin/protocol).

## 18. Bugs found

1. **Edit silently did nothing** (Task 8's action was unreachable) - `sendMessage()` never attached the newly-created user message's id to its DOM wrapper. Caught by `tests/app-actions.test.js`, not by manual inspection.
2. A pre-existing (Phase 3) test-timing margin in `tests/streaming-persistence.test.js`'s abort test was tight enough to flake under load (~1 in 3 runs failed a raw `setTimeout`-based race). Not a product bug - the underlying abort behavior itself was always correct; only the test's timing assumption was fragile.
3. Two fake-DOM test-harness gaps in the newly-created shared `tests/helpers/fakeDom.js`: `matchesSelector` checked only `classList` (a separate `Set`) while production code (`www/app.js`, `www/history-ui.js`) sets `.className` as a plain string - the two were never kept in sync, so `querySelector`/`closest` against class selectors silently failed; and `.textContent = ...` didn't clear `.children` the way real DOM does, so a previously-appended typing-indicator element survived being "replaced" by text. Both are test-infrastructure bugs, not application bugs - real browsers keep `className`/`classList` and `textContent`/children in sync automatically.

## 19. Bugs fixed

All four items in §18: (1) fixed in `www/app.js`'s `sendMessage()` by creating the user `Message` object before calling `addMessage()` and passing its `id` through as `messageId`; (2) fixed by widening the test's timing margin (`chunkDelayMs: 2`, wait `150ms`), stable across 5 repeated runs afterward; (3) fixed in `tests/helpers/fakeDom.js` by making `hasClass()` check both the `classList` Set and the `className` string, and by making `textContent` a real getter/setter pair that clears `children` on assignment, matching actual DOM semantics.

## 20. Files modified

| File | Reason | Change type |
|---|---|---|
| `www/app.js` | Message actions (copy/edit/regenerate/retry), shared `generateAssistantReply`, authoritative Markdown render on settle, typing indicator, event delegation for all message/code-block buttons, per-message status labels, the Edit-id bug fix | Substantial addition + one real bug fix; existing send/stream/fallback/auth logic preserved, restructured into a shared function rather than rewritten |
| `www/index.html` | Load the vendored Markdown/sanitizer scripts | Two new `<script src="vendor/...">` tags + `markdown.js`, added in the correct load order before `app.js` |
| `www/styles.css` | Code blocks, Markdown content typography, inline edit-mode textarea, typing indicator, status labels | Additive CSS only, using existing design tokens (Phase 4) |
| `server.js` | CSP comment updated to reference this phase's doc | Comment-only; no directive changed (verified live - identical header) |
| `tests/frontend-auth.test.js`, `tests/streaming-persistence.test.js` | New `addMessage()` signature (`dataset`, `.dataset.role`, richer DOM needs) and event-bubbling requirements | Switched to the new shared `tests/helpers/fakeDom.js` fixture instead of a local one; added `navigator.clipboard`/`document.body` |

## 21. Files created

`www/markdown.js` (Markdown render/sanitize/highlight pipeline), `www/vendor/marked.umd.js` + `.map`, `www/vendor/purify.min.js` + `.map` (vendored dependencies), `tests/markdown.test.js` (26 tests, real jsdom), `tests/app-actions.test.js` (12 tests, copy/edit/regenerate/retry/typing/scroll), `tests/helpers/fakeDom.js` (shared fake-DOM test fixture), `docs/phase-05-chat-experience.md` (this document).

No README exists in this repository to update (confirmed - none present, consistent with every prior phase).

## 22. Tests and commands

```
npm install marked dompurify
npm install --save-dev jsdom
cp node_modules/marked/lib/marked.umd.js www/vendor/marked.umd.js (+ .map)
cp node_modules/dompurify/dist/purify.min.js www/vendor/purify.min.js (+ .map)
node --check www/app.js www/markdown.js server.js
node -e "... jsdom smoke test of markdown.js against real marked/DOMPurify with adversarial XSS payloads ..."
node --test                                    # full suite, all phases
node server.js                                 # background, live verification
curl -s -i http://127.0.0.1:3000/health         # CSP header check
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/{vendor/marked.umd.js,vendor/purify.min.js,markdown.js}
curl -s -N --max-time 25 -X POST http://127.0.0.1:3000/api/chat/stream ...   # real OpenAI call
curl -s -i --max-time 2 http://127.0.0.1:5500/api/chat/stream               # port-5500 isolation
curl -s http://127.0.0.1:5500/AI-chat-app/www/index.html | grep -E "vendor/marked|vendor/purify|markdown.js"  # through the real static server on 5500
```

## 23. Test results

**197/197 automated tests passed, 0 failed** (159 carried forward from Phases 1-4 + 26 new `markdown.test.js` + 12 new `app-actions.test.js`). All live checks passed, including one real OpenAI streaming call made after every Phase 5 change and a live CSP header comparison confirming zero drift from Phase 4.

## 24. Regression status

405 fix, port 3000 routing, auth, history/isolation, import/export, themes/responsive UI, dialogs, toasts, CORS, and Helmet/CSP were all re-verified (automated + live) and remain intact - no Phase 1-4 test needed to change its expected behavior in this phase (only its test *fixture*/DOM-simulation needed upgrading, covered in §18-19).

## 25. Remaining issues

- No real browser/visual verification was possible in this environment (unchanged limitation from Phase 4) - Markdown/code-block/edit/regenerate rendering is verified via real jsdom + real vendored libraries + DOM-integration tests, but never actually seen rendered in an actual browser window.
- No manual screen-reader testing was performed.
- Continue Generation is genuinely absent, not merely hidden - a real capability gap in the current backend, not a UI oversight (§11).
- The custom syntax highlighter covers 8 common languages/aliases; anything else falls back to unhighlighted (but still safe, still readable) plain text - a deliberate scope boundary, not a bug.
- No real Firebase project is configured (unchanged from Phases 2-4) - auth-gated flows in this phase (e.g. attaching a token to a regenerate/retry request) reuse the exact same `buildAuthHeaders()` already covered by Phase 2's tests, but were not exercised against a live Firebase session.

## 26. Rollback notes

Every change is a source-level edit or an additive new file; `marked`/`dompurify` were added via `npm install --save` (their Node/CJS builds are unused by `server.js` - only the prebuilt browser files under `www/vendor/` are actually served) and `jsdom` via `npm install --save-dev` (test-only, never shipped). To roll back: revert the four modified files (§20), delete the seven created files/vendor-pairs (§21), and optionally `npm uninstall marked dompurify jsdom`. No database, no migration, no server-side behavior change beyond a comment. No git commit was created.
