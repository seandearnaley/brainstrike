# Bundled CPython: build-time unpack, not runtime — evidence

Supports `docs/agents/code-execution.md` § "Isolation and authority". Read this
before moving the CPython unpack back to runtime, shipping a tarball, or
changing the sentinel/manifest contract. The contract holds the rules; this file
is the record of why.

## Rule

`apps/desktop/scripts/fetch-python-runtime.mjs` unpacks the interpreter once, at
build time, into `resources/python-runtime/unpacked/<platform>-<electron arch>/`
(`darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`), and the loose tree
ships in the package. Linux unpacks its derived no-dbm-v1 archive, never the
upstream one. `resolvePythonBinary` never extracts, hashes, stages or writes:
it reads the tree's `.brainstrike-python-runtime-ok` sentinel, compares it with
the manifest's pin for the archive the tree came from (`derived.sha256` on
Linux, else `sha256`), and checks that `python/bin/python3` is executable.
Every launch of the bundled interpreter carries `PYTHONDONTWRITEBYTECODE=1`
(`BUNDLED_PYTHON_ENV`).

## Why (BST-1627, PR #2958, rebased onto Linux support)

- The first notarization attempt was rejected by Apple with "The binary is not
  signed" and "The signature does not include a secure timestamp" for every
  Mach-O file inside `resources/python-runtime/*.tar.gz`. Apple's notarization
  service scans inside shipped archives, and python-build-standalone's binaries
  are ad-hoc, linker-signed, so a tarball can never ship in a notarized bundle.
  As loose files under `<Resources>/python-runtime`, osx-sign signs the same
  binaries with the Developer ID identity.
- pip vendors distlib's Windows launcher stubs (`t32.exe`, `w64-arm.exe`, …).
  osx-sign's binary heuristic made each one a `codesign` call with its own
  timestamp round-trip, and BST-1627's first rebuild died on one
  (`t32.exe: The timestamp service is not available`). The unpack prunes every
  `.exe` from every target's tree.
- Linux uses the same layout so one resolver path serves both platforms and
  nothing under `userData` belongs to the interpreter. Reset therefore has no
  Python state to clear.
- The tree is inside the package, and on macOS inside the signed bundle, which
  a drag install leaves user-writable. A fenced `run_python` cannot write
  outside its scratch directory, but an approved `python3` skill script runs
  unfenced with the user's access; CPython would otherwise write `__pycache__`
  beside the stdlib and break the bundle's sealed resources. Measured on the
  Linux x64 dir build: an unfenced run without the variable created
  `python/lib/python3.13/__pycache__`, `re/__pycache__` and
  `pathlib/__pycache__` in the packaged tree.

## Layout

- Development: the manifest directory is located from the emitted
  `dist/main.js` module path, and the install dir is
  `unpacked/<process.platform>-<process.arch>` beneath it
  (`resolveDesktopPythonRuntimeInstallDir`).
- Packaged: `build.{mac,linux}.extraResources` copies the manifest and
  `unpacked/{darwin,linux}-${arch}` into `<Resources>/python-runtime`, so the
  install dir IS the resources dir. electron-builder keeps the tree's symlinks
  (1,047 on Linux x64).
- The typed errors `python_archive_missing`, `python_checksum_mismatch` and
  `python_unpack_failed` collapsed into `python_runtime_missing`; the
  `python_*` family stays disjoint from the seam's and the fence's codes.
- The boot warm-up (`warmDesktopPythonRuntime`) existed only to pay the cold
  unpack early; it was removed with it.

## What it replaced

The runtime path hashed the shipped archive, ran `/usr/bin/tar` into a staging
directory under `userData/python-runtime/`, and coalesced concurrent first
callers. BST-1847 had hardened that path with Effect scopes over the hash
stream, the tar child and the staging directory
(`effect-boundary/python-resource-scopes.md`). Nothing at runtime opens a
stream, spawns a child or owns a staging directory any more, so that rule, its
guard and its resource-lifetime tests were removed rather than ported. The
manifest Schema decode (BST-1831) survived unchanged.
