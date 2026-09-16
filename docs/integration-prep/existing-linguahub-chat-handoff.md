# Existing LinguaHub "AI bilan suhbat" handoff

## The rule this document exists to enforce

> **Existing LinguaHub AI conversation experience must become the
> user-facing entry point for LinguaHub AI. Do not create a duplicate
> competing chat product.**

LinguaHub already has a user-facing AI conversation feature - referred to
in product discussions as "AI bilan suhbat" ("chat with AI"), similar in
spirit to IELTS GG's AI chat feature. When a user opens **that existing
entry point**, after integration they should be talking to LinguaHub AI.

## What this explicitly rules out

```
LinguaHub
 ├─ existing "AI bilan suhbat" entry  →  (unchanged / abandoned - BAD)
 └─ new "LinguaHub AI" entry          →  LinguaHub AI engine  (BAD - a second, competing surface)
```

This is not the target shape. Two separate chat entry points in the same
product - one old, one new, both AI conversation features - is exactly
the outcome this phase's brief calls out by name as forbidden. It creates
user confusion ("which chat do I use?"), fragments conversation history
across two unrelated systems, and wastes the actual value of this
project's polish (green/white LinguaHub branding, LH identity, streaming,
modes, accessibility) by leaving it disconnected from where students
already go.

## The target shape

```
LinguaHub
 → existing "AI bilan suhbat" entry
 → existing LinguaHub conversation UI/route
 → LinguaHub AI engine/service
```

The existing entry point and route stay the user-facing surface. What
changes behind it is an implementation decision for the actual
integration phase, informed by auditing the real LinguaHub repository
(which does not exist in this project and was not audited here):

### Option A — connect the existing LinguaHub UI to the LinguaHub AI engine

LinguaHub's current "AI bilan suhbat" screen keeps its own UI exactly as
students already know it, and its send/receive logic is pointed at this
project's API (`POST /api/chat` / `POST /api/chat/stream` - see
[../linguahub-ai-integration-handoff.md](../linguahub-ai-integration-handoff.md)
for the exact backend contract) instead of whatever currently powers it.
Lowest visual disruption for existing users; LinguaHub owns 100% of the
UI code.

### Option B — reuse LinguaHub AI's own chat components inside that existing route

LinguaHub's "AI bilan suhbat" route renders this project's own frontend
components (or a close derivative of them - see
[assistant-component-boundaries.md](./assistant-component-boundaries.md)
for exactly which pieces are reusable as-is today) instead of its current
implementation, still reached through the same existing entry point/URL
the student already uses. More of this project's UI work (LH branding,
streaming UX, accessibility, message actions) carries over directly;
LinguaHub's route becomes a host for embedded-mode LinguaHub AI rather
than its own hand-built chat UI.

### Choosing between them

**Not decided in this phase, and not decidable without auditing the real
LinguaHub repository** - specifically: how its current "AI bilan suhbat"
UI is built (framework, component structure), how much of its existing
UX needs to be preserved for continuity with existing users, and how much
engineering effort LinguaHub's team wants to spend integrating vs.
replacing. This phase's job was to make Option B possible without a
rewrite (see `www/app-mode.js` and the reusable component boundaries
document) - not to choose it.

## What this phase did NOT do

- Did not open, read, or modify the LinguaHub repository (it isn't part
  of this project).
- Did not build a new chat entry point, route, or UI anywhere.
- Did not connect this project's frontend to anything claiming to be
  LinguaHub's existing chat route.
- Did not invent a "migration" or "replacement" plan for the existing
  entry point's current implementation - that requires information (the
  real LinguaHub codebase) this phase doesn't have.

## What a real integration phase should do first

1. Locate and read LinguaHub's actual "AI bilan suhbat" route/component in
   the real LinguaHub repository.
2. Decide Option A vs Option B (or a hybrid) based on what's actually
   there, not assumptions made in this document.
3. Only then, connect it to this project's `/api/chat*` surface per
   [../linguahub-ai-integration-handoff.md](../linguahub-ai-integration-handoff.md),
   using `appMode: "embedded"` (see [embedded-mode.md](./embedded-mode.md))
   if Option B is chosen.
4. Retire or redirect the old implementation once the new one is live -
   never run both as separate, simultaneously-reachable chat entry points.
