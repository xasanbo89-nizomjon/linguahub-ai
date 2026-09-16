# Shared auth contract ("one login, not two")

## The target

> User signs into LinguaHub with Google once → existing LinguaHub auth
> session resolves → LinguaHub AI automatically uses the same identity →
> no second Google login prompt.

This is **not implemented yet** - LinguaHub doesn't exist in this
repository, so there is nothing real to connect to. This document and the
adapter hook it describes exist so that when a real LinguaHub-side bridge
is written, it has a tested, minimal seam to plug into instead of forcing
a redesign of `www/auth.js`.

## What this explicitly is not

- **Not a new auth provider.** This app still only ever knows about
  Firebase (Web SDK popup/redirect, or the native Capacitor Android
  plugin - both unchanged, both still fully present and functional).
- **Not a new JWT/token system.** Whatever identity source is active
  (this app's own Firebase instance, or a future external adapter) is
  still expected to hand back a real Firebase ID token; the backend
  verification path (`middleware/auth.js`, `lib/firebaseAdmin.js`) is
  completely unmodified and stays the sole source of truth for who a
  request actually is.
- **Not frontend-trusted identity.** Nothing about this adapter lets a
  plain `userId` string be trusted by the frontend or forwarded as if it
  were verified. `getIdToken()` on any identity source (own or adapted)
  must resolve to a real Firebase ID token or `null` - never a bare id.
- **Not localStorage-based.** Neither this app's own auth code nor the
  adapter hook writes a user or token to localStorage anywhere - it never
  has, and this phase didn't change that (see the `tests/frontend-auth.test.js`
  structural check that greps both `auth.js` and `app.js` for any
  `localStorage.setItem`-shaped token write).

## The adapter hook

`www/auth.js` now exposes one new function on `window.LinguaHubAuth`:

```js
window.LinguaHubAuth.provideExternalIdentity({
  getCurrentUser: () => user | null,
  onAuthStateChanged: (callback) => unsubscribeFn,
  getIdToken: (forceRefresh) => Promise<string | null>
});
```

This is the exact same three-function shape `www/auth.js` already exposes
for its own Firebase/native backends - nothing new was invented, an
existing, already-proven contract was made pluggable. Once called (by a
future LinguaHub-side bridge script, after `auth.js` has loaded but before
or after `app.js`'s own subscription - order doesn't matter, see below),
every one of `LinguaHubAuth`'s public functions that resolves identity
(`isAvailable()`, `getCurrentUser()`, `onAuthStateChanged()`,
`getIdToken()`) delegates to the adapter instead of this app's own
Firebase instance. `signInWithGoogle()`/`signOutUser()`/
`completeRedirectSignIn()` are **not** touched by the adapter - those are
about *initiating* a sign-in/out action, which embedded mode's UI hides
by default anyway (see [embedded-mode.md](./embedded-mode.md)); a future
integration phase would decide separately whether those need to also
delegate.

### Why call-order doesn't matter

`provideExternalIdentity()` just sets a module-level variable that every
public function checks *at call time*, not at module-load time - so it
works whether a LinguaHub bridge script calls it before `app.js` runs its
own `onAuthStateChanged` subscription, or after. If called after,
`app.js`'s existing subscription simply keeps working against whatever it
was already subscribed to until unsubscribed and re-subscribed - a real
integration would need to decide when/how to re-subscribe on adapter
availability, which is exactly the kind of decision this document defers
to the actual integration phase (see
[integration-checklist.md](./integration-checklist.md)).

### Safety properties (why this can't fake a user)

- An incomplete adapter (missing any of the three required functions) is
  rejected outright and never installed - `console.error` and the
  existing backend keeps being used. Verified by
  `tests/frontend-auth.test.js`'s
  *"provideExternalIdentity() rejects an incomplete adapter"* test.
- `getCurrentUser()`/`onAuthStateChanged()` only ever forward exactly
  what the adapter itself returns - an adapter reporting `null` is never
  upgraded into a fabricated user. Verified by the
  *"never fabricates a user of its own"* test.
- `getIdToken()` always calls through to the adapter's own
  implementation - this module never mints, caches, or stores a token
  independently once an adapter is active.

## What a real integration would still need to build (not built here)

1. **The actual LinguaHub-side bridge script** that calls
   `provideExternalIdentity()` with real values, backed by LinguaHub's
   own already-signed-in Firebase user object and `getIdToken()`
   implementation. This is LinguaHub-side code and does not belong in
   this repository.
2. **A decision on whether LinguaHub and LinguaHub AI share the exact
   same Firebase *project*, or federate two different Firebase projects
   under a single UI flow.** This document assumes the former (the
   simplest, and the one that makes "the same ID token verifies on both
   sides" trivially true) but that is a LinguaHub-infrastructure decision,
   not one this repository can make.
3. **Re-subscription behavior** if `provideExternalIdentity()` can be
   called after `app.js` has already subscribed (see "why call-order
   doesn't matter" above) - not needed for a first integration if the
   bridge script runs before `app.js`, but worth deciding explicitly if
   it can't guarantee that ordering.

## Testing

`tests/frontend-auth.test.js` runs the real, unmodified `www/auth.js`
source in a sandboxed VM context (the same technique already used for
every other auth.js behavior in this test suite) and covers: no-adapter
behavior is unchanged; `getCurrentUser`/`isAvailable`/
`onAuthStateChanged`/`getIdToken` all correctly delegate once an adapter
is provided; an incomplete adapter is rejected; no user is ever
fabricated.
