# CI Desktop-Test Flake — Root Cause Analysis (2026-05-29)

## TL;DR

A PR that touched `apps/desktop` (#1080, the 2026 frontier-model refresh) turned
the desktop package into an "affected" package for the first time since the CI
was rewritten. That exposed **three latent defects** in the rewritten pipeline,
all related to how the Electron/Playwright binaries are (not) provisioned:

1. **Desktop unit tests loaded the real `electron` module**, which throws when
   its prebuilt binary isn't on disk — and the affected-only Unit/Coverage jobs
   never provisioned it.
2. **The Web/Desktop E2E jobs downloaded Playwright browsers from
   `cdn.playwright.dev` at job time**, and that download stalled at 100% with no
   client-side timeout, hanging the job until its cap.
3. **The Desktop E2E job never reliably provisioned the real Electron binary**;
   `electron/install.js` silently fails to extract on an `@electron/get` cache
   hit, so `_electron.launch` threw "Electron failed to install correctly".

None of these were caused by #1080's code — #1080 only changed model-ID strings.
It was the trigger that made the latent CI gaps run for the first time.

All three are now fixed and verified green on both `#1081` (merged to `main` as
`986f33a5e`) and `#1080`.

---

## How it got into the pipeline

The CI was rewritten from a bespoke "planner / proof-routing" system to plain
GitHub Actions workflows over a series of PRs. The relevant commits on
`.github/workflows/test.yml`:

| PR | Commit | Change | Defect introduced |
|----|--------|--------|-------------------|
| #1061 | `73fe6e6d8` | "replace custom planner with native workflows" | E2E jobs do `playwright install --with-deps chromium` at job time (CDN download); Desktop E2E relies on a cache-only Electron provisioning |
| #1065 | `60a11dd80` | scope PR coverage to directly-changed packages | — |
| #1066 | `9cd0c3007` | affected-only Unit via `pnpm --filter "...[origin/$BASE_REF]"` | Unit/Coverage run desktop tests **without** any Electron-binary provisioning |
| #1067 | `3974a02ec` | replace bespoke pnpm cache pattern | — |
| #1068 | `701dfdaea` | bump Unit timeout 30→45m | — |

Only the **Desktop E2E** job cached `~/.cache/electron`; the affected-only Unit
and Coverage jobs had no Electron handling at all. This was invisible because no
PR had made `apps/desktop` "affected" — so the desktop unit tests simply never
ran in those jobs on a PR.

### Why it stayed latent and what surfaced it

`pnpm --filter "...[origin/$BASE_REF]"` only runs tests for changed packages and
their dependents. Until #1080, no PR changed `apps/desktop` (or a package it
depends on in a way that pulled desktop in), so the desktop unit tests were
never selected, and the desktop E2E smoke either wasn't exercised on the failing
path or passed on a warm cache. #1080 edited model-ID strings in three files
under `apps/desktop`, making the desktop package affected → its unit tests ran
(no Electron binary → crash) and its E2E ran on a cold cache (Playwright stall +
Electron-extraction failure).

---

## Root cause #1 — desktop unit tests require the Electron binary

`node_modules/electron/index.js` exports **only the path to the prebuilt
binary** and `throw`s `"Electron failed to install correctly"` when that binary
is absent. The runtime named exports (`app`, `ipcMain`, `safeStorage`, …) only
exist inside the Electron runtime, which is why every desktop test already does
`vi.mock('electron', …)`. But Vitest still *resolved and evaluated* the real
module — both for externalized consumers (`electron-store`) and during
`vi.mock('electron')` resolution — so the absent binary crashed the test files
before any mock applied.

**Fix** (`apps/desktop/vitest.config.mts`, `src/__tests__/electron-test-stub.mts`,
`src/__tests__/setup.ts`):
- Alias `electron` to an inert stub via `resolve.alias`.
- Add `server.deps.inline: ['electron']` so the alias also applies during
  `vi.mock('electron')` resolution and for externalized consumers.
- Mock `electron-store` globally (its module body destructures
  `const {app, ipcMain, shell} = electron` at import time).

Result: desktop unit tests are fully **binary-independent** — verified by hiding
the local Electron binary and running the whole suite (121 files / 1027 tests)
green.

---

## Root cause #2 — Playwright CDN browser download hangs at 100%

Both E2E jobs ran `playwright install --with-deps chromium` at job time. On a
cold runner the Chrome-for-Testing download reached **100% and then hung in total
silence** (no client-side stream-end), so the step ran until the 15-/25-minute
job cap and the smoke step never executed. Retrying did not help — a cache is
only populated by a successful install, and every attempt hung.

**Fix**:
- **Web E2E** now runs inside `mcr.microsoft.com/playwright:v1.59.1-noble` with
  `options: --user 1001` (per Playwright's official GitHub Actions container
  example) — browsers are preinstalled in the image, so there is **no
  `playwright install` and no CDN download** at job time.
- **Desktop E2E** drives the app via Playwright's Electron API
  (`_electron.launch`), which uses the app's own bundled Electron/Chromium — it
  never needed the Playwright Chromium browser at all. It now only runs
  `playwright install-deps chromium` (apt system libraries, no CDN browser
  download).

---

## Root cause #3 — Electron binary never extracted for Desktop E2E

The Desktop E2E smoke kept failing with "Electron failed to install correctly"
even after adding an explicit `node node_modules/electron/install.js` step that
**exited 0**. Reproduced locally and traced with `DEBUG=@electron/get:*`:

```
@electron/get:index Checking the cache (...) for electron-v41.2.1-...zip
@electron/get:index Cache hit
exit=0          # <-- no extraction, dist/ and path.txt never written
```

`electron/install.js` runs `downloadArtifact(...).then(extractFile)` as an
**un-awaited floating promise**. On a cache *hit* there is no network I/O to keep
the event loop alive, and the `extract-zip` extraction never completes before the
process exits 0. The binary is therefore never extracted, even though the step
"succeeds". (A plain system `unzip` of the very same downloaded zip extracts it
correctly.)

**Fix** (Desktop E2E job): bypass `install.js` entirely — download the prebuilt
`electron-v<ver>-linux-x64.zip` directly from **GitHub Releases** (a reliable
host, not the Playwright CDN) and extract with the system `unzip`, then write
`path.txt` and **hard-verify** the executable exists before launching the smoke:

```bash
VER=$(node -p "require('electron/package.json').version")
DIR=$(node -p "require('path').dirname(require.resolve('electron/package.json'))")
curl -fsSL --retry 3 -o "$RUNNER_TEMP/electron.zip" \
  "https://github.com/electron/electron/releases/download/v${VER}/electron-v${VER}-linux-x64.zip"
rm -rf "$DIR/dist" "$DIR/path.txt"; mkdir -p "$DIR/dist"
unzip -q -o "$RUNNER_TEMP/electron.zip" -d "$DIR/dist"
printf 'electron' > "$DIR/path.txt"
node -e "const fs=require('fs');const p=require('electron');fs.accessSync(p);console.log('Electron binary present at '+p)"
```

The verification step means a future provisioning gap fails **loudly at this
step** instead of cryptically inside a test.

---

## Verification

- **Desktop unit suite** passes with the local Electron binary deliberately
  hidden (mirrors the CI cache-miss): 121 files / 1027 tests green.
- **`#1081`** (`cf00ff227`): all jobs green — Web E2E ✅, Desktop E2E ✅ (10/10
  smoke). Merged to `main` as `986f33a5e`.
- **`#1080`** (`f13c5f998`): all jobs green — Web E2E ✅, Desktop E2E ✅ (10/10
  smoke).

---

## Prevention / follow-ups

1. **Electron binary is now provisioned explicitly and verified** in Desktop
   E2E; the unit jobs no longer need it at all. The "hard verify" guarantees a
   loud, early failure if provisioning ever regresses.
2. **No job downloads Playwright browsers from the CDN at job time** — Web E2E
   uses the pinned official image; Desktop E2E uses Electron's own binary.
3. **Keep the Playwright image tag in lockstep** with `@playwright/test` in
   `package.json` (currently `v1.59.1-noble`). A version-assertion CI step would
   make drift impossible — recommended follow-up.
4. **Low-priority hardening** (deferred): use `${RUNNER_TEMP:-/tmp}` in the
   Electron provisioning step so it survives a future move into a container.
5. **Consider** keeping CI-infrastructure changes in their own PR (separate from
   feature work) so an infra rollback doesn't also roll back a feature — this
   round bundled them for speed under time pressure.
