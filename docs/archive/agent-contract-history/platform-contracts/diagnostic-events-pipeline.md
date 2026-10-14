# Table, capture, writer, unstorable characters, retention — evidence

Supports `docs/agents/platform-contracts.md` § "DIAGNOSTIC EVENTS (FLIGHT RECORDER P1)".
Read before changing the diagnostic-events schema, the sink bridge, the batched writer, or the repository boundary rewrite. The contract holds the rules; this file is the record behind them.

Everything below is extracted verbatim from the contract as it stood before
distillation (2026-09-21). Corrections verified against the code today are
marked inline as **CORRECTION (2026-09-21)**; nothing else is rewritten.

---
**Table**: `brainstrike_diagnostic_events` (migration 073, numbered runner
`packages/db/src/migrations/073-diagnostic-events.ts` AND drizzle
`customMigrations` in `packages/db/src/drizzle/migrate.ts` —
`custom-073-diagnostic-events`). NO foreign keys (same precedent as
`run_usage` 046 / `run_outcomes` 062): correlation ids (`run_id`, `thread_id`,
`resource_id`, `root_id`) are nullable text and orphans are inert. `severity`
is a CHECK-constrained `warn | error | fatal`. Migration 076 adds the partial
`bst_diagnostic_events_run_idx (run_id, occurred_at DESC)` because P3 makes
the repository's existing run-id filter a hot correlation path.
`fingerprint` is computed at
write time (`computeDiagnosticFingerprint` in
`packages/utils/src/diagnostics/diagnostic-events.ts`) — a dependency-free
FNV-1a hash over `code|scope|normalized-message` with UUIDs/paths/hex/digits
stripped, so recurring errors with different ids/paths collapse to the same
fingerprint. `session_id` is a per-launch `crypto.randomUUID()`
(`getDiagnosticSessionId` in `diagnostic-sink-bridge.tsx`) correlating events
within one app run.

**Capture**: the existing `addLogListener` seam
(`packages/logging/src/logger.ts`) feeds `DiagnosticSinkBridge`
(`packages/app-shell/src/diagnostics/diagnostic-sink-bridge.tsx`), a
render-nothing component mounted ONLY in the two visible renderers
(`apps/web/src/main.tsx`, `apps/desktop/src/renderer/main.tsx`). Desktop main
and hidden renderer hosts have no PGlite handle of their own, so their warn+
records are pushed to a visible renderer over `logging:durable-record`
(desktop main → renderer) and consumed via the bridge's optional
`forwardedRecords` prop (`ForwardedRecordsSubscription`); a second channel,
`logging:ingest-buffered-record`, exists for pre-attach buffered records. The
bridge's own scope, `DIAGNOSTIC_SINK_SCOPE = 'DiagnosticSink'`, is excluded
from both the local listener and the forwarded-record consumer — the
loop guard that stops sink failures from re-entering the sink. Records become
`DiagnosticEvent`s via `logRecordToDiagnosticEvent`, which bounds
message/stack/context (`DIAGNOSTIC_MESSAGE_MAX_CHARS`/`STACK`/`CONTEXT` =
2000/8000/8000 chars, visibly marked via `boundWithMarker`, never silent) and
runs `redactSensitiveLogValue` over context before it is queued.

Hidden-renderer records cross `logging:ingest-buffered-record` through the
transport normalizer in `apps/desktop/src/renderer/main.tsx`. Log listeners
already receive key-redacted values from `redactSensitiveLogValue`; the
normalizer retains that privacy boundary for any unexpected raw `Error`, then
converts unsupported primitives and URLs for IPC. Its `WeakMap` memoizes arrays
and objects before recursion so self- or mutually-referential Error cause graphs
and bindings remain structured-cloneable instead of overflowing the listener
and dropping the record. Diagnostic context serialization visibly replaces
back-edges with `[Circular]` only after direct JSON serialization detects a
cycle, keeping acyclic context on the single redaction/serialization path.
Cause-chain cycles terminate with a visible `[Circular]` entry instead of
repeating to the depth cap. The renderer forwarding listener, redaction,
structured-clone topology, and bounded diagnostic conversion are paired in
`apps/desktop/src/__tests__/renderer/main.test.tsx`; Electron preload/main IPC
coverage remains in the desktop logging integration tests.

**Writer** (`DiagnosticEventWriter`,
`packages/utils/src/diagnostics/diagnostic-event-writer.ts`): batched
(`flushBatchSize` 32 events, `flushIntervalMs` 2000ms), never awaited on the
logging call path. `maxPending` (256) is a drop-oldest ring buffer; each drop
increments a counter that materializes into one loud
`diagnostics_events_dropped` marker event (fingerprint
`diagnostics_events_dropped`, severity `warn`) prepended to the next flush —
loss is never silent. After `maxConsecutiveFailures` (5) consecutive flush
failures the writer self-disables (`isDisabled`), drops its pending queue, and
calls `onDisabled`, which the bridge logs loudly via a plain (non-recursing)
`bridgeLogger.error`. `flush()`/`drain()` loop while more events keep arriving
mid-flight so nothing enqueued during an in-flight sink call is stranded. The
bridge also flushes on `visibilitychange` → `hidden`, so events survive tab
close/backgrounding. **Eager flush for high severity**: `DiagnosticSinkBridge`
calls `void writer.flush()` immediately after `enqueue()` whenever
`event.severity !== 'warn'` (both the local `addLogListener` path and the
`forwardedRecords` path) — `error`/`fatal` events do not wait for the batch
window, since `flush()` is single-flight (a concurrent call reuses the
in-flight promise) and browsers do not guarantee async work started inside a
`visibilitychange:hidden` handler completes before teardown. `warn` events
still batch normally on the 2s/32-event thresholds. Web close-durability
remains best-effort even with this: a batch of `warn` events inside the 2s
window can still be lost if the tab is killed (not merely hidden) mid-flush;
desktop's NDJSON file backstop (§7 of the design doc, moved to P2) is the
durable answer for that gap. The design's DB-corruption-recovery generation
subscription (re-arming the writer after a runtime DB swap) is NOT
implemented in P1 — this self-disable-after-repeated-flush-failures behavior,
with its visible `onDisabled` log, is the deliberate P1 substitute; revisit
once P2 surfaces sink health.

**Unstorable characters are rewritten at the repository boundary, visibly.**
PostgreSQL `text` cannot hold NUL (22021), and `jsonb` rejects both a NUL
escape (22P05) and a lone-surrogate escape (22P02). `insertBatch` is one
multi-row `INSERT` and the writer re-queues a failed batch whole, so one such
row fails every retry until `maxConsecutiveFailures` disables the writer and
drops everything pending. On 2026-09-15 forge-service logged its NUL-joined
in-memory PR cache key as `context.key`; each occurrence produced a burst of
five 22P05 failures, 2 s apart, and ended that writer. `insertBatch` therefore
rewrites every string it stores — each text column and every JSON key and
string value in `cause_chain`/`context` — replacing NUL with U+2400 (`␀`,
SYMBOL FOR NULL) and each lone surrogate with U+FFFD. U+FFFD is the
replacement `String.prototype.toWellFormed` makes, but the code uses a `u`-mode
regex because the record needs a count; `boundWithMarker` slices by UTF-16 code
unit and can split a pair. The row records the rewrite as
`context.storageReplacements`, a per-field count such as
`{ "context": 1, "stack": 2 }`, creating `context` when the event had none; the
key is reserved at this boundary. Each JSON field is serialized once, and only
text containing a `\u` escape (how `JSON.stringify` emits NUL and lone
surrogates) is parsed and walked. `toJSON` values are therefore rewritten
exactly as stored, and a storable row takes the same single-serialization path
as before, with no record. A non-string value passes through unchanged
(PGlite binds `undefined` as NULL): the rewrite must never throw itself, or it
recreates the retry loop it exists to end.

The rewrite is not injective. A JSON key or id that differs from another only
by a rewritten character versus its stand-in collapses into it: the later key
wins in `context`, and `ON CONFLICT (id) DO NOTHING` keeps the first row. This
is accepted rather than encoded, because an injective scheme would also have
to rewrite genuine `␀`/U+FFFD in storable rows, and producers mint ids with
`crypto.randomUUID()`. A rewritten row also no longer matches its NDJSON
backstop line byte for byte: the file keeps the original characters (JSON
escapes them), and the record says where they differ. `insertBatch` is the
only writer to this table. Do not replace this with per-row retry after a
batch failure (a fallback that still loses the row) or with silent stripping.
Paired: `diagnostic-events-repository.test.ts` (`characters PostgreSQL text
and jsonb cannot store`).

**Retention**: `DiagnosticEventsRepository.purge()`
(`packages/db/src/repositories/diagnostic-events-repository.ts`) is a bounded,
oldest-first `DELETE ... WHERE id IN (SELECT ... ORDER BY occurred_at ASC
LIMIT n)` past 30 days (`DIAGNOSTIC_RETENTION_MAX_AGE_MS`) OR past 20,000 rows
(`DIAGNOSTIC_RETENTION_MAX_ROWS`), capped at `DIAGNOSTIC_EVENTS_PURGE_LIMIT`
(500) rows per delete. It is invoked once on `DiagnosticSinkBridge` mount —
never an unbounded `DELETE`, never a trigger. Those two constants are only
the DEFAULTS: since P2b the mount-time purge reads the user's configured
values from `diagnostics-retention-store` (below), and the 500-row cap
applies INDEPENDENTLY to each of the two deletes (aged rows, over-cap rows),
so one `purge()` call can return up to 1000 and may still leave a backlog.

**Factory reset**: new persistence under this table must stay wired in BOTH
paths — desktop `db-ipc.ts` `OptionalRelationTable` list
(`clearOptionalRelation(tx, 'brainstrike_diagnostic_events')`) and web
`pglite-direct-transport.ts`'s reset table lists. Both currently include
`brainstrike_diagnostic_events`.
