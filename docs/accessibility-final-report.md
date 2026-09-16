# Accessibility Final Report (Phase 8)

## Automated result: 0 critical, 0 serious, 0 moderate, 0 minor axe-core violations

`e2e/accessibility.js` scans 4 real page states (empty state, a populated conversation with Markdown/code/table/RTL content, the settings dialog open, the mobile drawer open) with axe-core injected into a real Chromium page. As of this phase: **18/18 checks pass**, and the violation counts printed by the script are `none` across every severity in every state.

This is **automated tooling** (axe-core), not a substitute for real screen-reader testing - see below.

## The two Phase 7 moderate findings: fixed

Both were the same underlying issue: `landmark-one-main`/`region` flagged that the composer (the message input + Send button) sat outside any ARIA landmark.

**Root cause**: Phase 7 had scoped `role="main"` to just `.chat-scroll-wrapper`, and put `role="banner"` on `.header` - correct individually, but the composer (`.controls`) is a sibling of both, inside neither.

**Fix** (`www/index.html`): moved `role="main"` up to `.container` (which wraps header + chat + composer together) and removed `role="banner"` from `.header` (nesting a `banner` landmark inside `main` is itself flagged invalid by axe's own landmark rules, so simply adding `main` around the existing `banner` would have traded one violation for another). For a single-view chat app with no separate site-chrome/content distinction, one `main` landmark covering the whole interactive interface is the more accurate model than a separate banner.

Verified: axe-core's `region`/`landmark-one-main` violations are gone (re-scanned live, all 4 states); `<aside>`'s implicit `role="complementary"` (used for the sidebar) was left alone - it's a sibling of `.container`, not nested inside the new `main`, so it stays valid. Two new regression tests (`tests/styles-source.test.js`) lock in "exactly one `role=\"main\"`" and "no `role=\"banner\"`" at the source level.

## Additional checks completed this phase (Task 10)

| Check | Method | Result |
|---|---|---|
| Landmark naming | real (axe) | 1 `main`, 1 implicit `complementary` (aside), correctly labeled |
| Heading order | real (axe + structural) | exactly one `<h1>`, confirmed live |
| Duplicate accessible names | real (axe) | none flagged |
| Icon-only buttons | real (structural check in `e2e/accessibility.js`) | every icon-only button has an `aria-label` |
| Form labels | real (source + axe) | composer and search inputs both have real `<label for=...>` elements |
| Focus order | real (`e2e/keyboard.js`, unchanged from Phase 7, re-run this phase) | 26/26 passing, including the real dialog/drawer focus-trap wrap-around tests |
| Dialog focus trap | real | Shift+Tab from the first control wraps to the last; Tab from the last wraps to the first; Escape restores focus to the exact triggering button |
| Drawer focus trap | real | same pattern, re-verified against the *true* first focusable element (the desktop collapse-rail button, not just wherever focus starts) |
| Focus restoration | real | confirmed for both dialogs and the drawer |
| Toast announcements | real | `aria-live="polite"` confirmed on a real triggered toast |
| Message status announcements | real (new this phase) | a real forced-failure message's status label carries `role="status"` (implicit `aria-live="polite"`) - was already correctly implemented, verified rather than assumed |
| Mode disabled state | real | disabled modes use native `<option disabled>`, confirmed exposed to the accessibility tree (not just visually styled) |
| Error announcements | real (new this phase) | same `role="status"` mechanism covers both "Stopped" and "Failed" |
| Color contrast | real (axe, all 4 states) | 0 violations (all 6 Phase 7 contrast fixes remain intact and unregressed) |
| 200% zoom | real (new this phase) | no horizontal page overflow; composer and Send button both remain visible and usable |
| Reduced motion | real (already covered, re-verified) | `prefers-reduced-motion: reduce` emulated live; animation duration collapses as expected |
| High contrast mode | real (new this phase, via `forced-colors: active` emulation) | page remains rendered and functional - not a blank page or invisible controls. Emulation via Chromium's `forced-colors` media feature is a reasonable proxy for Windows High Contrast Mode but is not identical to testing on a real Windows machine with High Contrast actually enabled in the OS - noted as a real, if minor, gap. |

## Screen-reader testing (Task 11): NOT RUN

No screen reader (NVDA, JAWS, VoiceOver, or any other) is available in this environment, and there is no way to launch one and interpret its audio/braille output from this session. This is stated plainly. **Automated axe-core scanning is not a substitute for this and is never presented as one anywhere in this project's documentation.**

If a screen reader becomes available in a future session, the flows to walk manually are: app title announcement on load, the sign-in control's disabled/enabled state and label, sidebar navigation between conversations, New Chat, the composer and its label, the streaming status announcement, Stop, each message action button's label, a dialog's title/description announcement and focus trap, a toast's announcement, the mode selector's options (including which are announced as disabled), the settings panel, and logout.

## Remaining known gaps (not hidden)

- Screen-reader testing itself: NOT RUN (see above) - this is the largest remaining gap for a fully accessible release.
- High-contrast verification used browser emulation, not a real Windows High Contrast Mode session.
- No manual testing with actual assistive technology hardware (switch access, magnification software, voice control) was performed - none is available in this environment.
