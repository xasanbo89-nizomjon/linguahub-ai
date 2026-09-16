# Electron Verification (Phase 7)

## Status summary

| Layer | Status |
|---|---|
| Source review | **Verified** |
| Runtime (`npm start` / `electron .` dev flow) | **Attempted — blocked by this session's sandbox**, see below |
| Packaged build (`electron-builder`) | **NOT RUN** — out of scope for this phase (see "Packaging" below) |

## What was actually run

A dedicated script, `e2e/electron.js`, was written to genuinely launch the real `main.js` via Playwright's built-in Electron support (`playwright`'s `_electron.launch()`), against the real backend, and exercise the real renderer window (load, mode-selector population, a real chat round-trip, and a `nodeIntegration`-leak check) — this is the correct way to verify Electron at the runtime level rather than trusting source alone.

It could not complete in this session. The root cause was isolated precisely (not assumed):

```
$ echo $ELECTRON_RUN_AS_NODE
1
$ ./node_modules/electron/dist/electron.exe main.js
TypeError: Cannot read properties of undefined (reading 'whenReady')
    at Object.<anonymous> (main.js:30:5)
```

This session's sandboxed execution environment sets `ELECTRON_RUN_AS_NODE=1`. With that variable set, the `electron` binary runs as a plain Node.js process instead of initializing the Electron runtime — `require("electron")` then returns a path string instead of the `{ app, BrowserWindow, ... }` API object, so `main.js`'s `app.whenReady()` fails immediately. This is a deliberate safety property of the sandbox (almost certainly there specifically to stop tools from spawning real GUI windows in a headless agent environment), not a bug in this project, and not something that should be worked around by unsetting a sandbox safety variable.

**`e2e/electron.js` is a real, working verification script** — run it with `npm run test:e2e:electron` on a normal developer machine (no `ELECTRON_RUN_AS_NODE` set) to get genuine runtime verification, including a screenshot of the actual window. It was not possible to execute it to completion in this session.

## What was verified by source review (all confirmed present and correct)

- **`nodeIntegration: false`, `contextIsolation: true`** (`main.js`) — the modern, secure default combination. No `preload` script is registered, and none is needed: the renderer has no custom IPC surface to expose (the app talks to the backend over plain HTTP, not Electron IPC), so the safest configuration here is *no* preload attack surface at all, not a missing one.
- **Popup handling**: `win.webContents.setWindowOpenHandler(...)` allows `window.open()` only for `https://accounts.google.com/` and `https://*.firebaseapp.com/` — every other popup target is denied. This is what lets Firebase's `signInWithPopup` work under Electron (which denies all popups by default with no handler) without opening a general-purpose popup hole.
- **`file://` origin → local backend**: `www/config.js`'s `computeApiBase()` explicitly resolves `protocol === "file:"` to `DEV_BACKEND_DEFAULT` (`http://127.0.0.1:3000`). This is unit-tested (`tests/config.test.js`, "Electron file:// origin resolves to the local backend") and passes.
- **Local asset loading**: `main.js` uses `win.loadFile(path.join(__dirname, "www", "index.html"))` — a real local file path, not a hardcoded string that could break depending on packaging/working directory.
- **Backend process expectation**: Electron does not start the backend itself — `package.json`'s `start` script runs `concurrently "node server.js" "electron ."`, i.e. the backend is a sibling process, matching how `www/config.js` expects to find it (`http://127.0.0.1:3000`, independent of how the renderer itself was loaded).
- **Download/export behavior**: the app's export flow (`www/history-ui.js`) uses a standard `Blob` + `<a download>` click, which Electron's default `will-download` handling processes like any other Chromium download (saves to the OS Downloads folder unless configured otherwise) — no custom download handler exists or is needed for this simple case.
- **Clipboard behavior**: the app uses the standard `navigator.clipboard` Web API (`www/app.js`'s `copyText()`), which Electron's renderer supports natively with no extra permission wiring required (Electron doesn't gate `navigator.clipboard.writeText` behind a permission prompt the way some other embedders do).

## Packaging (`electron-builder`)

Not run in this phase — this was explicitly out of scope per the phase instructions ("Do not package a release unless existing scripts already support it and this can be done safely"). `package.json`'s `build` script and `build` config block (`appId: com.xasan.ai`, NSIS target) exist and were reviewed but not exercised; producing an actual installer is a packaging/release action, not a QA verification action, and wasn't requested.

Note: `package.json`'s `name` and `build.appId` still read `"xasan-ai"` / `"com.xasan.ai"` — a pre-existing leftover from before the LinguaHub AI rename (Phase 1), unrelated to this phase's scope. Not changed here since it's an internal package identifier with no user-facing or security impact, and renaming it is a product decision, not a confirmed defect.
