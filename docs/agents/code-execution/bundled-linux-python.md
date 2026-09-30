# Bundled Linux x64 Python — evidence

Supports `docs/agents/code-execution.md` § "FenceExecutor".

## Scope and provenance (2026-09-30, BST-1896)

The existing CPython 3.13.14 / python-build-standalone 20260728 pin has an
`x86_64-unknown-linux-gnu-install_only.tar.gz` asset: 118,178,436 bytes,
SHA256 `ad6966bfa717f2da83c55eb9e0412bca4039f5501f2c7b42b43079a6052321fd`.
The actual downloaded bytes, GitHub release asset digest, and the release's
`SHA256SUMS` agree. This adds Linux glibc x64 only. It does not promise musl,
Linux arm64, other architectures, or a new minimum supported distribution.

Sources: [official release](https://github.com/astral-sh/python-build-standalone/releases/tag/20260728),
[checksums](https://github.com/astral-sh/python-build-standalone/releases/download/20260728/SHA256SUMS).
The existing build fetcher verifies byte length and SHA256 before installation;
the runtime hashes the resource archive before cold extraction and retains its
existing typed missing/checksum/unpack errors. No runtime network or PATH lookup
is introduced. `/usr/bin/tar` remains the absolute extractor; on Linux it uses
`--use-compress-program=/usr/bin/gzip` rather than GNU tar's PATH-searched `-z`.
Either tool's absence is a typed unpack failure; Darwin keeps its existing
tar arguments. A native cold-extraction test with PATH removed caught the
implicit gzip lookup before this correction.

Linux electron-builder resources include only the manifest and derived Linux archive,
plus the upstream component notices. The macOS filter is narrowed to Darwin
archives so adding Linux does not inflate every Mac package by 118 MB. Windows
is unchanged. The common build fetcher still fetches all supported targets.

The approved Linux-only `no-dbm-v1` archive is separately pinned under the
Linux target's `derived` field. The build verifies the original input first,
repackages with pinned tar 7.5.22 / portable headers / no mtime / gzip level 9,
removes exactly the optional `_dbm` shared module, then verifies the output's
size and SHA256 before publishing it. The measured output is 116,873,543 bytes,
SHA256 `95bbf77a6164defde416c51c1eada4481fbd2f2c1b6d9a63353c9d38bf0d7560`
(1,304,893 bytes smaller). A missing or unexpected DB-linked module
fails the build. The original input never matches the Linux resource filter.
The resolver verifies the derived pin, never falls back to the original input,
and replaces any pre-variant installed runtime whose sentinel differs.

## Packaging boundary and existing signing work

This change is based on main and does not absorb PR #2958, which moves macOS to
build-time unpacking for signing. The Linux target/pin, platform resource filter,
license copy, typed unsupported-architecture handling, and reset/offline tests
must survive that future integration. A move of the installation out of userData
also changes the factory-reset contract; do not silently carry a stale sentinel
or install path across the two designs.

## License follow-through

The install-only archive does not contain `python/licenses/`. Linux therefore
ships the matching full-distribution notice set separately. Provenance, source
links, the full artifact digest, and byte-level notice hashes live in
`apps/desktop/licenses/python-linux-x64/`. The actual full build metadata marks
`_dbm` as linked to Berkeley DB under Sleepycat. Its source-availability terms
motivated the approved module removal. The derived runtime drops the only
DB-linked extension identified by the full metadata; an archive audit compares
every remaining payload byte and symlink with the upstream input. This is not
a blanket legal-clearance claim. Existing macOS
notice wording incorrectly claimed the install-only archive carried that whole
license directory and is corrected without changing Darwin binaries. The pinned
Darwin arm64 full metadata uses the system ndbm path and has no Sleepycat-tagged
extension; the Linux Berkeley DB issue must not be attributed to macOS. The
pinned build script chooses `bdb` on Linux; the official stripped variant only
removes debug symbols and does not resolve this licensing question.

No tracked Brainstrike code uses `_dbm`, `dbm.ndbm`, `dbm.open`, or `shelve`,
and the repository ships no `.py` scripts. Third-party/user scripts can differ:
`_dbm` and `dbm.ndbm` now fail to import on Linux. Default new `dbm.open` stores,
explicit SQLite-backed stores, and `shelve` are tested. Existing ndbm/Berkeley DB
files do not gain automatic conversion or another interpreter/backend fallback.

## Verification and limitations

- Red: new Linux resolution/typed-error and packaging assertions fail on main;
  unsupported Linux architectures continue to reject without reading a manifest
- Green: 108 focused tests, including Linux target selection, corrupt/missing errors, build hash/size refusal,
  platform packaging filters, resource-path resolution, existing cancellation,
  extraction and factory-reset regression suites
- Real Linux x64 archive: first extraction, execution with an empty executable
  search path, `ctypes`/`hashlib`/`sqlite3`/`ssl` imports, fresh resolver module
  reuse, actual factory-reset helper deletion, then offline re-extraction/run
- Cold extraction and reset recovery now run with PATH absent on Linux too,
  not merely the interpreter subprocess. The missing-gzip regression is red
  before the absolute Linux compressor argument and green afterward; unit
  controls preserve typed missing tar/gzip errors and unchanged Darwin arguments
- Native Debian 13 x64 desktop: the checksum-pinned derived interpreter runs
  through the built FenceExecutor, both on this branch and with BST-1317's
  async readiness factory. SRT reports no dependency errors or warnings;
  default dbm/SQLite/shelve round trips pass, `_dbm` stays absent, and a write
  outside the writable scratch directory is refused with `EROFS` (errno 30)
- The earlier missing-socat/`Operation not permitted` result came from the
  restricted execution-tool context, not the native desktop. The native probe
  uses a private, authenticated Debian socat package prefix. User, mount, PID,
  and network namespace controls plus the combined bwrap command all exit 0;
  no host security settings or weaker sandbox flags are used
- Native proof identifies Python head `1d74f9bd3abef734fcac38b866ce891578bd22ac`
  and readiness head `a9468d144aaa1b339abb6f90ac90886d350e2b8a` (built module
  SHA256 `8214f4aee0e58ce1ea42db8f39e5da94b6b1fb95365ac4a32528b5ca7882ab10`).
  The request uses an absolute injected interpreter, `allowedDomains: []`,
  one writable scratch directory, a 20-second budget, and no fallback.
  Network policy allow/deny and clean-distro qualification are separate proof
- CI exposed an older build-config assertion that still expected every
  platform's tarballs in macOS resources. It reproduces red, then passes with
  the Darwin-only filter; the existing Linux packaging regressions stay green
- Actual `electron-builder --linux --x64 --dir` packaging passes with native
  dependency rebuilding enabled and the verified Electron 44.4.5 distribution.
  Inspection of the resulting `resources/python-runtime/` finds exactly the
  manifest, derived Linux archive, and licenses directory. The archive size
  and SHA256 match the manifest; all 19 notice hashes and provenance files
  match the sources. Neither the original Linux nor Darwin archives ship there
- Two distinct Node processes invoke the real resolver against those packaged
  resources with PATH absent and fetch prohibited. Both run the exact pinned
  interpreter; the second preserves the install sentinel's inode and mtime,
  proving disk-cache reuse without relying on a module-level memo
- This unpacked-package resource proof does not qualify clean distributions,
  AppImage installation/upgrades, or a full desktop-process restart. The
  resolver-reload/reset tests and native fence test above retain their stated scope

Guards: `apps/desktop/src/__tests__/main/python-runtime-linux.test.ts`,
`python-runtime-packaging.test.ts`, `fetch-python-runtime-script.test.ts`,
`resolve-python-binary.integration.test.ts`, `resolve-python-binary.test.ts`,
`resolve-python-binary-resources.test.ts`, `desktop-factory-reset.test.ts`,
`derive-python-runtime.integration.test.ts`, `python-derived-payloads.integration.test.ts`.


Byte-pinned notice text uses directory-local Git `-text` attributes so Windows
`core.autocrlf=true` checkouts preserve the upstream bytes. Guard:
`scripts/__tests__/python-license-eol-contract.test.mjs`; its negative control
removes the attributes and observes changed bytes through Git's real checkout filter.
