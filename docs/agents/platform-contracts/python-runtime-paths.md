# Bundled Python runtime: unpack dir vs resources dir — evidence

Supports `docs/agents/platform-contracts.md` § "FACTORY RESET CONTRACT".
Read before moving the CPython unpack directory or changing how `resolveDesktopPythonRuntimeResourcesDir` finds its manifest. The contract holds the rules; this file is the record behind them.

Everything below is extracted verbatim from the contract as it stood before
distillation (2026-09-21). Corrections verified against the code today are
marked inline as **CORRECTION (2026-09-21)**; nothing else is rewritten.

---
Desktop bundled Python runtime (BST-1061): `resolvePythonBinary` unpacks the
pinned CPython under `app.getPath('userData')/python-runtime/`, so the
wholesale userData wipe in `desktop-factory-reset.ts` covers it with zero
dedicated wiring. That coverage is pinned by the BST-1061 regression test in
`apps/desktop/src/__tests__/main/desktop-factory-reset.test.ts` — if the
unpack dir ever moves outside userData, it needs explicit reset wiring plus an
update here.

`resolveDesktopPythonRuntimeResourcesDir` (`apps/desktop/src/python-runtime/
index.ts`) resolves the SOURCE directory the archive/manifest ship in — a
different, unrelated path from the unpack dir above — and is where BST-1459
found a real bug: it used to derive this from `app.getAppPath()`, which
returns a launch-mode-dependent value (the project root under `electron .`,
but `dist/` itself when Electron is launched with a direct path to
`dist/main.js`, as Playwright's desktop e2e harness does), silently pointing
at `dist/resources/python-runtime/manifest.json` instead of the real
`apps/desktop/resources/python-runtime/manifest.json`. It now resolves via
the running bundled module's own `__filename` instead (same invariant as the
two entries below — deliberately NOT `module.filename`, a synthetic shim
with no `.filename` under Vitest, or `import.meta.filename`, empty in this
file's esbuild `cjs` output; see `bundled-sibling-path.ts`'s docblock),
taking `path.dirname()` TWICE — once to `dist/` (the module's immediate
parent), once more to its parent `apps/desktop/` — because these resources
are a sibling of `dist/`, not of `main.js` itself. This resolver additionally
depends on that immediate parent directory being literally NAMED `dist` — an
IDENTITY check on that one path segment, not a depth check (e.g.
`out/dist/main.js` still resolves correctly; only the parent's basename is
compared, not how many levels it sits below the app root) — which is still
more fragile than the sibling-of-`main.js` pattern the watchdog/log-transport
resolvers use below, since those need no name assumption at all. This one
enforces the identity assumption at runtime: it throws if that parent
directory is not literally named `dist`, rather than silently pointing at the
wrong directory if the bundle output is ever restructured or renamed. Pinned
by `apps/desktop/src/__tests__/main/python-runtime-resources-dir.test.ts`.
Downstream, `resolvePythonBinary` classifies unsupported platforms BEFORE any
manifest I/O — off darwin no target triple exists, so the manifest is never
read and the result is the typed `python_unsupported_platform` condition with
no PATH-Python fallback (pinned by the fixture-less unsupported-platform case
in `apps/desktop/src/__tests__/main/resolve-python-binary.test.ts`).

---
## Reshaped by the build-time unpack (BST-1627, PR #2958)

Everything above describes the runtime-unpack design, in which the CPython lived
under `userData/python-runtime/`. That path no longer exists: the interpreter is
unpacked at build time and ships in the bundle (see
`code-execution/python-build-time-unpack.md`), so `resolvePythonBinary` writes
nothing under `userData` and factory reset has no runtime CPython state of ours
to remove.

- The wholesale userData wipe still sweeps a `userData/python-runtime` left
  behind by a pre-BST-1627 install. The BST-1061 regression test in
  `apps/desktop/src/__tests__/main/desktop-factory-reset.test.ts` now pins that
  legacy-directory sweep, so `python-runtime` must never join the preserved
  siblings.
- `resolveDesktopPythonRuntimeResourcesDir` resolves the directory the MANIFEST
  ships in (still by the bundled module's own `__filename`, twice `dirname`,
  `dist` identity check). The new sibling `resolveDesktopPythonRuntimeInstallDir`
  derives the per-arch unpacked tree from it: `unpacked/<arch>` in development,
  the same directory when packaged. It only derives a path; an unsupported arch
  is classified by `resolvePythonBinary`, not there.
