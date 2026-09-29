# Runtime corruption recovery, including the maintenance entry point — evidence

Supports `docs/agents/platform-contracts.md` § "RUNTIME DATABASE CORRUPTION RECOVERY".
Read before changing corruption classification, the recovery order, or the maintenance scheduler. The contract holds the rules; this file is the record behind them.

Everything below is extracted verbatim from the contract as it stood before
distillation (2026-09-21). Corrections verified against the code today are
marked inline as **CORRECTION (2026-09-21)**; nothing else is rewritten.

---
Runtime corruption recovery replaces the active local database and reloads the
visible renderer. The failing operation belongs to the old database snapshot
and MUST NOT be retried against the empty replacement.

Desktop order:
1. Invalidate the desktop scheduler generation and reject new DB work until
   renderer reload begins. Every scheduler handed to backfills or other detached
   work must route through the same generation check.
2. Cancel active embedding backfills. Recovery runs inside the single scheduler
   operation after its failing database call has settled. Do not wait for that
   scheduler to become idle from inside recovery: the current operation owns the
   lane. Queued closures can run only after recovery unwinds and must reject
   against the invalidated generation. Background-indexing IPC resolves after
   scheduling and finishes in a detached lifecycle; its terminal failure callback
   MUST classify corruption and enter this same recovery path after lifecycle
   cleanup settles.
3. Unsubscribe renderer live queries.
4. Terminate the DB utility process so all queued requests fail.
5. Back up and replace the active database profile, then initialize migrations.
6. Reload visible windows into the existing bounded startup progress flow.

Recovery is single-flight at the desktop composition root. Hidden renderer
hosts are excluded from visible-window reload routing. Do not replace this with
an unbounded blocking dialog; a recovered IPC call rejects with
`DatabaseCorruptionRecoveredError` and the already-scheduled reload remounts
all renderer state.

Scheduled database maintenance is an entry point too, not just IPC. A
maintenance pass that fails with an error `isCorruptionError` accepts (the same
rule `db:query` uses, never a copy) logs `Corruption detected in maintenance;
replacing the database without retrying.` and enters this path with context
`'maintenance'`. It does that inside its background-lane operation, before the
lane is released, exactly like `db:query`, and the pass rejects with
`DatabaseCorruptionRecoveredError`. `createDesktopDatabaseMaintenanceScheduler`
takes `onRuntimeCorruption` as a required option with no default, so a
composition cannot keep serving a database a pass has proven corrupt.
The maintenance timer logs every rejected pass as `Scheduled database
maintenance failed`. For a recovered pass the logged error is
`DatabaseCorruptionRecoveredError`; a non-corruption failure logs its own error
and never resets. A background trigger does not narrow the response.
Classification uses the same deliberately narrow rule (`XX000` stays excluded),
and the visible-window reload is still required, because live queries and
queued work belong to the database that was replaced. Measured case
(2026-09-15): an `XX001` found by
maintenance was only logged, and the app kept serving that database for about
nine hours until a `db:query` hit `XX001` and recovered. Paired tests: the
corruption-recovery block in
`apps/desktop/src/__tests__/database-maintenance-scheduler.test.ts`.

## Classification is SQLSTATE-only (BST-1869, 2026-09-29)

Before this change `isCorruptionError` (then in `db-main.ts`) matched the error's
SQLSTATE OR any of six free-text patterns against the lowercased message. One
pattern, `database system was interrupted`, is Postgres's NORMAL crash-recovery
log line, so an ordinary restart after a kill could read as corruption; any
pattern could also match user text echoed inside an unrelated error. Messages
are not a reliable signal in
either direction: the 2026-09-29 incident diagnosis found pg_textsearch damage
surfacing as `58P01 could not open file …`, with text that names the heap.

The rule now lives in `apps/desktop/src/database-corruption-classifier.ts`: an
error is corruption exactly when its `code` is `XX001` (data_corrupted) or
`XX002` (index_corrupted). `XX000` stays excluded and no message is ever
inspected. This does not by itself stop a wipe on a real `XX001` (the same
diagnosis recorded three recoveries on pg_textsearch `XX001`); the response to a
corruption signal is a separate decision from classifying one.
`classifyDatabaseCorruption` returns a signal carrying the identifier-only
Postgres fields (`routine`, `file`, `schema`, `table`), and the DB-host boundary
carries those same four fields (`DbHostSerializedError`) so the log names the
failing code path. It never carries `detail`, `where`, `hint`, `internalQuery`
or `position`, which can hold row data or SQL text
(`docs/diagnostics-privacy-contract.md`). Paired tests:
`apps/desktop/src/__tests__/database-corruption-classifier.test.ts` and the
error-transport cases in `apps/desktop/src/__tests__/main/db-host-entry.test.ts`
and `apps/desktop/src/__tests__/main/db-host-error-transport.test.ts`.
