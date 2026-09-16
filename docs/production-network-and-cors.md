# Production Network, CORS, and Reverse-Proxy Trust (Phase 11)

## CORS policy

`server.js` allows exactly the origins in `ALLOWED_ORIGINS`
(`DEFAULT_ALLOWED_ORIGINS` - local dev only - plus whatever
`FRONTEND_ORIGINS` validates to, see `docs/production-environment.md`) -
nothing else, and never reflects an arbitrary request Origin back as
allowed.

| Requirement | Status |
|---|---|
| Exact allowed origins (no wildcard) | ✅ - `ALLOWED_ORIGINS.includes(origin)`, an exact-match allowlist |
| No wildcard combined with credentials | ✅ - `cors()` is never configured with `credentials: true` anywhere in this app; identity travels via an explicit `Authorization: Bearer <token>` header, never a cookie, so there is no credentialed-CORS surface to misconfigure |
| `Authorization` header allowed | ✅ - `allowedHeaders: ["Content-Type", "Authorization"]` |
| `Content-Type` header allowed | ✅ - same list |
| `OPTIONS` preflight handled | ✅ - the `cors` npm package auto-handles `OPTIONS` (no `preflightContinue`), re-verified this phase (`tests/auth.test.js`, "CORS preflight for /api/auth/me allows the Authorization header") |
| Invalid/unrecognized origin rejected | ✅ - `callback(new Error("Not allowed by CORS"))`, mapped to a safe 403 JSON body by the centralized error handler |
| `localhost` allowed only in development | ✅ in intent - the *default* `localhost`/`127.0.0.1` origins exist for local dev regardless of `NODE_ENV` (matching how this app has always been manually tested - Live Server, `npm start`), but a **production** deployment adds its real origins via `FRONTEND_ORIGINS`, and `lib/env.js` warns if a production `FRONTEND_ORIGINS` entry uses plain `http://` on anything but loopback - see `docs/production-environment.md` |
| Production supports only configured real domains | ✅ - exactly `FRONTEND_ORIGINS`, validated at startup, nothing guessed |
| Rejected origins logged safely | ✅ (Phase 11, new) - `logger.warn("cors origin rejected", { origin })`; an Origin header is a hostname, never a secret, so this is safe to log in full |

## Electron / Capacitor origin handling (documented separately, as required)

Electron (loading `main.js`'s `file://` page) and many Capacitor/mobile
WebView requests send **no `Origin` header at all** - CORS is a
browser-enforced mechanism tied to a page's own origin, and a `file://`
page, or various native WebView fetch implementations, simply don't send
one. `server.js`'s CORS check therefore explicitly allows a missing
Origin (`if (!origin || ALLOWED_ORIGINS.includes(origin))`).

**This is safe, not a loophole**: CORS only ever protects *browser*
clients from having their credentials/cookies silently used against their
will by a malicious page - it was never a server-side access-control
mechanism, and a non-browser client (curl, a script, a compromised
machine) can already omit the Origin header and bypass CORS entirely
regardless of what this server does. Real authorization in this app comes
from `middleware/auth.js`'s cryptographic Firebase ID token verification,
never from CORS - CORS here is purely a defense against a *browser*
silently misusing a signed-in user's session from an untrusted page, and
that protection is unaffected by also allowing no-Origin requests through
for Electron.

Capacitor's own default WebView origins (`capacitor://localhost` on iOS,
`http://localhost` implicitly reachable on Android) ARE explicitly listed
in `DEFAULT_ALLOWED_ORIGINS` for the cases where a Capacitor WebView *does*
send an Origin header.

## Trust proxy and client IP (Task 5)

`app.set("trust proxy", envResult.trustProxy)` - **defaults to `0`**
(trust nothing; `req.ip` is the direct TCP peer address) unless
`TRUST_PROXY` is explicitly set. This matters because the rate limiter
(`lib/rateLimiter.js`) keys guest requests by `req.ip` - if Express
blindly trusted an `X-Forwarded-For` header with no reverse proxy in
front of it, any client could spoof that header to present a fresh IP on
every request and bypass rate limiting entirely.

### Expected production topology

This project targets the single most common shape: **exactly one reverse
proxy (Nginx, a managed cloud load balancer, or a container ingress)
directly in front of one or more Node processes**, never a Node process
directly exposed to the public Internet. In that topology:

```
Client -> [reverse proxy / managed load balancer / ingress] -> node server.js
```

Set `TRUST_PROXY=1` - Express then trusts exactly the *nearest* hop's
`X-Forwarded-For` entry (the proxy's own address is implicitly excluded;
Express walks the header from the right and trusts exactly N hops), which
correctly recovers the real client IP while still ignoring anything a
client tries to prepend to `X-Forwarded-For` itself. `TRUST_PROXY="true"`
(trust an unbounded chain) is accepted but always produces a startup
warning, since it re-opens the exact spoofing risk a specific hop count
avoids - only appropriate if the deployment topology genuinely has a
variable-depth trusted proxy chain (uncommon).

This project does **not** configure a provider-specific proxy (e.g. a
particular cloud vendor's exact header conventions) - `trust proxy`'s
hop-count semantics are Express's own standard mechanism and work
correctly behind Nginx, AWS/GCP/Azure's managed load balancers, and
Kubernetes ingress controllers alike, as long as each only adds/forwards
one `X-Forwarded-For` hop (the normal case).

### Health endpoints and trust proxy

`/health`, `/live`, and `/ready` are unauthenticated by design (see
`docs/production-healthchecks.md`) and do not depend on `req.ip` for
anything security-relevant - `trust proxy` misconfiguration cannot turn
them into a bypass for anything, since they carry no per-client rate
budget of their own beyond the general limiter (which fails safe: an
under-trusted proxy config makes the general limiter key by a *shared*
address, at worst rate-limiting too aggressively, never granting
unlimited access).

## What is validated vs. what is documentation-only

Validated by `lib/env.js` at startup (real, enforced): `FRONTEND_ORIGINS`
shape, `TRUST_PROXY` shape. The reverse-proxy *topology* itself (Nginx
config, TLS termination, header forwarding) is necessarily
documentation-only in this repository - see
`docs/production-sse-proxy.md` and `docs/nginx-example.conf` - since no
actual reverse proxy is deployed or deployable from this phase (per this
phase's explicit no-deployment rule).
