# Phase 3 — Chat History and Conversation System

Date: 2026-08-06

## 1. Existing-state audit

A repo-wide search (`localStorage`, `sessionStorage`, `conversation`, `chat-history`, `currentChat`, `sidebar`, `regenerate`, `retry`, `edit prompt`, `new chat`, `delete chat`, `rename chat`, etc.) turned up nothing beyond a single explanatory comment in `www/auth.js`. Confirmed before writing any code:

1. **Message state:** in-memory only - each message is a DOM node appended to `#chat-box`. No JS object graph mirrors it.
2. **Conversation state:** none - there is exactly one implicit "conversation" per page load.
3. **LocalStorage keys:** none exist anywhere in the app, old or new.
4. **Guest/user separation:** Phase 2 added verified Firebase identity, but nothing in storage used it yet.
5. **New-chat behavior:** no control existed.
6. **Restore behavior:** none - a refresh loses everything.
7. **Sidebar/list:** none existed.
8. **Data-loss risk:** total, on every refresh.
9. **Corruption risk:** N/A (nothing was persisted to corrupt).
10. **Cross-account leakage risk:** N/A yet, but the design in this phase had to prevent it going forward.
11. **Duplicate-chat risk:** N/A yet, same reason.

This phase is therefore fully additive - the same situation as Phase 1 and Phase 2 encountered.

## 2. Conversation architecture

### Schema (`www/chatStore.js`)

```
Conversation {
  id, title, createdAt, updatedAt, messages[], pinned, archived,
  autoTitle,      // false once manually renamed - guards auto-title from overwriting it
  metadata: { mode }
}
Message {
  id, role: "user"|"assistant"|"system", content, createdAt,
  status: "complete"|"streaming"|"stopped"|"failed"
}
```

Everything that ever enters this schema - fresh writes, legacy migration, or imported JSON - passes through `sanitizeConversation`/`sanitizeMessage`, which: coerce unknown/missing fields to safe defaults, drop anything not shaped like a plain object, cap string lengths, and **always** convert a restored `status: "streaming"` to `"stopped"` (nothing can genuinely be mid-stream immediately after a fresh read from storage). No token, key, or backend configuration field exists anywhere in the schema.

### Repository (`www/chatStore.js`, `createChatStore(options)`)

A factory, not a global singleton, so it can be pointed at any storage-like backend (`getItem`/`setItem`/`removeItem`/`key`/`length`) - real `localStorage` in the browser, an in-memory fake in tests. Every UI file (`www/history-ui.js`, `www/app.js`) calls through this repository; **neither touches `localStorage` directly**. Methods: `listConversations`, `getConversation`, `createConversation`, `updateConversation`, `renameConversation`, `deleteConversation`, `clearConversationMessages`, `saveMessage`, `replaceMessages`, `searchConversations`, `exportConversationJson`/`exportConversationMarkdown`, `importConversationJson`, `migrateLegacyData`, plus namespace controls (`setUserId`/`getNamespace`).

Every method returns a plain `{ ok, ... }` result object (never throws for expected failure modes like "not found" or "quota exceeded"). This shape was chosen deliberately so a **future PostgreSQL-backed implementation could return the exact same shape from an `async` function with no call-site changes** - see §23-equivalent "Future PostgreSQL migration contract" below.

## 3. Storage namespaces

```
linguahub-ai:chat-history:v1:guest
linguahub-ai:chat-history:v1:user:<uid>
```

- `uid` always comes from `LinguaHubAuth.getCurrentUser().uid` (a **verified** Firebase session - see Phase 2), passed into `historyUI.setUser(user)` from `app.js`'s single existing `onAuthStateChanged` subscription. Nothing in the UI accepts a uid from a form field, URL, or any other untrusted input.
- The uid is additionally sanitized (`[^a-zA-Z0-9_-]` stripped) before being used to build the storage key, so even a corrupted/unexpected value can't be used to construct an unintended key.
- Logging out calls `historyUI.setUser(null)`, which switches back to `guest` and re-renders from that namespace - verified by test.
- A corrupted JSON blob in one namespace is caught and reset to empty **for that namespace only**; it cannot affect any other namespace (verified by test).
- **Legacy migration:** `migrateLegacyData()` scans `localStorage` for any key matching `/xasan|hasan/i` (outside this app's own key prefix), and safely normalizes anything it finds into the **guest** namespace (there is no verified uid associated with pre-auth data, so guest is the only honest destination). It records a one-time completion flag (`linguahub-ai:chat-history:legacy-migration-complete`) so it never re-runs or duplicates data on subsequent loads. **In this codebase's actual history, no such keys have ever existed** (confirmed in the Phase 1 and Phase 2 audits - the pre-rename app never wrote to `localStorage` at all), so in practice this is a no-op every time it runs here. It is real, tested code (with synthetic legacy-shaped data in `tests/chatStore.test.js`), kept as defensive forward-compatibility rather than removed, and documented honestly as currently inert.

## 4. Features implemented

- **New Chat:** creates a conversation, or reuses the current one if it's already empty and auto-titled - rapid clicks never spawn duplicates (tested).
- **Restore after refresh:** the active conversation, its messages, title, timestamps, and mode are all restored; any message frozen mid-stream by a crash is shown as `stopped`, never permanently `streaming` (tested).
- **Conversation list (sidebar):** title, relative "updated" time, active highlight, pinned-first sort, rename/delete actions, search box, New Chat, Export/Import.
- **Auto title:** derived from the first user message (Markdown noise and excess whitespace stripped, Unicode-safe truncation to 60 characters), and never overwrites a manual rename (tested, including Arabic/Unicode titles).
- **Rename:** `window.prompt` pre-filled with the current title - natively gives Enter-confirms/Escape-cancels/keyboard-accessible for free, with no new modal component to build or get wrong. Empty/whitespace-only titles are rejected.
- **Delete:** `window.confirm`, aborts an in-flight generation if the active conversation is being deleted, selects a fallback conversation afterward, only ever touches the current namespace.
- **Clear current conversation:** separate from delete - empties the active conversation's messages and resets its title, leaves every other conversation untouched, also confirmed and abort-safe.
- **Search:** case-insensitive, Unicode-safe (tested with Arabic and Russian), matches title and message content via plain substring `.includes()` (no `RegExp` built from user input, so no ReDoS/injection surface), debounced 200ms, empty query restores the full list.
- **Export:** current conversation only (the only thing the UI genuinely offers, per the task's "export all only if UI supports it honestly") as JSON (versioned, re-importable) or Markdown, via a `Blob` + `URL.createObjectURL` download with the object URL revoked immediately after.
- **Import:** file-picker only (no drag-and-drop, since none existed to extend), size-capped, JSON-parsed in a `try/catch`, schema-validated, **always** assigned a brand-new id (never trusts an imported id - this is also how collisions are avoided and how a malicious import is prevented from silently overwriting an existing conversation), added as a new entry rather than replacing anything.

## 5. Bugs found

None in the pre-existing code (there was no chat-history code to have bugs). Two bugs were introduced and caught by this phase's own tests before being considered done - see §7.

## 6. Bugs fixed (introduced by this phase, caught before completion)

1. **Eviction tie-break bug in `pruneForSize`:** when several conversations shared the same `updatedAt` millisecond (routine in fast/programmatic usage, and plausible for a user who fires off several messages within the same second), sort stability combined with the newest-first (`unshift`-based) array order caused the *newest* of a tied group to be evicted instead of the oldest. Fixed by adding an explicit index-based tiebreaker. Caught by `tests/chatStore.test.js`'s quota-pruning test.
2. **Callback-ordering bug in `history-ui.js`'s `init()`:** the first restore notification fired before `app.js` had a chance to register its `onActiveConversationChanged` handler, so the very first conversation would never actually render on page load. Fixed by splitting `init()` (wires DOM listeners, returns the control object) from a separate `start()` (performs migration + the first restore) that the caller invokes only after registering its callbacks. Caught while writing the integration wiring, before any test was run against it.

## 7. Files modified

| File | Reason | Change type |
|---|---|---|
| `www/index.html` | Add the conversation sidebar (New Chat, search, list, export/import, clear-chat) | New markup (`#app-shell`, `#sidebar`, list/search/footer elements) and matching CSS (desktop column + mobile off-canvas drawer via a `max-width: 760px` media query); added `<script src="chatStore.js">` and `<script src="history-ui.js">` before `app.js`. No existing element removed or renamed. |
| `www/app.js` | Wire sending/streaming to persistence and restoration | Added `historyUI = window.LinguaHubHistoryUI.init()` plus `onActiveConversationChanged`/`registerAbortActiveGeneration`/`start()` wiring; `sendMessage`/`streamChat` now save the user message immediately, save an assistant placeholder, throttle-save during streaming, and flush a final complete/stopped/failed state; `handleLogout` now calls the same shared `abortActiveGeneration()` helper used by history actions (deduplicated, not reimplemented); the existing `onAuthStateChanged` callback now also calls `historyUI.setUser(user)` (one subscription, two effects - no duplicate listener). No existing fetch URL, CORS behavior, or auth-header logic changed. |
| `tests/frontend-auth.test.js` (Phase 2) | `app.js` now requires `window.LinguaHubHistoryUI`/`window.LinguaHubChatStore` at load time | Added a real-storage-backed fake `LinguaHubHistoryUI` (using the genuine `chatStore.js`, not reimplemented logic) and `LinguaHubChatStore` to the existing vm sandbox; added a `mode-select.options` stub since `app.js` now reads it. No test assertions changed. |

## 8. Files created

| File | Purpose |
|---|---|
| `www/chatStore.js` | The repository/schema/namespacing/migration/limits layer (§2-§3). Pure logic, no DOM - directly `require`-able in Node tests. |
| `www/history-ui.js` | Sidebar DOM wiring: list rendering, New Chat, search, rename, delete, clear, export, import, mobile drawer toggle. |
| `tests/chatStore.test.js` | 38 tests covering CRUD, namespacing/isolation, legacy migration, corruption recovery, quota handling, New Chat dedup, auto title, rename, delete fallback, sort order, search, export/import (including prototype-pollution and XSS-as-text-content cases). |
| `tests/history-ui.test.js` | 13 vm-based DOM-wiring tests: New Chat, dedup, selection, search, rename (confirm + cancel), delete (confirm + cancel), clear, export, import. |
| `tests/streaming-persistence.test.js` | 3 tests proving throttled (not per-token) writes during streaming, a correct final flush, and correct `stopped`-with-partial-content persistence on mid-stream abort - through the real `app.js` source, not a reimplementation. |
| `docs/phase-03-chat-history.md` | This document. |

No README existed to update (confirmed - none is present anywhere in the repo).

## 9. Data migration

Old keys targeted: any `localStorage` key matching `/xasan|hasan/i`. Behavior: parse, normalize (`{messages:[...]}` or a bare array of `{role,content}` - the only shapes a hand-rolled pre-history build could plausibly have used), land in the guest namespace, mark a completion flag so it never re-runs, **never delete the source key** (the migration only ever adds a completion flag; nothing is destructive). As stated in §3, no real data of this shape exists in this repository's history to migrate - this was verified with synthetic data in tests, not a real dataset.

## 10. Storage limits

| Limit | Value | Behavior when exceeded |
|---|---|---|
| Conversations per namespace | 100 | Oldest unpinned, non-active conversations pruned first |
| Messages per conversation | 500 | New messages beyond the cap are rejected (`{ok:false, reason:"message-limit-reached"}`), reported to the user via the history-status region |
| Message content length | 20,000 chars | Truncated (grapheme-safe) on write, not rejected |
| Title length | 80 chars (stored) / 60 chars (auto-generated) | Truncated |
| Import file size | 2 MB | Rejected before parsing |
| Namespace serialized size | ~4.5 MB (proactive) | Old unpinned conversations pruned before attempting the write |

On an actual `QuotaExceededError` from `localStorage.setItem`, the store prunes the oldest unpinned, non-active conversations and retries (bounded at 5 attempts - **never an infinite loop**); if nothing can be pruned (or pruning still isn't enough), the write fails with `{ok:false, reason:"quota-exceeded"}` and is surfaced honestly rather than silently dropped or crashing. The **active conversation is never evicted**. All of this is exercised by dedicated tests, including one that fails every write to prove the honest-failure path never loops.

## 11. Auth isolation

`www/history-ui.js` only ever calls `store.setUserId(user && user.uid ? user.uid : null)`, and that `user` object comes from exactly one place: the Firebase `onAuthStateChanged` callback Phase 2 already wired up, which itself only fires with a session Firebase's own SDK has validated. Nothing in `www/app.js`, `www/history-ui.js`, or `www/chatStore.js` reads a uid from a URL parameter, form field, cookie, or any other source a page visitor could manipulate. Because the storage **key itself** is namespaced by uid, user A's browser literally never issues a `localStorage.getItem`/`setItem` call against user B's key - there is no shared data structure to leak from, not just an access check that could be bypassed. Verified directly: `tests/chatStore.test.js` creates data as `user-a`, switches to `user-b`, and asserts the conversation is invisible and `getConversation` returns `null`.

## 12. Streaming integration

- **Start:** the assistant's placeholder message is saved immediately (`status: "streaming"`, empty content) so a stable id exists for subsequent updates.
- **In progress:** each delta updates the DOM immediately (unchanged from Phase 1) and calls a **throttled** (400ms) save of the accumulated text - proven by test to produce far fewer writes than one per delta.
- **Complete:** a `finally` block always flushes the throttle and performs one last save with `status: "complete"` and the full text, whether the stream finished cleanly or fell back to the non-streaming endpoint.
- **Stopped:** an `AbortError` (from logout, delete-of-active-conversation, clear-current-conversation, or switching to a different conversation while generating) saves whatever partial text had accumulated with `status: "stopped"` - never left as `"streaming"`.
- **Failed:** if both the streaming and non-streaming fallback requests fail, the displayed error text is saved with `status: "failed"` so the same error reappears on restore instead of silently vanishing.
- **On any fresh read from storage** (page load, conversation switch), `sanitizeMessage` unconditionally converts a stored `"streaming"` status to `"stopped"` - this is what protects against a hard crash (tab closed mid-token) leaving a message stuck as "streaming" forever.

## 13. Import/export security

- Export excludes the Firebase ID token, any API key, server configuration, and internal permissions by construction - the export payload is built from exactly `{title, createdAt, updatedAt, metadata, messages:[{role,content,createdAt,status}]}`, nothing else is ever included. Verified by test: the exported JSON is scanned for OpenAI-key-shaped strings and `Bearer|idToken|accessToken|apiKey` patterns.
- Import always mints a fresh id (§4) - by construction this also prevents any imported id from colliding with, and overwriting, an existing conversation (verified by test, including deliberately supplying a colliding id).
- Malformed JSON, oversized files, and non-conforming shapes all fail with a reported reason, never a thrown/uncaught error (verified).
- Imported message `content` is always treated as plain text through the same `textContent`-only rendering path every other message uses (never `innerHTML`) - an imported `<img src=x onerror=...>` string round-trips as inert text, verified directly at the storage layer and structurally true at the render layer (`www/app.js`'s `addMessage` has always used `textContent`).
- `__proto__`-shaped keys in imported JSON are ignored because sanitization only ever reads a fixed, explicit set of known property names off the parsed object - it never does `Object.assign(target, untrustedObject)` or assigns using an attacker-controlled key. Verified by a test that attempts exactly this and asserts `Object.prototype` is untouched afterward.

## 14. Performance

- Streaming writes are throttled (400ms), not per-token - the single largest potential performance/IO issue for this feature, verified by test (§12).
- The sidebar list is rebuilt (not diffed) on each change, but conversation counts are capped at 100 and each render is a handful of DOM nodes per item - not a concern at this scale, and simpler/more correct than hand-rolled diffing.
- Search is debounced 200ms; it never mutates stored data (read-only `.filter()` over the in-memory list).
- `historyUI.registerAbortActiveGeneration` gives every history action (delete/clear/switch/logout) one shared way to cancel an in-flight `AbortController` - no orphaned controllers, no duplicate abort logic.
- Object URLs from export are revoked immediately after the download click is dispatched.
- No new state-management framework, virtual DOM, or build step was introduced.

## 15. Accessibility

Source-level (implemented, not runtime-screen-reader-tested - see §19): the search input has an associated `<label class="sr-only">`; list items are real, tab-focusable elements (`role="option"`, `tabindex="0"`) that respond to Enter/Space as well as click; rename/delete/clear all use native `window.prompt`/`window.confirm`, which carry their own OS-level keyboard and screen-reader support; the sidebar toggle button has `aria-label`/`aria-expanded`/`aria-controls`; `#history-status` is `aria-live="polite"` for save/import/export outcomes, matching the pattern Phase 2 already established for `#auth-status`. **Manual screen-reader testing was not performed** - this environment has no screen reader or browser automation available (same limitation noted in Phase 2).

## 16. Tests and commands run

```
node --check www/chatStore.js www/history-ui.js www/app.js
node --test                              # full suite, all phases
node server.js                           # background, for live verification
curl -s -i http://127.0.0.1:3000/health
curl -s -N --max-time 25 -X POST http://127.0.0.1:3000/api/chat/stream -H "Origin: http://127.0.0.1:5500" -H "Content-Type: application/json" -d '{"message":"Reply with exactly the single word: OK"}'   # real OpenAI call
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/{chatStore.js,history-ui.js}
curl -s http://127.0.0.1:5500/AI-chat-app/www/index.html | grep -E "new-chat-btn|conversation-list|chatStore.js|history-ui.js"
curl -s -i --max-time 2 http://127.0.0.1:5500/api/chat/stream
curl -s -i http://127.0.0.1:3000/api/auth/me -H "Authorization: Bearer x"
netstat -ano (port 3000 / 5500 state checks, before and after starting the backend)
```

## 17. Test results

**100/100 automated tests passed, 0 failed** (46 Phase 1/2 regression + 38 `chatStore.test.js` + 13 `history-ui.test.js` + 3 `streaming-persistence.test.js`). All live checks in §16 passed, including one real OpenAI streaming call made after all Phase 3 changes.

## 18. Real verification vs. mocked vs. source-only

| Claim | Status |
|---|---|
| Storage CRUD, isolation, migration, quota, search, export/import logic | **Real** - real `chatStore.js` executed directly in Node against a real (fake, in-memory) `Storage`-shaped backend, not a reimplementation. |
| Sidebar DOM wiring (New Chat, select, rename, delete, clear, export, import, search) | **Real source, fake DOM** - the actual `history-ui.js` file executed via Node's `vm` module against a minimal hand-built DOM (no jsdom in this project) and native-dialog stubs (`prompt`/`confirm`). |
| Streaming persistence (throttling, flush, abort-to-stopped) | **Real source, fake network** - the actual `app.js` executed via `vm` against a fake `fetch` that emits real SSE-formatted chunks over real `setTimeout` delays, so the 400ms throttle is exercised with genuine wall-clock timing, not simulated. |
| Backend/CORS/Helmet/streaming/health | **Real** - a live `node server.js` process, hit with real HTTP requests, including one real OpenAI API call. |
| Interactive browser use (clicking through the actual sidebar in a real browser tab) | **NOT RUN** - no browser automation/GUI available in this environment (same limitation as Phase 1 and Phase 2). |
| Real multi-account browser login switching the visible sidebar | **NOT RUN** (no real Firebase project configured - Phase 2's limitation still applies); the uid-based namespace switch itself is verified at the source level with a mocked/synthetic uid, not a live Google login. |

## 19. Remaining issues

- No interactive/browser-level test of the sidebar was possible in this environment - everything above the storage layer is verified via `vm`-executed real source against fake DOM/network, not a live browser.
- Manual screen-reader testing was not performed (§15).
- Rename/delete/clear confirmations use native `window.prompt`/`window.confirm` rather than a custom-styled dialog - fully functional and accessible, but visually inconsistent with the rest of the dark theme; a themed dialog component is a reasonable Phase 4 polish item, not a defect.
- Search covers title and full message content (no separate "index" - it's a linear `.filter()` over up to 100 conversations / 500 messages each); documented as adequate at this scale rather than built out further, per the task's explicit permission to scope search this way.
- Storage remains LocalStorage-only, per-browser/per-device - no cross-device sync exists or is claimed to exist.
- All Phase 2 known-remaining issues (no real Firebase project configured, Capacitor Android OAuth needs a native plugin, `style-src 'unsafe-inline'` still present for the inline `<style>` block) are unchanged by this phase - none were in scope here and none were silently worsened.

## 20. Changed-file inventory

Modified: `www/index.html`, `www/app.js`, `tests/frontend-auth.test.js`.
Created: `www/chatStore.js`, `www/history-ui.js`, `tests/chatStore.test.js`, `tests/history-ui.test.js`, `tests/streaming-persistence.test.js`, `docs/phase-03-chat-history.md`.
Untouched: `server.js`, `middleware/auth.js`, `lib/firebaseAdmin.js`, `www/auth.js`, `www/config.js`, `www/firebase-config.js`, `main.js`, `capacitor.config.json`, `.env.example`, `.gitignore`, `package.json`.

## 21. Rollback notes

Every change is a source-level edit or a new file - no database, no server-side migration, no new npm dependency (`chatStore.js`/`history-ui.js` use only built-in browser APIs: `localStorage`, `Blob`, `URL`, `FileReader`, `crypto.randomUUID`). To roll back: revert the three modified files and delete the six created files listed in §20. No user-visible data model on the backend exists to roll back, since this phase is entirely client-side. `.env` was not touched. No git commit was created.

## 22. Future PostgreSQL migration contract

Not implemented in this phase (no existing repository path to extend, per the rules governing this phase), but the repository was deliberately shaped to make it a additive, not architectural, change later:

- A `www/chatStore.js`-compatible server-side module would implement the exact same method names (`listConversations`, `getConversation`, `createConversation`, `updateConversation`, `renameConversation`, `deleteConversation`, `clearConversationMessages`, `saveMessage`, `replaceMessages`, `searchConversations`, `exportConversationJson`, `importConversationJson`) as `async` functions returning the same `{ ok, ... }` result shapes.
- The natural REST surface is `/api/conversations` (list/create), `/api/conversations/:id` (get/update/delete), `/api/conversations/:id/messages` (save/replace), `/api/conversations/:id/clear`, mirroring the repository method names directly, protected by the existing `authenticateRequired` middleware from Phase 2 (a database-backed history is inherently an authenticated-only feature - guest/LocalStorage would remain the fallback for unauthenticated use).
- `www/history-ui.js` and `www/app.js` would swap their `store` reference from `LinguaHubChatStore.createChatStore({...})` to a thin client hitting that REST surface - since every call site already treats every method as returning a result object (several already resolve through intermediate variables named `result`), converting those call sites to `await` an async client is a mechanical, low-risk change, not a redesign.
- The existing per-namespace uid isolation maps directly onto a `WHERE user_id = $1` clause once verified identity flows from `req.user.uid` (already produced by `middleware/auth.js`) into a real backend query.
