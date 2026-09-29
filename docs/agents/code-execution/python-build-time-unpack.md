# Bundled CPython: build-time unpack, not runtime — evidence

Supports `docs/agents/code-execution.md` § "FenceExecutor". Read this before
moving the CPython unpack back to runtime, shipping the tarball, or changing the
sentinel/manifest contract. The contract holds the rules; this file is the
record of why.

## Rule

The interpreter is unpacked once, at build time, by
`apps/desktop/scripts/fetch-python-runtime.mjs`, into
`resources/python-runtime/unpacked/<electron arch>/`, and the loose tree ships
in the bundle. `resolvePythonBinary` never extracts, hashes or stages anything:
it reads the sentinel, compares it with the manifest's pinned sha256, and checks
that `python/bin/python3` is executable.

## Why (BST-1627, PR #2958)

The first notarization attempt was rejected by Apple with "The binary is not
signed" and "The signature does not include a secure timestamp" for every Mach-O
file inside `resources/python-runtime/*.tar.gz`. Apple's notarization service
scans inside shipped archives, and python-build-standalone's binaries are
ad-hoc, linker-signed, so a tarball can never ship in a notarized bundle. As
loose files under `<Resources>/python-runtime`, the same binaries are signed by
osx-sign with the Developer ID identity. Measured on the real tree: 1,635
files, 10 of them Mach-O, all ad-hoc-signed before signing.

## Layout

- The fetch script extracts each verified archive with `/usr/bin/tar` and
  writes `.brainstrike-python-runtime-ok` holding the archive sha256. It is
  idempotent; a stale or partial tree is replaced wholesale; non-darwin hosts
  log an explicit skip because only the macOS bundle ships the interpreter.
- Development: the manifest directory is located from the emitted
  `dist/main.js` module path (not `app.getAppPath()`), and the install dir is
  `unpacked/<process.arch>` beneath it.
- Packaged macOS: `build.mac.extraResources` copies `unpacked/${arch}` plus the
  manifest into `<Resources>/python-runtime`, so the install dir IS the
  resources dir (`resolveDesktopPythonRuntimeInstallDir`).
- The typed errors `python_archive_missing`, `python_checksum_mismatch` and
  `python_unpack_failed` collapsed into `python_runtime_missing`; the `python_*`
  family stays disjoint from the seam's and the fence's codes.

## What it replaced

Until this change the runtime path hashed the shipped archive, ran
`/usr/bin/tar` into a staging directory under `userData/python-runtime/`, and
coalesced concurrent first callers onto one in-flight promise. BST-1847 had
just hardened that path with Effect scopes over the hash stream, the tar child
and the staging directory (`effect-boundary/python-resource-scopes.md`). The
merge of `origin/main` into PR #2958 (2026-09-29) retired that machinery with
the path it scoped: nothing at runtime opens a stream, spawns a child or owns a
staging directory any more, so its rule, its guard and its resource-lifetime
tests were removed rather than ported. The manifest Schema decode (BST-1831)
survived unchanged.
