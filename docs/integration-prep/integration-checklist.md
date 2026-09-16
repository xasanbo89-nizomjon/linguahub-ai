# Integration checklist

For whoever picks up the real LinguaHub integration next. Everything
below is **not done** - this is the list of real decisions and work this
phase deliberately left for that phase, with a pointer to the relevant
prep already in place.

## Before writing any integration code

- [ ] Audit the real LinguaHub repository's existing "AI bilan suhbat"
      entry point (route, current implementation, UI framework). See
      [existing-linguahub-chat-handoff.md](./existing-linguahub-chat-handoff.md).
- [ ] Decide Option A (connect existing LinguaHub UI to this project's
      API) vs Option B (embed this project's own components inside the
      existing route) based on that audit - not on assumption.
- [ ] Decide whether LinguaHub and LinguaHub AI share one Firebase
      project or federate two. See
      [shared-auth-contract.md](./shared-auth-contract.md), "What a real
      integration would still need to build," item 2.
- [ ] Decide embedding mechanism if Option B: iframe, web component, or a
      native panel sharing the page's own viewport. This phase
      deliberately did not choose one (`www/app-mode.js`'s own header
      comment: "Do not make embedded mode depend on an iframe unless
      later architecture explicitly chooses that").

## Wiring `appMode: "embedded"`

- [ ] Set `window.LINGUAHUB_CONFIG = { APP_MODE: "embedded", ... }` via an
      inline script before `theme.js`/`app-mode.js` load. See
      [embedded-mode.md](./embedded-mode.md).
- [ ] Decide per-feature overrides if the default simplifications aren't
      exactly right for the first real integration (`SHOW_IMPORT_EXPORT`,
      `SHOW_MODE_SELECTOR`, `SHOW_ACCOUNT_UI`).
- [ ] If embedding via a non-iframe mechanism (a real native panel sharing
      the host page's own viewport, not its own `<iframe>` document): the
      existing mobile-width CSS (`@media max-width: 768px` etc.) will
      **not** automatically apply just because the panel is visually
      narrow - it responds to viewport width, not container width. This
      needs either CSS Container Queries or a LinguaHub-injected width
      class. Explicitly deferred by this phase - see
      [embedded-mode.md](./embedded-mode.md), "Panel-size readiness."

## Wiring shared auth

- [ ] Write the actual LinguaHub-side bridge script that calls
      `window.LinguaHubAuth.provideExternalIdentity({ getCurrentUser,
      onAuthStateChanged, getIdToken })` with real values backed by
      LinguaHub's own already-signed-in Firebase user.
- [ ] Decide subscription-ordering: does the bridge script run before
      `app.js`'s own `onAuthStateChanged` subscription, or does
      something need to re-subscribe after the adapter becomes available?
      See [shared-auth-contract.md](./shared-auth-contract.md).
- [ ] Confirm `getIdToken()` on the adapter really does return a live
      Firebase ID token (not a cached/stale one) - the backend's existing
      `middleware/auth.js` verification is unchanged and will reject
      anything else exactly as it does today for this project's own
      tokens.

## Wiring page context (if this integration phase wants it - optional for a first version)

- [ ] Build the actual LinguaHub-side context adapter that reads real
      page state (route, module, testId, etc.) and calls
      `window.LinguaHubContextAdapter.applyContext({...})` with only
      allowed fields. See
      [context-adapter-contract.md](./context-adapter-contract.md).
- [ ] Decide whether/how validated context also gets forwarded to the
      backend as part of the actual chat request (this phase's context
      adapter only updates the visible chip - it does not modify
      `/api/chat`'s request shape or `lib/contextBuilder.js`). If so,
      **the backend must independently re-validate it** - frontend
      validation here is not authoritative.
- [ ] If LinguaHub-specific AI modes are wanted (e.g. a mode tuned for
      "help with this specific question" using page context), decide
      whether that's a new mode id in `lib/aiModes.js` or reuse of an
      existing general-purpose mode - see
      [../linguahub-ai-integration-handoff.md](../linguahub-ai-integration-handoff.md),
      "What a first real integration phase would need to decide," item 1.

## If Option A is chosen (LinguaHub's own UI, this project as an engine only)

- [ ] Extract `www/app.js`'s DOM-coupled send/stream/edit/regenerate/retry
      logic into functions that take/return data instead of touching
      specific message-wrapper elements. See
      [assistant-component-boundaries.md](./assistant-component-boundaries.md),
      "Tightly DOM-coupled" - this is real, scoped work, not started by
      this phase.

## Rate limiting and volume

- [ ] Re-evaluate `lib/rateLimiter.js`'s current uid-based limits before
      launch - tuned for a standalone chat app, not necessarily an
      assistant embedded in every lesson for many concurrent students.
      Already flagged in
      [../linguahub-ai-integration-handoff.md](../linguahub-ai-integration-handoff.md).

## Retiring the old entry point

- [ ] Once the new integration is live and verified, retire or redirect
      LinguaHub's previous "AI bilan suhbat" implementation - never leave
      both reachable as separate, competing chat surfaces (the one rule
      this whole effort exists to satisfy - see
      [existing-linguahub-chat-handoff.md](./existing-linguahub-chat-handoff.md)).

## What NOT to re-decide

Everything documented as already decided in
[../linguahub-ai-integration-handoff.md](../linguahub-ai-integration-handoff.md)
("What does not change": no new database, no new auth mechanism, no new
streaming protocol, no `lib/aiModes.js` architecture rewrite) still
applies. This phase's additions (app mode, the two adapters) are built to
extend that contract, not replace it.
