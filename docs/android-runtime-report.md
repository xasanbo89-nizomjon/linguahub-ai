# Android Runtime Report (Phase 10)

## Status: toolchain confirmed working up to the SDK itself; runtime BLOCKED

This carries forward Phase 9's finding (`docs/android-capacitor-checklist.md`)
with a full, explicit toolchain inventory re-run this phase per the Phase
10 task list, plus disk/virtualization checks that weren't captured before.

## Toolchain inventory

| Tool | Result |
|---|---|
| `java -version` | `openjdk version "21.0.11"` (Microsoft build) - present |
| `javac -version` | `javac 21.0.11` - present (full JDK, not JRE-only) |
| `ANDROID_HOME` | unset |
| `ANDROID_SDK_ROOT` | unset |
| `adb` | not found on PATH |
| `emulator` | not found on PATH |
| `sdkmanager` | not found on PATH |
| `avdmanager` | not found on PATH |
| Android Studio | not installed (`C:\Program Files\Android\Android Studio` does not exist) |
| SDK directory | does not exist (`%LOCALAPPDATA%\Android\Sdk` absent) |
| Connected devices | none (no `adb`, no device, no emulator) |
| Existing AVDs | none (no SDK, so no AVD manager exists to have created any) |
| Gradle (project's own wrapper) | **works** - `gradle-8.14.3-all.zip` downloads and runs correctly |
| Android Gradle Plugin | **works** - `com.android.tools.build:gradle:8.13.0` resolves correctly from Google's Maven repo |
| `com.google.gms:google-services:4.4.4` | **works** - resolves correctly (already on the root buildscript classpath, pre-dating this phase) |
| Capacitor CLI (`npx cap sync android`) | **works** - copies web assets, updates plugins, regenerates `capacitor.config.json` inside the Android project |
| Disk space (`C:`) | 184.02 GB free - ample for a full SDK + emulator + system image (~10-15GB) |
| CPU virtualization firmware | **enabled** (`VirtualizationFirmwareEnabled: True`) - hardware-accelerated emulation would be usable if the SDK/emulator were installed |

`android/local.properties`'s `sdk.dir` still references
`C:\Users\Hp\AppData\Local\Android\Sdk` - a stale path from a different
Windows user profile that does not exist on this filesystem (re-confirmed
this phase, unchanged from Phase 9).

## Real build attempt

```
$ ./gradlew assembleDebug --stacktrace
...
Caused by: com.android.builder.errors.EvalIssueException: SDK location not
found. Define a valid SDK location with an ANDROID_HOME environment
variable or by setting the sdk.dir path in your project's local
properties file at '...\android\local.properties'.
BUILD FAILED
```

Real, exact, direct error from the Android Gradle Plugin's own
`SdkLocator` - re-confirms Phase 9's finding. The **only** missing piece is
the physical SDK installation; every layer above it (Java, Gradle, AGP,
Capacitor's own tooling) is confirmed working.

## What installing the SDK would require (documented, not installed)

Per this phase's explicit instruction not to silently install large,
system-wide tooling without existing support (none exists here - no
Android Studio, no SDK, no prior partial install), this was **not**
attempted. Exact components, chosen to match this project's real Gradle
configuration (`android/variables.gradle`: `compileSdk=36`, `minSdk=24`,
`targetSdk=36`; AGP `8.13.0`; Gradle `8.14.3`, already confirmed to work):

```
sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0" \
  "emulator" "system-images;android-36;google_apis;x86_64"
avdmanager create avd -n LinguaHub_Test -k "system-images;android-36;google_apis;x86_64"
```

If `build-tools;36.0.0` or the API 36 system image is not yet published in
the SDK repository at install time, the next-nearest available stable
build-tools/system-image version should be substituted - `compileSdk`/
`targetSdk` in the project only require the **platform** jar to match 36;
the actual **emulator system image** does not need to be identical to
`compileSdk`, only `>= minSdk (24)` and reasonably current for realistic
testing. This is stated as guidance, not a fixed guess, per this phase's
explicit "do not guess incompatible versions" instruction.

Then, to point Gradle at it without touching any committed file:
```
$env:ANDROID_HOME = "<sdk path>"
# or write android/local.properties (already .gitignore'd) with the real
# sdk.dir for this machine specifically - never commit a machine-specific
# path, which is exactly the stale-path problem found above.
```

## Runtime checklist (Task 12 items 1-26): all NOT RUN

App install, launch, blank-screen check, splash/loading state, safe-area
layout, sidebar drawer, composer-above-keyboard, keyboard resize, New
Chat, conversation list, streaming, Stop, Markdown, code blocks, Copy,
clipboard, themes, history-survives-restart, mode selection, no-port-5500,
production-config-not-localhost, cleartext-dev-only, Android back button,
app resume, orientation change, network-failure-UI-recovery: **none of
these were run**. No emulator or device exists in this environment. This
is stated plainly - none of these is claimed as passing, and no
screenshots were taken (nothing was running to screenshot).

## Real Capacitor Google login (Task 13): all items NOT RUN, for the same reason

Native login control activation, account chooser, login completion,
avatar/name/email rendering, token retrieval, backend verification,
`/api/auth/me`, restart persistence, logout, namespace isolation on
device, and log-inspection for token leakage: **none of these were
exercised on a device**. The adapter code implementing all of this exists
and is unit-tested (`docs/capacitor-native-auth.md`,
`tests/native-auth-adapter.test.js`) but that is explicitly **not** a
substitute for device verification, and is never presented as one here.

## Summary

Identical bottom line to Phase 9, now with a complete, explicit toolchain
inventory: every layer of the Android toolchain below the SDK itself is
confirmed real and working on this machine. The Android SDK installation
is the one missing prerequisite, and every check that depends on it is
honestly marked NOT RUN, not PASS.
