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
next `start-step`. Legacy's abort finalization is kept: a user's Stop, a
terminal watchdog abort, or the host closing mid-step (the app quitting,
BST-1982) commits the open step's observed partial reply as `model.messages`
through Core. A stall replaced by a new attempt keeps nothing, as in legacy. A
SIGKILL or other unclean exit mid-step loses the partial reply in both legacy
and host; the next host's recovery commits the run's one interrupted end.
Measured with UI-panels' open harness at 1,000 threads x 5 runs, each
reply 300 deltas long (2026-10-09, macOS arm64):

- `state.db` fell from 642 MB to 35 MB. With content-addressed blobs (98 MB
  both times), the profile fell from 739 MB to 133 MB. Legacy's database was
  44 MB.
- Warm host open (`startAgentHost`) did not improve: 1,519–1,694 ms over five
  opens, against 1,429–1,530 ms before the change and legacy's 80–570 ms.
  Row count was not what made open slow, so the open-time gap stays open, and
  no lazy decoding was added in its name.

A view that subscribes mid-call or mid-step, such as a running child's tab,
gets replayed what it missed, as legacy's resumable session did. Core keeps
this replay in memory and never commits it.

- **What is kept.** Each running tool call's telemetry is kept from its first
  chunk until its `effect.finished` commits. The open step's text and
  reasoning are kept from its committed `start-step` until its `model.step`,
  or a Stop's partial `model.messages`, commits. `run.finished` drops all of
  the run's streams.
- **Ordinals.** Every stream numbers its chunks with an `ordinal` from 0. A
  call's stream is keyed by run and `toolCallId`; a run's text and reasoning
  share one stream keyed by run.
- **Delivery.** The `log/subscribe` result carries the thread's replay as
  `telemetry`, taken after the read in the tick the result is sent. A view
  applies it after the replayed rows, then applies the live chunks it held
  meanwhile. It skips any ordinal it has already applied, so views that share
  a connection see each chunk once.
- **The bound.** Each stream is held to 512 KiB of chunk JSON
  (`HOST_TELEMETRY_REPLAY_BYTES`). Past that, the oldest chunks drop, and the
  replay opens with a `brainstrike.telemetry.omitted` marker giving the
  omitted bytes and the ordinal where the kept output resumes. A command's live
  pane shows "Earlier output not shown (N KB)". A reply's live overlay shows
  "Earlier reply text not shown (N KB)" until the step commits. Output is never
  dropped silently.

## Amendment (2026-10-09): run configuration by reference

A committed `run.started` keeps its run snapshot (the run configuration: the
composed system prompt, the child system, the captured intent and the tool
identities) as one content-addressed blob, named in the row's `blobRefs` and
`snapshotRef`. Every run of the same configuration shares that blob through
the store's existing reference counting, and a missing or damaged blob damages
the thread like any spooled row. Reading the row resolves the reference to the
exact snapshot the run committed, so replay, rewind, turn snapshots, debug
packs and the wire see the inline snapshot as before. The desktop's snapshot is
about 20 KB, and 17 KB of that is the system prompt repeated on every run. At
1,000 threads x 5 runs, the hydration read was 128 MB, of which 102 MB was
4,996 spooled `run.started` rows, each read, hashed and parsed at open.

A stored row's JSON values are not walked again. The event schemas are built
once over a JSON value schema: producers and the wire use `z.json()`, and the
stored-row reader accepts the values JSON.parse produced, which `z.json()` can
never reject. Every structural field of a stored row is still validated at
open, and rows stay crc-verified by the store.

## Amendment (2026-10-15): the browser writer's lease

The desktop lease names its holder by pid, process start time and socket path.
A browser worker has none of these. Owner decisions on BST-1940:

- **The lease is the Web Lock.** The worker holding the origin's exclusive Web
  Lock is the only writer. Taking the lock, it records an `instanceId` and an
  epoch one past the previous writer's. It then announces them to the origin's
  other tabs over a BroadcastChannel.
- **The record is not a credential.** It carries no token, because on the web
  the origin is the principal. The epoch has its own database in the OPFS pool,
  so a damaged state DB, which opens `query_only`, still gets a newer epoch.
- **Every tab works.** A tab whose worker is not the writer forwards its
  requests to the writer. When the writer's tab closes, the lock passes to a
  waiting worker. A forwarded request is never sent twice: one the old writer
  did not answer fails as `leader-lost`, because it may or may not have been
  applied.

`@brainstrike/web-state-store` implements this lease. It runs the shared schema
and run log unchanged, through a better-sqlite3-shaped adapter over the
official build. The web app does not run on it yet. Through 3.53.x, a failed
`opfs-sahpool` init removes the whole pool (the vendor's `removeVfs()`), and the
owner gated shipping on the fix (upstream check-in ad1bbfc2bd, 3.54).

## Sources

- `docs/agents/assistant-persistence.md:173` (line number at `43daec7fb`): readers
  never coerce, and a rediscovered approval anchors at the durable thread head.
- The architecture reset report (2026-10-01) and the M0 spike reports M0-A1, M0-A2,
  M0-B and M0-W (BST-1912).
