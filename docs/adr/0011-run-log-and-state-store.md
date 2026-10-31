# ADR-0011: The run log is the truth, stored in a SQLite state DB

- **Status:** Accepted. The web parts (sqlite-wasm on OPFS, the browser writer's lease) are
  superseded: `apps/web` and `@brainstrike/web-state-store` are no longer in the repo. The JSONL
  export/import format was removed (2026-10-31 amendment).
- **Date:** 2026-10-02
- **Ticket:** BST-1914; storage decision M0, spikes under BST-1912

## Context

- Run status had eight writers across three processes; the renderer wrote message edges; Mastra
  kept a separate message store.
- The durable-parent invariant (BST-1243) was the fourth recurrence of the hydration-siblings
  bug class, fixed in producers rather than the reader.
- The previous desktop database (PGlite) never fsynced to disk, so an OS crash or power cut could
  lose recent work.
- The M0 spikes compared a JSONL file per thread (J) with SQLite `run_events` (S) on macOS, Linux
  and Windows. In 1,400 process kills neither lost a displayed chunk.

## Decision

- **One append-only run log per thread.**
  - Only the host writes it, and commits before it displays.
  - Every view is a fold of the log.
  - Readers never coerce a bad shape; the producer is fixed.
  - Approving a rediscovered pause anchors at the durable thread head.
- **Desktop truth is a SQLite state DB on better-sqlite3:** `run_events` plus small
  authoritative tables.
  - One connection on a worker-thread writer; no SQLite call or sync on the event loop.
  - PRAGMAs: `journal_mode=WAL`, `synchronous=NORMAL`, `fullfsync=ON` (macOS),
    `secure_delete=ON`, `wal_autocheckpoint=0`.
  - Each streaming batch is one NORMAL transaction. Each step boundary is one
    `synchronous=FULL` commit, preceded by `wal_checkpoint(PASSIVE)` once the WAL reaches 1,000
    frames.
  - Every `run_events` row carries a crc.
  - Open runs `integrity_check`; a damaged DB opens `query_only` and says so.
- **Blobs** are content-addressed files (payloads ≥ 12 KB move out; a preview stays inline).
- **One derived SQLite store** holds projection, FTS5, vectors and lens rows. It is rebuilt from
  the truth, and the indexer is its only writer.
- ~~Web uses the same schema on sqlite-wasm (`opfs-sahpool`, WAL, `locking_mode=EXCLUSIVE`) with
  one Web Lock leader per origin.~~ Superseded; no web app remains.

## Consequences

- Both candidates met the crash contract. S won on:
  - Windows catch-up: 291 ms vs J's 2,026 ms with Defender on (budget 1 s);
  - code size: J needed about 4x the candidate-specific code;
  - finding open approvals through a partial index.
  - J's contention failure came from writing on the event loop; J with a writer worker passed.
- Commit-before-display costs about 11 ms p50 / 21 ms p95. Display p95 stayed within the old
  store + 5 ms on all platforms. Power loss was not simulated.
- SQLite has no content checksum (a byte flip passes `integrity_check`), hence the per-row crc.
- The state DB, blob directory and derived store are persistent state and join factory reset
  (ADR-0015).

## Amendment (2026-10-09): live telemetry

Live telemetry is the one carve-out from "every view is a fold of the log".

- **What is telemetry** (sent as uncommitted `run/telemetry`, protocol v11):
  - a running tool's shell-output slices (`SHELL_OUTPUT_STREAM_PART_TYPE`) and MCP progress
    (`MCP_PROGRESS_STREAM_PART_TYPE`), classified by `isToolTelemetryStreamPart`;
  - the model's `text-*` and `reasoning-*` deltas (no `toolCallId`);
  - tool input deltas (2026-10-31 amendment below).
- **What still commits:** every other tool-writer chunk as `stream.chunk`; `start-step`,
  `finish-step` and `tool-*` (notices, billing, ledger counts and projection step keys read
  them).
- **Durable owners:** the tool result owns tool output; a step's `model.step` messages own its
  text. No reader folds text from deltas.
- **Why:** committing telemetry made each slice wait on a disk commit and bloated hydration (a
  25 ms progress server for ten minutes is about 24k rows).
- **Views** show a live overlay for the open step and replace it when the step commits. The
  overlay is not dropped on the next `start-step`.
- **Aborts:** a user's Stop, a terminal watchdog abort or the host closing mid-step (BST-1982)
  commits the observed partial reply as `model.messages`. A stall replaced by a retry keeps
  nothing. A SIGKILL mid-step loses the partial reply; recovery commits one interrupted end.
- **Measured** (1,000 threads × 5 runs, 300 deltas per reply, macOS arm64):
  - `state.db` fell from 642 MB to 35 MB; the profile from 739 MB to 133 MB.
  - Warm host open did not improve (resolved by the 2026-10-31 open-time amendment).
- **Replay for late subscribers** (in memory, never committed):
  - Kept: a tool call's telemetry until its `effect.finished`; the open step's text and
    reasoning until its `model.step` (or a Stop's partial `model.messages`). `run.finished`
    drops all of the run's streams.
  - Ordinals from 0 per stream. Tool streams are keyed by run + `toolCallId`; text and reasoning
    share one stream per run.
  - `log/subscribe` returns the replay as `telemetry`. The view applies it after replayed rows,
    then held live chunks, skipping ordinals already applied.
  - Bound: 512 KiB of chunk JSON per stream (`HOST_TELEMETRY_REPLAY_BYTES`). Older chunks drop
    behind a `brainstrike.telemetry.omitted` marker, shown as "Earlier output not shown (N KB)" or
    "Earlier reply text not shown (N KB)". Never dropped silently.

## Amendment (2026-10-09): run configuration by reference

- A committed `run.started` stores its run snapshot (system prompt, child system, captured
  intent, tool identities) as one content-addressed blob, named in `blobRefs` and `snapshotRef`.
  - Runs with the same configuration share the blob by reference count.
  - A missing or damaged blob damages the thread like any spooled row.
  - Readers resolve the reference, so replay, rewind, turn snapshots, debug packs and the wire
    see the snapshot as before.
- Why: the desktop snapshot is about 20 KB (17 KB of it the system prompt). At 1,000 × 5 runs,
  102 MB of a 128 MB hydration read was spooled `run.started` rows.
- Stored-row JSON values are not re-walked: producers and the wire use `z.json()`; the reader
  accepts what `JSON.parse` produced. Structural fields are still validated and rows stay
  crc-verified.

## Amendment (2026-10-15): the browser writer's lease — superseded

Owner decisions on BST-1940 defined a Web Lock lease for a browser writer
(`@brainstrike/web-state-store`). The package and the web app are no longer in the repo; this
amendment is kept as history only.

## Amendment (2026-10-19): memory recall telemetry

Owner decision 3 on BST-2194 (BST-2225): semantic-recall diagnostics are live telemetry, not log
rows.

- When Memory recalls, Core sends one uncommitted `run/telemetry` chunk of type
  `brainstrike.memory.recall` on the run's stream, carrying:
  - the returned messages and their ranges;
  - `topK`, if configured;
  - the scope (`thread` or `resource`);
  - the latency, including the query embedding.
- Why: recall happens every model step; recalled turns already reach the provider from committed
  history.
- Never replayed: recall happens before the step opens; a later subscriber sees the next recall.
- A hosted recall embedder's spend is billing and is committed (BST-2226).
- The Developer memory panel shows the last recall received, labelled live; reload clears it.

## Amendment (2026-10-31): what made host open slow

- A profile of `HostCore.open` (BST-2388) found open re-validating every committed model message
  against the AI SDK's `modelMessageSchema`. #4859 removed that parse.
- Linux x64, 1,000 threads × 5 runs (103k rows): open fell from 1.33–1.57 s to 0.82–0.90 s.
  Remaining: hydration read ~460 ms, row decoding ~155 ms, folds ~170 ms.
- Persisted fold checkpoints were considered and not built: they add a second durable copy of
  every view to version and invalidate. Revisit only when a profile needs them.

## Amendment (2026-10-31): no export or import

- JSONL interchange and a `VACUUM INTO` bundle were built, but nothing outside their tests called
  them. BST-2395 removed both.
- Brainstrike is greenfield (ADR-0020). A future backup or transfer feature is designed from its
  product need, against the schema of that day.

## Amendment (2026-10-31): tool input deltas are telemetry

Owner decision BST-2379.

- `tool-input-delta` is sent as `run/telemetry` on the run's stream, beside text and reasoning.
- `tool-input-start`, `tool-input-end` and `tool-call` still commit. The committed `tool-call`
  holds the whole input and is its only durable owner.
- Why: a streamed 20 KB `write_file` wrote thousands of rows, each a writer round trip that held
  up the model stream and was refolded at every open.
- Views show live input between `tool-input-start` and `tool-call`; replay and bounds are shared
  with the open step's text. After `tool-call` commits, only the committed input shows.

## Sources

- `docs/agents/assistant-persistence.md` (at `43daec7fb`): readers never coerce; a rediscovered
  approval anchors at the durable thread head.
- The architecture reset report (2026-10-01) and M0 spike reports M0-A1, M0-A2, M0-B and M0-W
  (BST-1912).
