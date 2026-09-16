# LinguaHub AI — Integration Prep

This directory documents the work done to prepare the standalone
LinguaHub AI frontend for future embedding inside the main LinguaHub
platform. **No integration was performed in this phase.** The LinguaHub
repository does not exist inside this project and was not touched. This
project's own backend architecture, AI routes, streaming protocol,
authentication architecture, and conversation storage are all unchanged.

## The one non-negotiable product decision

> **Existing LinguaHub AI conversation experience must become the
> user-facing entry point for LinguaHub AI. Do not create a duplicate
> competing chat product.**

LinguaHub already has a user-facing AI conversation feature ("AI bilan
suhbat", similar in spirit to IELTS GG's AI chat). When integration
actually happens, that existing entry point is what gets connected to (or
replaced by) LinguaHub AI's engine/components - **not** a second,
separately-launched chat surface living alongside it. See
[existing-linguahub-chat-handoff.md](./existing-linguahub-chat-handoff.md)
for the full reasoning and the two integration shapes this implies.

## What "integration prep" means here

This phase introduces exactly one new architectural concept - **app mode**
(`standalone` vs `embedded`, see [embedded-mode.md](./embedded-mode.md)) -
plus a small number of dormant extension points (an auth adapter, a
context-validation contract) that a future LinguaHub-side integration can
call into. None of them are wired to real LinguaHub data or a real
LinguaHub auth session today; they exist so that work can start from a
tested contract instead of a blank page.

## Documents in this directory

| Document | Covers |
|---|---|
| [embedded-mode.md](./embedded-mode.md) | The `appMode` concept, what changes in embedded mode vs standalone, and why |
| [shared-auth-contract.md](./shared-auth-contract.md) | The one-Google-login architecture and the `provideExternalIdentity()` adapter |
| [context-adapter-contract.md](./context-adapter-contract.md) | The allowed/forbidden page-context field contract and its validator |
| [existing-linguahub-chat-handoff.md](./existing-linguahub-chat-handoff.md) | Why the existing "AI bilan suhbat" experience is the integration target, not a new one |
| [assistant-component-boundaries.md](./assistant-component-boundaries.md) | Which frontend pieces are already reusable as-is, and which would need extraction later |
| [integration-checklist.md](./integration-checklist.md) | A concrete checklist for whoever picks up the real integration next |

There is also a pre-existing document from an earlier phase,
[../linguahub-ai-integration-handoff.md](../linguahub-ai-integration-handoff.md),
which defines the **backend** integration contract (what page context may
safely reach the AI provider, the `/api/chat` / `/api/chat/stream`
surface, mode selection). This directory's documents are the **frontend**
counterpart to that document, written after real embedded-mode UI work
existed to describe.

## What did not change

- Backend AI routes, streaming protocol, `lib/aiModes.js`'s mode registry
- Authentication architecture (`middleware/auth.js`, `lib/firebaseAdmin.js`)
- Conversation storage (`www/chatStore.js`), its schema, its namespacing
- Markdown/code rendering, Stop/Edit/Regenerate/Retry behavior
- Accessibility behavior (focus traps, ARIA, contrast) - re-verified, not
  redesigned
- Standalone mode's visual design, layout, or feature set

## What is new (all additive, all off by default)

- `www/app-mode.js` - resolves `standalone` (default) vs `embedded`
- `www/strings.js` - centralized user-facing copy (currently one string)
- `www/context-adapter.js` - a page-context allowlist validator, unconnected
- `auth.js`'s `provideExternalIdentity()` - a dormant identity-adapter hook
- A handful of `[data-app-mode="embedded"]`-gated CSS rules in `styles.css`
- Composer footer: "Enter to send · Shift+Enter for a new line" replaced by
  an AI-accuracy disclaimer (keyboard behavior itself unchanged)
