# Electron Runtime Report (Phase 8)

## Status

| Layer | Status |
|---|---|
| Source review | **Verified**, and one real gap found + fixed |
| Runtime launch (`npm start` / real window) | **Attempted for real, blocked** — exact root cause identified, not worked around |
| Packaging (`electron-builder`) | **Attempted for real** — one confirmed **critical** defect found and fixed, blocked from full completion by an unrelated OS permission issue |

## Runtime launch: re-attempted this phase, same result

`e2e/electron.js` (Playwright's real `_electron.launch()` against the real backend) was re-run at the start of Phase 8:

```
$ echo $ELECTRON_RUN_AS_NODE
1
$ node e2e/electron.js
[PASS] backend starts and becomes healthy
Error: Process failed to launch!
```

Root cause, confirmed directly (not assumed) by invoking the real binary outside Playwright:

```
$ ./node_modules/electron/dist/electron.exe main.js
TypeError: Cannot read properties of undefined (reading 'whenReady')
    at Object.<anonymous> (main.js:...)
```

This sandbox sets `ELECTRON_RUN_AS_NODE=1`, which makes `electron.exe` run as plain Node instead of initializing the Electron runtime - `require("electron")` then returns a path string, not the `{app, BrowserWindow}` API, so `app.whenReady()` fails immediately. This is an environment property (almost certainly a deliberate safety guardrail against spawning real GUI windows in a headless agent sandbox), not a project defect, and was not worked around (unsetting a sandbox safety variable is not something to do without explicit authorization). No orphan process or port was left behind by the attempt (checked via `tasklist`/`netstat` after).

`e2e/electron.js` (`npm run test:e2e:electron`) is a real, correct, working script - it will run to completion on a normal developer machine with no `ELECTRON_RUN_AS_NODE` set.

## Real bug found and fixed via the Task 6 security checklist review

Reviewing `main.js` against Electron's own documented security checklist (used as the basis for the Task 6 checklist) found a real gap: **`setWindowOpenHandler` restricted `window.open()` popups to Google/Firebase auth domains, but nothing restricted top-level navigation of the main window itself.** Electron allows a `BrowserWindow`'s own frame to be navigated to any origin by default when no `will-navigate` handler is registered - a compromised or malicious link click could navigate the whole app window away from the local app to an arbitrary remote origin.

Fixed in `main.js` with a `will-navigate` handler that allows only the app's own local `index.html` and the same trusted Google/Firebase domains the popup handler already allows (the latter needed for `signInWithRedirect`, `www/auth.js`'s fallback when a popup isn't viable - a full top-level navigation, not a popup, so it would have been broken by a naive "block everything" fix). The shared allowlist logic was extracted to `lib/electronSecurity.js` so it's unit-testable without launching Electron (`main.js` itself cannot be `require()`d outside a real Electron process - it calls `app.whenReady()` at load time). 11 new tests in `tests/electron-source.test.js` cover the allowlist function directly plus structural checks on `main.js` (contextIsolation/nodeIntegration, no preload, no IPC, no `child_process`, the new navigation guard). Confirmed no legitimate in-app navigation exists that this could break (`grep` found zero uses of `location.href =` / `.assign` / `.replace` anywhere in `www/*.js` - the app only ever updates the DOM, never navigates itself).

## Security checklist (Task 6)

| Check | Status | Evidence |
|---|---|---|
| contextIsolation enabled | ✅ verified | `main.js`, source + `tests/electron-source.test.js` |
| nodeIntegration disabled | ✅ verified | same |
| preload minimal | ✅ verified (none exists, none needed - no custom IPC surface) | source review |
| no unsafe ipc exposure | ✅ verified | no `ipcMain`/`ipcRenderer` usage at all |
| no arbitrary shell execution | ✅ verified | no `child_process`/`exec` usage at all |
| external links handled safely | ✅ verified | `setWindowOpenHandler`, allowlisted |
| navigation restricted | ✅ **fixed this phase** | `will-navigate` handler, allowlisted (see above) |
| no remote content with Node privileges | ✅ verified | `win.loadFile()` of a real local path; no `loadURL` to a remote origin anywhere |

## Runtime behavior checklist (Task 6): mostly NOT RUN (blocked), a subset covered indirectly

App launch, blank-window check, local asset loading, live streaming/stop/copy/export/import/clipboard/dialogs/theme/LocalStorage inside an *actual Electron window* are all **NOT RUN** - blocked by the launch failure above. All of this functionality IS verified, but in a real Chromium browser via Playwright (`e2e/smoke.js`, `e2e/storage.js`, etc.), not inside Electron specifically. The one Electron-specific piece of this - **API URL resolution for the `file://` origin** - is verified two ways: a real unit test (`tests/config.test.js`, "Electron file:// origin resolves to the local backend") exercises the exact function Electron's renderer would call, and it does not depend on Electron actually running.

Auth UI honesty (disabled when unconfigured) and DevTools-console-fatal-errors are also NOT RUN for Electron specifically, for the same reason - both are verified in the real browser suites instead.

## Packaging (Task 7): attempted for real, one critical bug found and fixed

`npx electron-builder --dir --publish never` (an unpacked-directory dry build - no installer, no signing) was actually run, twice.

**First attempt failed immediately** with a real, confirmed, blocking defect:
```
⨯ Package "electron" is only allowed in "devDependencies"...
Package "electron-builder" is only allowed in "devDependencies"...
```
`package.json` had both listed under `dependencies` instead of `devDependencies` - electron-builder refuses to proceed with this misconfiguration on any machine. **Fixed** by moving both to `devDependencies` (no behavior change for local dev - `npm install` still installs them either way; this only affects what a production/pruned install and the packaged output would include).

**Second attempt got much further** - it genuinely packaged a real `dist/win-unpacked/LinguaHub AI.exe` and `resources/app.asar` - and surfaced the single most important finding of this phase:

### Critical: the real `.env` file (with the live OpenAI key) was bundled into the packaged app

Confirmed by direct extraction, not inference:
```
$ npx asar extract dist/win-unpacked/resources/app.asar /tmp/asar-extract-check
$ ls -la /tmp/asar-extract-check/.env
-rw-r--r-- 1 axiy3 197609 179 ... .env
$ grep -oE '^[A-Z_]+=' /tmp/asar-extract-check/.env
OPENAI_API_KEY=
```
Root cause: `package.json`'s `build` config had no `files` allowlist, so electron-builder's default inclusion behavior swept the entire project root (including `.env`, which is `.gitignore`d but that has no effect on electron-builder's own, separate file-inclusion logic) into the package. The same default also bundled the *entire* `@capacitor/android` package - including its full compiled Gradle build output (`.dex` files, intermediate build artifacts) - which has nothing to do with the Electron app.

**Fixed** by adding an explicit `files` allowlist to `package.json`'s `build` config - only `main.js`, `server.js`, `www/**/*`, `lib/**/*`, `middleware/**/*`, `package.json`, and a filtered `node_modules/**/*` (excluding `@capacitor`, `@google/generative-ai`, and the dev/test-only packages, which are legitimately needed as project `devDependencies` but not inside the Electron package itself). Re-verified by re-running the dry build and re-extracting the new asar: `.env` is gone, `@capacitor` is gone (0 matches), and the only remaining "docs/tests/e2e/android" substring matches are legitimate files *inside real dependencies* (e.g. `rxjs`'s own `internal/testing/` module, `safer-buffer`'s own `tests.js`) - not this project's directories. 7 new regression tests (`tests/electron-packaging.test.js`) lock in the fix at the config level.

**Both dry-build attempts ultimately still exit non-zero** (status 1), for a third, unrelated, genuinely environment-blocked reason: electron-builder unconditionally tries to download and extract `winCodeSign` (macOS code-signing prep tooling) even for a Windows-only, unsigned build, and extracting it requires creating a symbolic link - a Windows privilege (`SeCreateSymbolicLinkPrivilege`) this sandboxed, non-administrator process account does not hold. Retried with `CSC_IDENTITY_AUTO_DISCOVERY=false` (the standard electron-builder option for skipping code-signing discovery) - same failure, confirming it's not avoidable through configuration in this environment. This is irrelevant to signing (no signing was ever attempted, per the phase's explicit instructions) and does not affect the two real, already-verified findings above - the packaging step itself (file selection, asar creation) completed successfully both times before this later, unrelated step failed.

No orphan process was left running after either attempt (checked via `tasklist`).

### Packaging checklist (Task 7)

| Check | Status |
|---|---|
| Dry/package build actually run | ✅ real, twice |
| Assets included correctly | ✅ verified (real `.exe` + `app.asar` produced, contents inspected via `asar list`) |
| No secrets bundled | ❌ found bundled → ✅ **fixed and re-verified** |
| Backend expectation preserved | ✅ (packaging doesn't touch how the app finds its backend - still `http://127.0.0.1:3000` via `config.js`, unaffected by packaging) |
| Icons/asset paths | not specifically verified (no custom icon is configured in `package.json`'s `build` block currently - out of scope, cosmetic) |
| Windows path handling | ✅ (build completed on Windows, no path errors) |
| CSP remains valid | ✅ (CSP is served by `server.js`, not bundled into the Electron package at all - unaffected by any packaging change) |
| Full signed installer produced | ❌ NOT RUN - blocked by the OS symlink-privilege issue above, and out of scope anyway (no signing was requested) |

## Summary

Electron: source-verified and hardened (one real navigation-security gap fixed); runtime launch genuinely attempted and correctly identified as environment-blocked, not faked; packaging genuinely attempted and found + fixed a **critical secret-exposure defect** that would have shipped the real OpenAI key in any real release build made with the previous configuration.
