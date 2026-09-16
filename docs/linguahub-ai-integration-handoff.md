# LinguaHub AI → LinguaHub Integration Handoff (Phase 12)

**This phase does not perform this integration.** LinguaHub AI ships
today as a standalone product (web, Electron, and - once Android is
unblocked - a mobile app). This document hands off the architecture and
constraints for the *next* project step: turning LinguaHub AI into an
**in-product contextual assistant embedded inside LinguaHub** (the
separate host product LinguaHub AI is intended to eventually serve),
rather than a destination app of its own.

## The shift in role

| Today (Phase 1-12) | Future (next project) |
|---|---|
| LinguaHub AI is the whole product - a user opens it directly | LinguaHub AI is a panel/component *inside* LinguaHub - a user is doing something else (a lesson, a test, a module) and opens the assistant *in context* |
| The user picks a mode explicitly (General/Codex/Cyber/Deep Thinking) | LinguaHub itself may pick or constrain the relevant mode based on what part of the product the user is in |
| No knowledge of what the user was doing before opening chat | The assistant receives *safe, scoped context* about the user's current LinguaHub activity |
| Chat history is the only "memory" | Same - this integration does not add new server-side persistence; see "What does not change" below |

## Integration contract

```
LinguaHub Page
  → AI Assistant Panel            (new: lives inside LinguaHub's own UI)
  → context adapter               (new: LinguaHub-side code, NOT part of this repo)
  → LinguaHub AI API               (existing: /api/chat, /api/chat/stream)
  → backend-controlled AI mode/service   (existing: lib/aiModes.js)
  → streamed response              (existing: text/event-stream, unchanged)
```

**Everything left of "LinguaHub AI API" is LinguaHub's own responsibility
and does not exist in this repository.** Everything from "LinguaHub AI
API" rightward is what this project already ships, unmodified by this
integration in principle - see "What does not change" below.

### Where each piece lives

1. **LinguaHub Page** - a real page in the host product (a lesson, a
   test, a module view). Not part of this project.
2. **AI Assistant Panel** - a UI surface LinguaHub embeds (an iframe, a
   web component, or a native panel calling this project's API directly)
   - a LinguaHub-side build decision, not made here.
3. **Context adapter** - LinguaHub-side code that decides *what, if
   anything,* about the current page is safe to hand to the assistant,
   and shapes it into the request this API already accepts. This is the
   most important new piece and the one this document constrains most
   tightly (see below) - it is the sole gatekeeper between "everything
   LinguaHub knows about the user's session" and "what the AI model ever
   sees."
4. **LinguaHub AI API** - this project's own existing, already-shipped,
   already-tested surface: `POST /api/chat` / `POST /api/chat/stream`,
   `authenticateOptional` (unchanged), `GET /api/ai/modes` for discovering
   available modes. No new route is required for a first integration.
5. **Backend-controlled AI mode/service** - `lib/aiModes.js`, already the
   single source of truth for system prompts/model/limits, already
   proven to reject any client-supplied override
   (`FORBIDDEN_REQUEST_FIELDS`). LinguaHub's context adapter selects a
   mode **by id only** (e.g. `"general"` or a future LinguaHub-specific
   mode added to this registry) - it can never supply a system prompt,
   model, or temperature itself, exactly like every other client this
   project already serves.
6. **Streamed response** - the existing `text/event-stream` contract,
   unchanged. LinguaHub's Assistant Panel consumes it the same way this
   project's own frontend already does (`www/app.js`'s
   `streamChat()` is a reference implementation).

## What page context may safely be included

The context adapter (LinguaHub-side) may include, as **plain, already-
computed, non-sensitive data**, appended to the chat request in a way
this backend can incorporate into the mode's context
(`lib/contextBuilder.js` already exists as the seam for this - a future
LinguaHub-aware mode would extend what it accepts, not replace it):

- **Current route** (e.g. `/lessons/12/quiz`) - identifies *where* the
  user is, not *what* they're doing there.
- **Module name** (e.g. `"Past Tense Verbs"`) - a label, not content.
- **Test ID** / **question ID** - opaque identifiers, useful for the
  assistant to reference "this question" without re-deriving it, but
  never a substitute for sending the actual question/answer content
  unfiltered (see below).
- **Result summary** (e.g. `"3 of 5 correct"`) - an already-computed,
  user-visible outcome, not raw scoring internals.
- **User-visible content** - text the user themselves can already see on
  the page right now (a question's prompt text, a passage they're
  reading) - if the user can see it unassisted, showing it to the
  assistant that's helping them with it is not a new exposure.
- **Language** - the user's current UI/content language, relevant to
  LinguaHub AI's existing multilingual system prompts (already
  demonstrated for English/Arabic/Russian/Uzbek in `lib/aiModes.js`).
- **User role** (e.g. `"student"`/`"teacher"`) - relevant for the backend
  to potentially select a different mode/system-prompt tier in the
  future, exactly the same "backend decides, client only states an id"
  pattern `lib/aiModes.js` already enforces for mode selection.

## What must never be included

- **Secrets** - API keys, session tokens, internal service credentials -
  none of this belongs in a chat context under any circumstance.
- **Raw Firebase ID token** - the context adapter must never forward the
  token itself as "context." Identity continues to flow exactly as it
  does today: as the `Authorization: Bearer <token>` header, verified
  server-side by the **existing, unmodified**
  `middleware/auth.js`/`lib/firebaseAdmin.js` - never re-derived,
  re-parsed, or trusted from anything the context adapter claims.
- **Hidden answers the student should not see** - if a test/question has
  a correct answer not yet revealed to the user, the context adapter must
  never include it, even indirectly (e.g. "the correct answer is X, help
  the student understand why they got it wrong" is a LinguaHub-side
  policy decision with real pedagogical and academic-integrity
  consequences and must be deliberately, explicitly decided by LinguaHub
  - never a default this integration assumes).
- **Unauthorized admin data** - anything a teacher/admin view can see
  that the current signed-in user's role should not (grade rosters, other
  students' results, internal moderation notes).
- **Another user's private data** - LinguaHub AI's own namespace
  isolation (`www/chatStore.js`, uid-based) already strictly separates
  one user's chat history from another's; the context adapter must
  preserve this by construction - it should only ever be able to access
  *the current authenticated user's own* session data, the same
  boundary `middleware/auth.js` already enforces for every existing
  route.

## What does not change

This integration, when it happens, should **not** require: a new
database, a new auth mechanism, a new streaming protocol, or a rewrite of
`lib/aiModes.js`'s architecture. The backend-authoritative principle this
project has enforced since Phase 1 (client selects a mode id only, server
owns every prompt/model/limit decision) is exactly the principle that
makes this integration safe to build later without redesigning anything
now: LinguaHub's context adapter is just a new, more knowledgeable
*client* of an API surface that already assumes it can never fully trust
what a client sends.

## What a first real integration phase would need to decide (not decided here)

1. Whether LinguaHub-specific modes belong in `lib/aiModes.js` directly
   (new mode ids, LinguaHub-aware system prompts) or whether the existing
   general-purpose modes are reused as-is for a first version.
2. The exact shape of the "context" fields above as real request-body
   fields (this document intentionally does not invent a wire format -
   that's an implementation decision for the phase that actually builds
   this).
3. Whether the Assistant Panel is embedded via iframe (simplest, reuses
   this project's existing `www/` frontend close to as-is) or built
   natively into LinguaHub's own UI (more integration work, more
   consistent UX).
4. Rate-limiting implications: `lib/rateLimiter.js`'s existing uid-based
   keying already extends naturally to a LinguaHub-embedded user, but the
   *volume* expectations (many students, many concurrent panels) should
   be re-evaluated before launch - this project's current defaults were
   tuned for a standalone chat app, not necessarily an embedded-in-every-
   lesson assistant.

## Explicitly out of scope for Phase 12

No LinguaHub integration code was written. No new API route was added.
No new mode was added to `lib/aiModes.js`. This document is a contract
and constraint list for a future phase, not an implementation.
