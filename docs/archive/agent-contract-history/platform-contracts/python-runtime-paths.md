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

## Linux x64 extension (2026-09-30)

The resolver now maps Linux x64 to `x86_64-unknown-linux-gnu`; Linux arm64
and other unsupported architectures still fail before manifest I/O. The
installation remains under userData on both platforms. The real-archive
integration test invokes `resetDesktopApplicationData` against a temporary
profile, observes deletion of the installed binary, and resolves and executes
it again from the immutable resource archive without fetch or PATH Python.
See `docs/archive/agent-contract-history/code-execution/bundled-linux-python.md` for provenance and limits.

## Superseded (BST-1627)

The runtime unpack this record describes was retired: the interpreter is now
unpacked at build time and ships as loose files. See
[python-build-time-unpack](../code-execution/python-build-time-unpack.md).
