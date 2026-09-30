# Desktop Electron provisioning — evidence

Supports `docs/agents/ci-quality.md` § "Desktop Electron provisioning" (BST-563,
BST-1252). Read this before changing how any CI job obtains the Electron
binary, or before restoring an Electron cache. The contract holds the rules;
this file is the record of why.

Both Desktop E2E smoke lane jobs in `test.yml` and both regression jobs in
`desktop-e2e.yml` download Electron directly from GitHub Releases and extract
it immediately before launch. Electron 43 declares no install lifecycle;
`install.js` is exposed only as the `install-electron` bin, so `pnpm install`
does not provision the executable or populate `~/.cache/electron`. The former
version lookup and Actions cache steps therefore persisted an unused path. Each
download uses `${RUNNER_TEMP:-/tmp}/electron.zip`; the fallback is required
because a future `container:` job may not define `RUNNER_TEMP`. The paired
`desktop-electron-provisioning-contract.test.mjs` keeps all four sites aligned,
pins the no-lifecycle premise, requires all four jobs to use the shared
`setup-workspace` action, and fails if the unused cache or raw `RUNNER_TEMP`
path returns.

The `Native Electron Package` job has a separate packaging need: its native
smoke launches Electron before electron-builder runs, and electron-builder
otherwise fetches the same release archive again. It now provisions one
`${RUNNER_TEMP:-/tmp}/electron.zip` before either consumer, bounds each transfer
to three minutes, retries transfer errors three times with a visible failure
after exhaustion, verifies the extracted executable is non-empty and runnable,
and passes that same zip to electron-builder through
`config.electronDist`. This keeps one bounded, observable download boundary and
does not restore the obsolete `~/.cache/electron` Actions cache.

## Actual Linux AppImage qualification (BST-1898, 2026-09-30)

Unpacked native CI did not exercise the AppImage runtime, embedded desktop
launcher, or replacement of two artifact byte streams. The procedure in
`docs/linux-appimage-qualification.md` and its script guard fill that bounded
gap without claiming a mounted/clean-desktop or released-version migration pass.

The pinned builder's embedded desktop entry defaulted to `--no-sandbox`.
The package config removes that default; the harness also inspects actual output
and rejects an unsafe candidate entry before any lifecycle launch. An older
baseline's desktop entry remains recorded for provenance. Its direct AppImage
launch still has to pass the same namespace and live process-argument checks.
An AppRun mentioning its conditional fallback is not itself rejected: the
prelaunch probe and live process checks establish whether the fallback ran.

The production secrets service already rejects `basic_text`, but arbitrary
older artifacts need independent evidence too. The credential-file check now
requires Linux synchronous OSCrypt's `v11` envelope and rejects the hardcoded-key
`v10` fallback, malformed data and unknown formats. See the
[Chromium format rationale](https://codereview.chromium.org/1973483002/) and
[Electron Linux semantics](https://www.electronjs.org/docs/latest/api/safe-storage).
This is format evidence combined with successful production bridge reads after
restarts, not cryptographic validation of arbitrary supplied ciphertext.
Desktop/session-selection variables are forwarded so KDE's wallet selection
retains the real session context. No new product IPC or password-store override
is introduced. Changes to the synchronous storage format require explicit
requalification rather than silently accepting a new prefix.
