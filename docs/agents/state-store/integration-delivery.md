# State foundation integration delivery

Supports the state-store contract and preserves the recovery evidence in
`foundation.md`.

## 2026-10-03 composition

The isolated delivery branch merges the complete state foundation source
`c49924e540e3bf489abb448b0d77c0b723910a95` →
`1e7c2d6067d663448cf1bb10056ee8d066fad6f1` →
`fc50968885854f56c53474096f2342f4acffbf8a` above authoritative integration
`12d8a270113c1800eb6d308488508d36efbd6e59`. That integration contains the
normally merged native prerequisite `568f0d96eea526a734c3d4fc20effd5a4e2251f7`.
Its tree equals that prerequisite; the state package and original foundation
contract/evidence are byte-identical to the completed source. The only merge
conflict was the lockfile. A parsed YAML comparison proved the resolution is
exactly the native integration lock plus the state-store importer, preserving
all other importers, resolutions and catalog entries.

The original unfinished checkout remains at
`1e7c2d6067d663448cf1bb10056ee8d066fad6f1`. Before this delivery, its binary
tracked diff and all 51 SHA-256 snapshot file hashes were verified unchanged.
No host-lease package, desktop consumer, main/reset wiring or chat migration is
part of this layer. Shared graph registration adds only the new state package.

CI is disabled due to cost; validation must run locally.

The human-approved exception permits this focused, integration-only delivery.
Full regression and platform acceptance remain required before M2 reaches main.

## Local commands

From the isolated delivery root:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @brainstrike/state-store build
pnpm --filter @brainstrike/state-store type-check
pnpm --filter @brainstrike/state-store test
BRAINSTRIKE_STATE_STORE_KERNEL_SYNC=1 pnpm --filter @brainstrike/state-store test:integration
```

The frozen install uses existing native binaries from the installed dependency
graph; `--ignore-scripts` does not claim a fresh native compilation. Native
packaging proof belongs to the native prerequisite. The Mac build and types
passed. All 70 unit tests in 16 files passed. All six integration tests in three
files passed, with kernel tracing opted in. Twenty mid-stream SIGKILL trials
preserved all 71,704 displayed chunks with no mismatch, sequence gaps or failed
integrity checks. Boundary tracing saw nine F_FULLFSYNC spans and zero display
syncs; the automatic-checkpoint negative control detected three display syncs.
The 100 MB purge had no secret occurrences in DB/WAL/blobs at resolve; export
and CRC/integrity checks passed. Observed purge maximum append was 288.4 ms and
maximum event-loop delay was 37.6 ms. These are observations, not UI gates.

Linux proof is isolated at `/state-foundation-delivery-proof` in the existing
local Debian 12 arm64 Docker container, Node 26.8.2, pnpm 11.15.0, SQLite 3.53.4
via better-sqlite3 13.0.3. Source files are copied without native/dependency
artifacts. Dependency links point to the existing container dependency graph;
its source packages are unchanged. The initial copy missed test-utils package
and base-tsconfig resolution links, so configuration loading failed before
running assertions. Correcting those proof links changes no source, test or
assertion. From its state package:

```sh
/workspace/node_modules/.bin/vitest run --exclude "**/*.integration.test.*"
BRAINSTRIKE_STATE_STORE_KERNEL_SYNC=1 /workspace/node_modules/.bin/vitest run --config vitest.integration.config.mts
```

## Remaining qualification

The limits recorded in `foundation.md` remain open. Actual Windows execution,
x64 distributions and the final composed application startup/reset path are
unqualified. Production FTS/vector purge is not covered by the truth-indexer
test double. Original M0 inventory and M0-A1/A2 source/reports are still missing;
recovered s-qs app-state source confirms old PGlite migration provenance but
cannot establish exact parity. Kernel tracing and process kills do not simulate
power loss. State-store stays unwired to chat.

Linux's full unit run finished with 68 passed, one existing macOS-only skip and
one failure: the unchanged exhaustive WAL torn-tail case exceeded its existing
60-second deadline (77.9 seconds for that file). Container CPU/memory limits
were unset, and the Mac host reported load averages 43.22/50.80/35.32 on 16 CPUs;
this supports a contention hypothesis but does not establish its precise cause.
An unchanged isolated rerun of all four corruption cases passed in 9.59 seconds
(the exhaustive case took 9.29 seconds). Keep the failed full run visible;
these results do not declare the full Linux unit run green. The complete Linux
integration run passed all six tests in three files: twenty kills preserved all
41,472 displayed chunks, nine boundary fsync spans and zero display syncs matched
strace, and the automatic-checkpoint negative control detected nine display
syncs. The 100 MB purge had zero secret occurrences at resolve, with observed
maximum append 254.6 ms and event-loop delay 50.5 ms. No timeout, assertion,
discovery rule or implementation changed for these checks.
