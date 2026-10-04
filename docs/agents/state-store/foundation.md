# Storage foundation evidence

Supports `state-store.md` sections "Writer and durability", "Root ownership"
and "Blobs, purge and interchange".

## 2026-10-02 recovery and completion

BST-1923 is a storage foundation, deliberately not wired to chat. The preserved
checkout at `1e7c2d6067d663448cf1bb10056ee8d066fad6f1` contained the Windows lock
start-time change plus an unfinished store and invariant suites. A separate
checkout copied its binary tracked diff and all nonignored untracked files;
SHA-256 comparison verified all 51 copied files while preserving the original.

The recovered unit suite passed 55 tests and failed five schema assertions:
the scaffold declared only four internal tables. Schema version 2 adds the
recovered 16 authoritative relations, the ticket's usage ledger and a thread
sequence ledger. Existing version-1 run rows and settings remain intact. The
current PostgreSQL migrations provide column and CHECK-constraint provenance;
JSON, boolean, timestamp, UUID, byte-length and decimal representations are
explicit SQLite mappings. Only the complete MCP authority foreign key is retained;
legacy Mastra/run/delegation parents are absent from this unwired schema.

The live BST-1941 ticket forbids taking another host's root lock. Its invariant
supersedes the recovered spike-era foreign-host confirmation policy. A new test
first demonstrated that approving the callback replaced that lock; the root lock
now refuses before invoking the callback. Same-host copied-root confirmation is
preserved for exported snapshots.

JSONL export/import was absent. Its worker implementation preserves run-event
payloads, sequence, raw-count and timestamp values plus referenced blob bytes.
A version header, CRC and SHA-256 checks reject malformed/truncated interchange
before any imported run rows are committed. It is run-log interchange; the
VACUUM INTO bundle remains the complete authoritative-state export.

An existing-file shortcut in blob writes trusted the supplied hash and corrupt
files. A failing regression test showed an event could commit a reference to
wrong bytes. The writer now verifies both supplied content and existing files.
Every referencing append also verifies the blob is present and matches its hash.
Missing or invalid derived reference counts reject GC and leave its durable purge
intent available for retry instead of claiming completion.

Further RED/GREEN cases reproduced a retained reader hanging after close and an
unexpected process probe error replacing a live lock. Closed readers now reject
promptly; identity errors preserve the lock. A first full rerun also caught the
closed-state guard hiding an earlier worker failure. The original S-exit assertion
remained intact while failure precedence was corrected and its cause preserved.

## Qualification limits

The local archive at
`/Users/seandearnaley/Documents/brainstrike-architecture-spikes-2026-10-01`
contains the earlier s-* and native-index spikes, but no `m0/inventory.md`, M0-A1
or M0-A2 source/report directories. Recovered test descriptions attribute their
cases to those suites; exact source parity cannot be asserted without the
missing originals. The purge tests use a truth-reading test indexer; production
FTS/vector purge parity belongs to the separate derived-store implementation.

Process-kill recovery demonstrates the commit-before-display contract; kernel
interposition demonstrates sync calls. Neither simulates an actual power loss.
Windows and native desktop packaging qualification must be reported separately
from local macOS or Linux-container results.

## Local qualification commands

The isolated branch is `codex/m2-state-store-invariants`, based on the preserved
`1e7c2d6067d663448cf1bb10056ee8d066fad6f1` checkout. Tests use Node 26.8.2,
better-sqlite3 13.0.3 and its SQLite 3.53.4 engine. macOS is 27.0.1 (26A434),
arm64. Linux proof uses Debian 12 bookworm arm64 inside the local Docker
`bst1920-linuxarm64-proof` container; no hosted runner was enabled or dispatched.

From the isolated repository root:

```sh
pnpm --filter @brainstrike/state-store type-check
pnpm --filter @brainstrike/state-store build
pnpm --filter @brainstrike/state-store test
BRAINSTRIKE_STATE_STORE_KERNEL_SYNC=1 pnpm --filter @brainstrike/state-store test:integration
pnpm dlx ultracite@7.9.2 fix packages/state-store docs/agents/state-store.md docs/agents/state-store/foundation.md
```

For Linux, source files were copied without host dependency/native binary
directories into `/state-native-proof`; dependencies resolve to the container's
already built `/workspace/node_modules`. Its source packages remain unchanged.
`lsof`, `strace` and a C compiler were present for the handle/kernel assertions.
From `/state-native-proof/packages/state-store`:

```sh
/workspace/node_modules/.bin/vitest run --exclude "**/*.integration.test.*"
BRAINSTRIKE_STATE_STORE_KERNEL_SYNC=1 /workspace/node_modules/.bin/vitest run --config vitest.integration.config.mts
```

The initial Linux copy contained AppleDouble `._*` sidecars from macOS tar,
causing 16 extra-file parser failures despite all applicable assertions passing.
Those transfer artifacts were removed; `COPYFILE_DISABLE=1` prevented their
creation on the final transfer. No assertion or test-discovery configuration
changed. An earlier Linux lifecycle failure matched the macOS S-exit failure and
was fixed by preserving worker failure precedence, not by changing its assertion.

The state-store remains unwired; these package checks do not certify application
chat migration, host discovery/launcher lifetime, production derived purge, real
Windows operation, x64 binaries or native desktop distribution. Missing M0 source
parity remains open as described above.

Final results on the completed source:

| Check | macOS arm64 | Linux arm64 container |
| --- | --- | --- |
| Unit | 70 passed, 16 files | 69 passed, 1 macOS-only skip, 16 files |
| Integration with kernel tracer opted in | 6 passed, 3 files | 6 passed, 3 files |
| Mid-stream SIGKILL | 20 trials, 50,137 displayed chunks | 20 trials, 36,401 displayed chunks |
| Lost / mismatched displayed chunks | 0 / 0 | 0 / 0 |
| Boundary sync spans / display syncs / failed syncs | 9 / 0 / 0, F_FULLFSYNC | 9 / 0 / 0, fsync |
| Autocheckpoint negative-control display syncs | 6 | 12 |
| 100 MB export snapshot time | 690.4 ms | 440.1 ms |
| 100 MB median CRC scan / integrity check | 80.9 / 80.9 ms | 105.7 / 87.0 ms |

Every killed-store reopen reported integrity OK, no sequence gaps and one stale
lock recovery. Linux strace and interposer matched 19 total syncs in boundary
mode and 38 in the negative control. Purge left zero occurrences of the test
secret in truth DB/WAL/blobs at resolve; both export/import cases and 100 MB
open-time checks passed. Type-check and build passed on macOS.

These are correctness checks and observations, not UI responsiveness gates. In
the final simultaneous Mac/Linux run, the macOS 100 MB sample recorded a
300.9 ms maximum append during export, 331.8 ms maximum append during purge and
45.8 ms maximum event-loop delay during purge. The Linux purge sample recorded
336.0 ms maximum append and 51.7 ms event-loop delay. Preserve these tails when
evaluating later application integration; package success does not erase them.

## 2026-10-04 recovered A1 timing qualification

Recovered A1 driver captures and the complete inherited `s-dur` host closure
enabled a reviewed port onto the actual production StateStore and Coalescer.
The single macOS qualification at integration `b8323d3` passed the original
display criterion and the explicitly approved three-process S contention
criterion. Captured bytes, exact identities, failure-as-data controls, raw
receipt locations and unported limits are recorded in
`m0-a1-qualification-2026-10-04.md`. This supersedes the earlier missing-source
limit for those A1 latency/contention measurements; it does not recover J,
repeat kernel tracing or complete A2 purge qualification.
