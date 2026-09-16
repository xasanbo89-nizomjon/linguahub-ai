# Electron Distribution Checklist (Phase 9)

## Status: real runtime launch and real packaged build both now pass

Phases 7-8 established that this sandboxed session sets
`ELECTRON_RUN_AS_NODE=1`, which makes `electron.exe` run as plain Node
(`require("electron")` returns a path string, not the `{app, BrowserWindow}`
API), and correctly declined to work around it by touching a system-wide
setting. Phase 9 found the actual scope of that variable and used it.

## The fix: a scoped environment override, not a system change

```
$ [Environment]::GetEnvironmentVariable("ELECTRON_RUN_AS_NODE", "User")
(empty)
$ [Environment]::GetEnvironmentVariable("ELECTRON_RUN_AS_NODE", "Machine")
(empty)
```

`ELECTRON_RUN_AS_NODE` is **not** a persistent Windows User or Machine
environment variable - it's injected only into this specific process tree
(confirmed present in both the Bash/Git-Bash tool and a separately-invoked
PowerShell session). Because of that, a **scoped override** - a copy of
`process.env` with only that one key deleted, passed explicitly to a single
child-process launch - removes it for exactly one process without touching
any system-wide, User-level, or project-level configuration:

```js
const electronChildEnv = Object.assign({}, process.env);
delete electronChildEnv.ELECTRON_RUN_AS_NODE;
// ...
await electron.launch({ args: ["main.js"], env: electronChildEnv });
```

This is implemented in `e2e/electron.js` (dev-mode launch) and
`e2e/electron-packaged.js` (packaged-app launch). Verified incrementally
before trusting it for real testing:

1. `env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe --version` → real Electron version string (was previously a `TypeError`).
2. Direct `main.js` launch with the variable unset → real Chromium/Electron log lines.
3. Background launch with `--remote-debugging-port` → a real `DevTools listening on ws://...` endpoint appeared.
4. Playwright's `_electron.launch({ env: electronChildEnv })` → a real `BrowserWindow` opens.

## Real runtime verification: 23/23 pass

`node e2e/electron.js` launches the real Electron binary against the real
backend and exercises the actual app inside a real `BrowserWindow`:
real asset loading, real backend URL resolution (`file://` → `http://
127.0.0.1:3000`), zero requests to port 5500, a real end-to-end streaming
chat round-trip through the real OpenAI provider, Stop, Copy, Export,
Import, theme switching, both dialog types, LocalStorage persistence,
external-popup denial for untrusted origins, `nodeIntegration`/
`contextIsolation` genuinely verified from inside the renderer (no
`require`/`process` leak), and zero fatal console errors.

**One real bug found and fixed this phase**: Export silently failed inside
Electron (reported "Exported." but no file appeared). Root cause: Electron's
native download pipeline (`session.on('will-download')`) does not reliably
fire for `blob:` URL downloads triggered via `<a download>` - a known
Electron/Chromium limitation specific to blob URLs. Fixed in
`www/history-ui.js` by switching the export download to a `data:` URL
instead (same `<a download>` mechanism, but handled reliably by Electron's
downloader). Verified live: a real temporary download file now appears
after clicking Export. Full file-on-disk verification is **NOT RUN**
(Electron's default handling may then present a native OS "Save As" dialog,
which Playwright's page-level automation cannot drive) - stated plainly,
not worked around.

## Real package build: completed

```
$ npx electron-builder --dir --publish never
```

completed and produced a real, inspectable output:

| Artifact | Confirmed |
|---|---|
| `dist/win-unpacked/LinguaHub AI.exe` | exists, 204,521,984 bytes |
| `dist/win-unpacked/resources/app.asar` | exists, real (`npx asar list` returns 9,162 files) |
| Electron/Chromium runtime files (`.dll`, `.pak`, `resources.pak`, etc.) | present, real electron-builder output |

The Phase 8 packaging fixes remain intact and were re-verified this phase:
`electron`/`electron-builder` stay in `devDependencies` (not
`dependencies`, which electron-builder refuses to package from), and the
explicit `files` allowlist in `package.json`'s `build` config still
excludes `.env`, `@capacitor/**`, `@google/generative-ai/**`, and the
dev/test-only packages - confirmed via `docs/secret-scan-report.md`'s real
scan of the built `app.asar`, which found zero real secrets.

**This build previously failed** during this same phase, interrupted by an
`ENOTFOUND` error - see `docs/phase-09-real-environment.md`'s "Mid-phase
interruption" section for the full investigation. Conclusion: the
`ENOTFOUND` was almost certainly a transient interruption in the
assistant-to-Claude-API connection, not a failure inside this project or
electron-builder's own network access - nothing in this project's source
performs a DNS lookup that could produce that error, and the build's own
debug log shows no error at all, only a normal resolved file list. On
retry (network confirmed available, no lockfile touched, no dependency
reinstalled), the build completed in full, including the `winCodeSign`
download step that had hit a Windows symbolic-link-privilege limitation in
Phases 7-8 (`SeCreateSymbolicLinkPrivilege`, not held by this
non-administrator process account) - this time
`%LOCALAPPDATA%\electron-builder\Cache\winCodeSign` was populated
successfully (confirmed via direct inspection, timestamped to this build).
No installer was built and nothing was signed - `--dir --publish never`
produces only the unpacked directory, per this phase's explicit
never-deploy/never-sign instruction.

## Real packaged-app launch: 10/10 pass

`node e2e/electron-packaged.js` launches the **actual packaged
executable** (`dist/win-unpacked/LinguaHub AI.exe`, running from the real
`app.asar`, not the dev source tree) using the same scoped
`ELECTRON_RUN_AS_NODE` override:

| Check | Result |
|---|---|
| Packaged app launches for real | pass |
| Real `BrowserWindow` opens | pass |
| No blank screen - loads `app.asar://.../www/index.html` | pass |
| Real assets load from inside the packaged asar (mode selector populated) | pass |
| `config.js` still resolves `file://` to the local backend | pass |
| Real chat round-trip completes from the packaged app | pass |
| Theme switching works in the packaged app | pass |
| LocalStorage works in the packaged app | pass |
| No fatal console errors | pass |
| Screenshot captured | saved (`e2e/screenshots/electron-packaged-window.png`) |

No orphan `electron.exe`/`LinguaHub AI.exe` process and no listener on port
3000/5500 remained after any launch this phase (checked directly after
each run).

## Security checklist (unchanged from Phase 8, re-confirmed)

| Check | Status |
|---|---|
| `contextIsolation` enabled | verified (source + live: no `require`/`process` leak in the renderer) |
| `nodeIntegration` disabled | verified |
| No preload script (none needed - no custom IPC surface) | verified |
| No `ipcMain`/`ipcRenderer` usage | verified |
| No `child_process`/shell execution | verified |
| External links handled safely (`setWindowOpenHandler`, allowlisted) | verified live |
| Top-level navigation restricted (`will-navigate`, allowlisted) | verified (Phase 8 fix, re-confirmed) |
| No remote content loaded with Node privileges (`loadFile` only) | verified |

## Remaining known gap

- Full file-on-disk download verification after Export/native Save dialog:
  **NOT RUN** - a genuine Playwright/automation limitation (native OS
  dialogs cannot be driven page-level), not a product defect. The download
  pipeline itself is confirmed to engage correctly (see above).
- A full signed, distributable installer was never attempted - out of
  scope per this phase's explicit no-signing, no-deploy instruction.
