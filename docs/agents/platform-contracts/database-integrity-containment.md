# Database integrity containment — evidence

Supports `docs/agents/platform-contracts.md` § "DATABASE INTEGRITY CONTAINMENT".
Read before proposing to change how an integrity error is handled, or before adding a repair rung. The contract holds the rules; this file is the record behind them.

**The rule: an integrity error never deletes, replaces, resets or reloads the database.** Detection contains; a person decides what happens to their data.

## What went wrong before (2026-09-29)

The database was wiped and recreated on 2026-07-17, 07-31, 09-05 and 09-29. Each time the runtime classified a Postgres integrity error as "corruption" and replaced the whole profile.

The 2026-09-29 chain, end to end: `db-ipc.ts` `runWithCorruptionRecovery` → `main.ts` `recoverRuntimeDatabaseAndReload` → `db-main.ts` `handleRuntimeCorruption` → `resetLocalDatabase` → `createResetBackup` + `rmSync` of the profile directory. The recorded trigger was `XX001` raised by pg_textsearch.

The database was not corrupt. `amcheck` found all 73 tables and every btree and GIN index intact, and a 12-second `REINDEX` fixed it. The wipe destroyed a database that a `REINDEX` repaired.

## The ruling

Owner ruling, 2026-09-29, not negotiable: corruption NEVER deletes, replaces or resets the database automatically. Only factory reset and the developer reset remove a profile, and both are confirmed by the user.

## What replaced it (rung 0: containment)

- One main-owned state, `healthy` → `contained { context, signal, since }`, in `database-integrity-state.ts`. Every entry point contains through `containDatabaseIntegrityError` (classify by SQLSTATE, contain, return a typed error). The call that hit the error rejects with `DatabaseIntegrityError` whose `cause` is the original.
- Containment pauses background work and leaves foreground work running, so the app stays usable and the person can still export or read what they have. The scheduler is the one enforcement point: it rejects `background` tasks at submission and again when a queued task would start. Owners that can skip quietly do (maintenance, dimension-index maintenance, assistant re-index); backfills are canceled at the transition; the embedding host parks its claim permit on the integrity state. A background task already running when containment begins is not interrupted and finishes its own bookkeeping: the HNSW build is an example, because when it raises `XX001` the same task still persists its failed status and error text.
- Live subscriptions, windows and the DB host are left alone. The old path tore down every live query, terminated the DB utility process and reloaded every visible window.
- Boot and migration do not enter this state (nothing is open to contain). They close the partial instance, record category `corruption`, keep the host alive so `db:diagnostics` reports the real failure, and delete nothing.

## Why reject background work rather than hold it

A held background task never settles, so shutdown's scheduler idle join (5 s, `DEFAULT_DATABASE_WORK_IDLE_TIMEOUT_MS`) would time out and force-exit, and `database.md` requires background work to stay short and bounded. Rejecting is bounded; each rejection is a typed, visible error. The embedding worker would otherwise loop `Critical worker error in processBatch` with a one second sleep and forward every error into the diagnostic-events table (a foreground write), which is why the host parks its claim permit instead. The error copy must never contain the word "closed": the embedding worker stops on any message that does.

## Why a restart resets the state

Rung 0 has no repair step that can prove integrity restored. Returning to `healthy` on a timer, a successful query or silence would resume background writes into a database with a known-bad page or index, which is silent degradation. A restart is safe because re-detection is cheap and visible: the next `XX001` contains again. Persisting containment across restarts would park indexing forever with no repair tooling. After a completed user-confirmed replacement the database that produced the signal no longer exists, so that clears the state too (`markDatabaseReplaced`, wired around `resetLocalDatabase` for both resets, so a failed reset never marks it healthy).

## Where an integrity error is not yet classified

Main writers that bypass the scheduler (Mastra memory, the forge PR cache, git/changes/checkpoints, user commands and personas) are foreground-owned and keep running while contained. An integrity error raised there is not classified today and stays a plain error. It is a follow-up, not a decision.

The HNSW build is a special case: `runNextDimensionIndexMaintenance` catches a failed build and records it as text, so the SQLSTATE is gone by the time the pass returns. The desktop scheduler therefore classifies inside its `createIndex` seam, the last place the code is still readable.

## What comes after rung 0

Containment is rung 0 of a repair ladder tracked in BST-1870; this change ships no repair. The rungs still to come are a repair step that diagnoses and runs `REINDEX` while contained (BST-1871 is to rebuild BM25 indexes on the first open after an unclean shutdown, the only measured source), a read-only mode, snapshots, and bridging boot-time integrity errors into this state. The ticket, not this file, holds their order. Each later rung adds a member to the state union; nothing may switch on `kind` without a `never` check.

Paired tests: `apps/desktop/src/__tests__/database-integrity-state.test.ts`, `platform/desktop-database-work.test.ts`, `main/ipc-handlers-db-integrity.test.ts`, `database-maintenance-scheduler.test.ts`, `dimension-index-maintenance-scheduler.test.ts`, and `main/db-main.lifecycle.test.ts`.
