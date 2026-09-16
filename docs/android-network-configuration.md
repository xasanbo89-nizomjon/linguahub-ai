# Android Network Configuration (Phase 10)

## Real bug found and fixed: the Android emulator can't reach 127.0.0.1

`www/config.js`'s `computeApiBase()` previously treated Capacitor's default
Android WebView origin (`https://localhost`, no port) the same as Electron
(`file://`) and Capacitor iOS (`capacitor://localhost`) - all three fell
back to `DEV_BACKEND_DEFAULT = "http://127.0.0.1:3000"`.

That's correct for Electron and the iOS Simulator, which share the host
machine's own network namespace. It is **wrong** for the Android emulator:
the emulator is its own virtual machine, so `127.0.0.1` inside it refers to
the emulator itself, not the host machine running the backend. A real
Android emulator running this app's debug build would never have been
able to reach the dev backend through the auto-detected default.

**Fixed** in `www/config.js`: Android's default-host branch now returns a
new constant, `ANDROID_EMULATOR_BACKEND_DEFAULT = "http://10.0.2.2:3000"`
- `10.0.2.2` is the standard, documented Android-emulator-only alias that
routes to the host machine's own `127.0.0.1`. Electron and iOS are
unaffected (a separate, still-`127.0.0.1` code path, distinguished by
`protocol` - `file:`/`capacitor:` vs the Android-only `https://localhost`
combination). Locked in by new tests in `tests/config.test.js`.

## The three real-world network scenarios

| Scenario | What reaches the backend | Mechanism |
|---|---|---|
| **Android emulator**, local dev backend | `http://10.0.2.2:3000` | Automatic (the fix above) - no configuration needed |
| **Physical Android device**, local dev backend | The host machine's real LAN IP (e.g. `http://192.168.1.50:3000`) | **Must be set explicitly** - `10.0.2.2` only means anything inside the emulator's virtual NAT; a real device has no way to reach it. There is no way to auto-detect the host's real LAN IP from inside a WebView, so this requires an explicit `window.LINGUAHUB_CONFIG = { API_BASE_URL: "http://<host-LAN-IP>:3000" }` override, set in an inline `<script>` before `config.js` loads (the existing, already-supported override mechanism - see `www/config.js`'s own header comment) |
| **Production Android build** (release APK, real users) | A real HTTPS backend URL | **Must be set explicitly**, same mechanism. Capacitor's default WebView origin (`https://localhost`) is identical in a debug and a release build - there is no way to distinguish "dev" from "production" purely from the page's own origin. A production build that ships without setting this override would silently fall back to `10.0.2.2:3000`, which resolves to nothing meaningful outside an emulator. **This is a real, concrete pre-launch requirement for any Android release**, not a hypothetical - documented here so it is not missed. |

## Why this wasn't "fixed" by inventing an environment-detection mechanism

There is no reliable way for client-side JS running inside a Capacitor
WebView to distinguish "this is a debug build talking to a dev backend"
from "this is a release build that forgot to configure its production
URL" - both present the exact same origin. Building a heuristic to guess
would risk exactly what `www/config.js`'s own design principle already
rejects ("never falls back to a hardcoded localhost URL for a non-loopback
production origin" - see the file's header comment, describing the
same-origin web case). The correct fix, consistent with the existing
architecture, is what's already there: an explicit override takes
absolute priority over any auto-detected default, and this document exists
so a future release build actually sets it.

## CORS implications

`server.js`'s `DEFAULT_ALLOWED_ORIGINS` already includes `capacitor://localhost`
and `http://localhost` - the two origins Capacitor's default iOS/Android
WebView use. A production deployment additionally needs its real frontend
origin(s) added via the `FRONTEND_ORIGINS` environment variable (already
documented in `.env.example`) - unrelated to the API-base-URL fix above,
but required together for a production Android build to actually complete
requests once it points at the real backend.

## Cleartext (plain HTTP) policy

`android/app/src/main/AndroidManifest.xml` sets no
`android:usesCleartextTraffic` and references no custom
`network_security_config.xml` - Android's own default therefore applies:
**cleartext HTTP is blocked by default on API 28+** (this project's
`minSdk` is 24, but the *device's* OS version at runtime is what matters
here, not the app's `minSdk`). This is a real, unresolved gap specifically
for local development against an `http://` dev backend from a real device
or emulator with a modern Android OS - it would need an explicit
dev-only network security config to allow cleartext, scoped narrowly
(e.g. only to `10.0.2.2`/the dev LAN IP) so it never accidentally applies
to a release build. **Documented, not fixed** - it can't be verified
without a real device/emulator, and touches native Android XML this
project has never needed before. A production backend must be served over
HTTPS regardless (an infrastructure requirement, not something this fix
would change).

## No arbitrary URL setting exposed to users

The `API_BASE_URL` override is a build-time/deploy-time configuration
value (set in source before the app ships), never a runtime user-facing
setting - there is no UI anywhere in this app that lets an end user change
which backend it talks to. Confirmed by source review: `www/settings-ui.js`
exposes only theme/font/enter-to-send preferences, nothing network-related.
