# ADR-0011: The run log is the truth, stored in a SQLite state DB

- **Status:** Accepted
- **Date:** 2026-10-02
- **Ticket:** BST-1914; storage decision M0, spikes under BST-1912

## Context

Run status has eight writers across three processes, the renderer writes message
edges, and Mastra keeps a separate message store. The durable-parent invariant
(BST-1243) was the fourth recurrence of the hydration-siblings bug class, and it was
fixed in the producers, not the reader. PGlite's fsync never reaches the disk, so an OS crash or
power cut can lose recent work. The M0 spikes compared a JSONL file per thread (J)
with SQLite `run_events` (S) on macOS, Linux and Windows; in 1,400 process kills on
the final spike code, neither lost a displayed chunk.

## Decision

- Each thread has one append-only run log. Only the host writes it, and the host
  commits before it displays. Every view is a fold of the log. Readers never coerce a
  bad shape; the producer is fixed instead. Approving a rediscovered pause anchors at
  the durable thread head.
- On desktop the truth is a SQLite state DB on better-sqlite3: `run_events` plus small
  authoritative tables. One connection runs on a worker-thread writer, so no SQLite
  call or sync runs on the event loop. PRAGMAs: `journal_mode=WAL`,
  `synchronous=NORMAL`, `fullfsync=ON` (macOS), `secure_delete=ON`,
  `wal_autocheckpoint=0`. Each streaming batch is one NORMAL transaction. Each step
  boundary is one `synchronous=FULL` commit, preceded by `wal_checkpoint(PASSIVE)` once
  the WAL holds 1,000 frames or more. Every `run_events` row carries a crc. Open runs
  `integrity_check` (not `quick_check`), and a damaged DB opens `query_only` and says so.
- Blobs are content-addressed files; the spike moved payloads of 12 KB or more out and
  kept a preview inline. One derived SQLite store holds the projection, FTS5, vectors
  and lens rows; it is rebuilt from the truth, and the indexer is its only writer.
  JSONL is the export and import format, not a store. PGlite leaves desktop.
- Web uses the same schema on sqlite-wasm with the `opfs-sahpool` VFS,
  `journal_mode=WAL` and `locking_mode=EXCLUSIVE`. One leader per origin holds a Web
  Lock in the DB worker, and only the lock holder calls `installOpfsSAHPoolVfs`.

## Consequences

- Both candidates met the crash contract. S won on Windows catch-up (291 ms against
  J's 2,026 ms first run with Defender on, budget 1 s), on code (J needed about 4x the
  candidate-specific code), and on finding open approvals through a partial index.
  J's contention failure (4.32x idle tool reads, budget 2x) came from writing on the
  event loop; J with a writer worker passed. The owner leaned toward JSONL and signed
  off on S.
- Committing before display costs about 11 ms at p50 and 21 ms at p95. With S, display
  p95 stayed within PGlite + 5 ms on all three platforms, and on macOS and Linux every
  step boundary issued a kernel sync with none on the display path. Power loss itself
  was not simulated.
- SQLite has no content checksum: a payload byte flip passes `integrity_check`, which
  is why the per-row crc exists.
- `opfs-sahpool` never rolls back a hot rollback journal (9 of 9 kills left a corrupt
  DB), so web stays on WAL + EXCLUSIVE.
- The state DB, blob directory, derived store and web OPFS data are new persistent
  state and join factory reset (ADR-0015).
- ADR-0002 records the durable PGlite `job_queue`. It needs a status review when M2
  deletes the scheduling layer; this ADR does not change it.

## Amendment (2026-10-09): live telemetry

Live telemetry is the one carve-out from "every view is a fold
of the log". For a running tool, that means `executeCommand`'s shell-output slices
(`SHELL_OUTPUT_STREAM_PART_TYPE`) and MCP progress
(`MCP_PROGRESS_STREAM_PART_TYPE`). The host's tool write seam classifies these
two types with `isToolTelemetryStreamPart` and sends them to the thread's log
subscribers as the uncommitted `run/telemetry` notification (protocol v11,
additive). Every other tool-writer chunk still commits as `stream.chunk`.
Committing telemetry made each slice wait on a disk commit and grew every
hydration: a 25 ms progress server for ten minutes is about 24k rows. Legacy
kept these slices transient. The tool result, which commits, owns the output,
so a reload shows the result and no slices.

The model's text and reasoning stream is the same kind of telemetry. The run
loop sends `text-start/delta/end` and `reasoning-start/delta/end` to
subscribers as `run/telemetry` with no `toolCallId`. It keeps committing
`start-step`, `finish-step` and `tool-*`, because notices, billing, ledger
counts and projection step keys read them. A step's `model.step` messages are
the one durable owner of its text, and no reader folds text from deltas. A
view shows a live overlay for the open step and replaces it with the step's
committed parts when that step commits; the overlay is never dropped on the
next `start-step`. Legacy's abort finalization is kept: a user's Stop, or a
terminal watchdog abort, commits the open step's observed partial reply as
`model.messages` through Core. A stall replaced by a new attempt keeps nothing,
as in legacy. A SIGKILL mid-step loses the partial reply in both legacy and
host. Measured with UI-panels' open harness at 1,000 threads x 5 runs, each
reply 300 deltas long (2026-10-09, macOS arm64):

- `state.db` fell from 642 MB to 35 MB. With content-addressed blobs (98 MB
  both times), the profile fell from 739 MB to 133 MB. Legacy's database was
  44 MB.
- Warm host open (`startAgentHost`) did not improve: 1,519–1,694 ms over five
  opens, against 1,429–1,530 ms before the change and legacy's 80–570 ms.
  Row count was not what made open slow, so the open-time gap stays open, and
  no lazy decoding was added in its name.

## Sources

- `docs/agents/assistant-persistence.md:173` (line number at `43daec7fb`): readers
  never coerce, and a rediscovered approval anchors at the durable thread head.
- The architecture reset report (2026-10-01) and the M0 spike reports M0-A1, M0-A2,
  M0-B and M0-W (BST-1912).
