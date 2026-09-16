# Production Security Headers (Phase 11)

Re-audit of every Helmet/security header, live-verified via
`curl -sI http://127.0.0.1:3000/health` and
`tests/server-production.test.js` this phase - not assumed from config
alone.

| Header | Value | Status |
|---|---|---|
| `Content-Security-Policy` | `default-src 'self'; script-src 'self' https://www.gstatic.com; ...` (full policy unchanged from Phase 4, see `server.js`) | ✅ unchanged, re-verified live |
| `Strict-Transport-Security` | `max-age=15552000; includeSubDomains` | ✅ **new this phase** - see "HSTS" below |
| `X-Content-Type-Options` | `nosniff` | ✅ unchanged (Helmet default) |
| `X-Frame-Options` | `SAMEORIGIN` | ✅ unchanged (Helmet default) |
| `Cross-Origin-Opener-Policy` | `same-origin-allow-popups` | ✅ unchanged (required for `signInWithPopup`) |
| `Cross-Origin-Embedder-Policy` | disabled | ✅ unchanged (would block the gstatic-hosted Firebase SDK) |
| `Referrer-Policy` | `no-referrer` | ✅ unchanged (Helmet default) |
| `X-DNS-Prefetch-Control` | `off` | ✅ unchanged (Helmet default) |
| `X-Download-Options` | `noopen` | ✅ unchanged (Helmet default) |
| `X-Permitted-Cross-Domain-Policies` | `none` | ✅ unchanged (Helmet default) |
| `X-XSS-Protection` | `0` | ✅ unchanged (Helmet default - modern browsers rely on CSP, not this legacy header) |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=()` | ✅ **new this phase** - see below |

## CSP directives, individually re-confirmed still correct

| Directive | Value | Why |
|---|---|---|
| `object-src` | `'none'` | No Flash/plugin content anywhere in this app |
| `base-uri` | `'self'` | Prevents a `<base>` tag injection from rewriting relative URLs |
| `form-action` | `'self'` | This app has no cross-origin form submissions |
| `frame-ancestors` | `'self'` | Clickjacking protection - equivalent to `X-Frame-Options: SAMEORIGIN`, the modern CSP mechanism for the same thing |
| `frame-src` | `https://*.firebaseapp.com https://accounts.google.com` | Required for Firebase Auth's own iframe/redirect flow - unchanged since Phase 2 |
| `connect-src` | `'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com` | The Firebase Auth SDK's own REST endpoints - unchanged |
| `script-src` | `'self' https://www.gstatic.com` | Same-origin app code + the Firebase SDK CDN - unchanged |

No directive was loosened this phase. `useDefaults: false` remains
correct - every directive is explicit, nothing relies on Helmet's own
defaults silently changing behavior across a future Helmet upgrade.

## HSTS (Strict-Transport-Security) - new this phase

`strictTransportSecurity: { maxAge: 15552000, includeSubDomains: true }`
(180 days). Safe to send unconditionally (including in local HTTP
development) - **HSTS is only ever acted on by a browser that received it
over a genuine HTTPS connection**; a plain `http://127.0.0.1:3000` dev
session sees the header but browsers do not apply HSTS pinning from a
plaintext response, so this cannot break local development. `preload` is
deliberately **not** set - submitting a domain to browsers' HSTS preload
list is a one-way, hard-to-reverse operator decision (removal takes
months to propagate) that this project does not make on anyone's behalf;
an operator who wants it can add `preload: true` and submit their real
production domain themselves once one exists.

**Production expectation**: HSTS is only meaningful at all once real
HTTPS termination exists in front of this app (see
`docs/production-sse-proxy.md`/`docs/nginx-example.conf`) - it does not
create or enforce HTTPS itself, only tells a browser that already reached
this origin over HTTPS to keep doing so for `maxAge` seconds.

## Permissions-Policy - new this phase

Not part of Helmet 8's own API (confirmed by inspecting `Object.keys(helmet)`
directly - Helmet dropped built-in support for this header years ago,
since the spec was still evolving, and its own docs recommend setting it
directly). Implemented as a small dedicated middleware in `server.js`.
This app uses no camera, microphone, geolocation, payment, or USB Web
API anywhere (confirmed by source review across `www/*.js`) - all five
are denied by default. Clipboard access (the Copy feature) is governed by
the separate Clipboard API permission model, not `Permissions-Policy`, so
it's unaffected by this list. Verified live:
`tests/server-production.test.js`, "Permissions-Policy header is present
and denies camera/microphone/geolocation/payment/usb."

## Firebase/Google exceptions, if auth is later fully enabled in production

No CSP change is needed if/when a real Firebase project is provisioned -
`frame-src`/`connect-src`/`script-src`'s existing Google/Firebase
allowances already cover the web popup/redirect flow (`docs/
firebase-production-checklist.md`). The native Android auth path
(`docs/capacitor-native-auth.md`) runs outside the WebView's CSP entirely
(native Kotlin/Java code, not a page load), so it needs no CSP
accommodation at all.

## Nothing added that breaks current functionality

Every header above was verified against the real, running application
this phase (`tests/server-production.test.js`, plus the full `npm test`
and `npm run test:e2e` suites re-run clean after these changes - see
`docs/phase-11-production-preparation.md`, Task 25) - none is
speculative.
