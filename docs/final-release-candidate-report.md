# Final Release Candidate Report

## RC identity

| Field | Value |
|---|---|
| RC version | **1.0.0-rc.1** (`package.json`'s `version` field, bumped this phase from `1.0.0`) |
| Product name | LinguaHub AI |
| Build date | 2026-08-07 |
| Commit status | This working directory is a git repository with **no commits** (`git log` → "No commits yet"). No commit was created this phase or any prior phase, per every phase's standing instruction. The RC is defined by the state of the working tree at the time this document was written, not a commit hash. |
| Test baseline | 402/402 unit tests, all 10 real-browser e2e suites, Electron dev-mode 23/23, Electron packaged 9/10 (one pre-existing, non-code environment finding), 0 real secrets |
| Node.js target | v24.18.0 (this environment) - `package.json` declares no explicit `engines` field; recommend adding one in a future phase if a specific minimum needs enforcing, not invented here |
| Versioning scheme | Standard [SemVer](https://semver.org/) with a `-rc.N` pre-release suffix, matching `package.json`'s existing plain `major.minor.patch` style - no new/different scheme introduced |

## Supported targets

| Target | Status |
|---|---|
| Web (guest mode) | READY |
| Web (authenticated) | BLOCKED - no real Firebase project |
| Electron desktop (Windows, unsigned/internal) | READY |
| Electron desktop (signed installer) | BLOCKED - no code-signing certificate |
| Android (Capacitor) | BLOCKED - no Android SDK/device |
| Docker/container | CONFIGURED, NOT RUN - Docker not installed in this environment |

## Known blockers at RC time

See `docs/final-known-blockers.md` for the complete, itemized list. In
summary: real Firebase project, real Android SDK/device, code-signing
certificate, real production domain/TLS, active monitoring backend, and
the Redis shared rate-limit store are all still not provisioned - every
one is an external-infrastructure/credential dependency, not an
unfinished code path.

## What changed to produce this RC (Phase 12 specifically)

Phase 12 made **no functional code change** to the application - it is
an audit phase, and the audit found no confirmed defect requiring one.
The only repository changes this phase are: `package.json`'s `version`
field (RC designation) and the documentation files listed in this
phase's report. Every fix that produced the code this RC is built from
was made in Phases 1-11, each independently documented in its own
`docs/phase-0N-*.md`.

## Why "-rc.1" and not "1.0.0" plain

A real `1.0.0` release should follow a real deployment + rollback
rehearsal against actual production infrastructure (a real domain, real
TLS, ideally a real Firebase project) - none of which has happened yet
(explicitly out of scope for every phase through 12, all of which
forbid deployment). `-rc.1` accurately signals "this is the first
candidate believed ready for that next step," not "this has already been
run in production."

## Do not publish

This RC was not published, tagged, or pushed anywhere - `package.json`'s
version bump exists only in this local working tree, per this phase's
explicit no-publish rule.
