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
