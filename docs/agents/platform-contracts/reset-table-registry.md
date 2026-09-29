# The reset-table registry and why the union cannot be derived — evidence

Supports `docs/agents/platform-contracts.md` § "FACTORY RESET CONTRACT".
Read before adding a table to, or excluding one from, `packages/db/src/reset-table-registry.ts`. The contract holds the rules; this file is the record behind them.

Everything below is extracted verbatim from the contract as it stood before
distillation (2026-09-21). Corrections verified against the code today are
marked inline as **CORRECTION (2026-09-21)**; nothing else is rewritten.

---
**CORRECTION (2026-09-21):** the counts in the next two paragraphs are stale.
`packages/db/src/reset-table-registry.ts` today clears **50** relations — 34
`BRAINSTRIKE_RESET_TABLES`, 9 `CORE_RESET_TABLES`, and **seven** Mastra
relations, because `getMastraResetTables()` also returns
`MASTRA_BACKGROUND_TASKS_TABLE` (`mastra_background_tasks`). The registry's own
docblock ("the full 41-relation reset set (26 Brainstrike + 9 core + the Mastra
six)") is stale in the same way. The registry is the source of truth; do not
restate its size anywhere.

Mastra owns six assistant-persistence relations, and a true fresh start clears
ALL SIX:

- `mastra_threads`
- `mastra_messages`
- `mastra_resources`
- `mastra_observational_memory`
- `mastra_vectors`
- `mastra_workflow_snapshot`

Every SQL path that enumerates tables clears all six: desktop `db:clearAll` in
`db-ipc.ts`, direct-PGlite `clearViaPGlite`, and direct-PGlite factory reset's
`purgeTablesTx` in `pglite-direct-transport.ts`.

**The SET those three lists clear is owned by the reset-table registry**
(`packages/db/src/reset-table-registry.ts`, BST-992): all three clear the same
47-relation set (32 `brainstrike_*` — including delegated conversation ancestry,
invocation identity, exact decisions and the three resource-budget tables,
the principal-bound `brainstrike_mcp_tasks` handle store, its durable authority-epoch ledger, and the `brainstrike_mind_ops`
op-log, whose tombstones must not outlive the mind they describe (BST-993),
and the `brainstrike_assistant_run_treatments` experiment-treatment store
(BST-1250; retained on thread delete like run_outcomes, but never a true
fresh start) — + 9 core/indexing + the Mastra six), and
the web factory reset (`purgeTablesTx`) additionally wipes the six seed-free
FACTORY-RESET-ONLY relations (`getFactoryResetOnlyTables()`: the three
caches, `job_queue_metrics`, and the two dimension-index bookkeeping tables)
— desktop factory reset already destroys them with the profile directory, so
this is the web↔desktop convergence. `view_filter_presets` is a MIXED
table — migration-SEEDED defaults plus user-authored presets — so the purge
issues a TARGETED `DELETE … WHERE is_default = FALSE`: user presets converge
with desktop (whose rebuild destroys and re-seeds), while the seeds survive
because the web purge never re-runs migrations. Only
per-path ORDER and mechanics differ (children before logical parents varies by
path, and desktop counts + bare-DELETEs `file_chunks`/`file_records`). The
registry exists because the union CANNOT be derived from the Drizzle schema —
the `brainstrike_*` assistant tables are migration-only raw DDL and the Mastra
six live in the assistant contract — and because the lists had already drifted
once: web's two paths silently omitted `brainstrike_assistant_run_usage`,
`_task_lists`, `_edit_checkpoints`, and `_message_parents` (BST-862's class),
so cost history, task lists, edit-checkpoint before-content, and branch
topology survived a web factory reset. Three instruments keep it closed:

- `reset-table-coverage.integration.test.ts` sweeps `information_schema` on a
  fully migrated database — every existing table must be in the registry or in
  `RESET_EXCLUDED_TABLES` with a written reason, so a new migration forces an
  explicit clear-or-exclude decision.
- Registry↔call-site parity: `reset-table-registry.test.tsx` (both renderer
  paths) and the `db:clearAll` set-equality test in `ipc-handlers-db.test.ts`
  (desktop) assert each path clears exactly its registry set —
  `getResetTables()` for the clear paths, `getFactoryResetTables()` for
  `purgeTablesTx`.
- The test-owned literal fixtures (below) stay deliberately independent of the
  registry so production and tests cannot drift together.

Both probe-helper unions derive from the registry
(`ClearableRelation` is `FactoryResetOnlyTable | ResetTable`; desktop's
`OptionalRelationTable` is `Exclude<ResetTable, 'file_chunks' |
'file_records'>`) — keep them derived, and keep them closed unions.

`brainstrike_assistant_thread_runs` and `brainstrike_assistant_run_events`
(migration 118 since BST-1651; previously renderer-lazy bootstrap DDL) are in NO
list on purpose: both cascade from `mastra_threads`
(`ON DELETE CASCADE`), which every list clears. If that FK is ever dropped —
migration 052 dropped its FKs for exactly this kind of reason — they start
silently surviving reset; move them into the registry in the same change.

Desktop factory reset is deliberately different: `resetLocalDatabase` closes
the database and recursively deletes the active profile directory, so it
removes the relations with the whole database rather than issuing
table-by-table `DELETE`s. Do not add a redundant SQL purge to that
directory-delete path.

Closing the default DB host manager permanently retires that owner before its
close handshake. Retained RemoteDbClient methods reject after retirement and
cannot fork a competing utility process against the replacement profile. An
explicit manager `close()` remains reusable by `reinitializeDatabase()`.
Desktop Mastra memory's two bounded caches are scoped to the actual database
object: completed memory and pending credential resolutions from the old owner
cannot become the replacement owner's storage. Database object identity is the
cache invalidation key; both reinitialization and default-manager retirement
create a fresh client. Run-scoped memory also pins its original owner before
credential resolution; a retired owner's operations fail visibly rather than
writing into the replacement profile. The paired manager tests and
`mastra-memory-database-owner.integration.test.ts` pin retirement, same-owner
reuse, and identical native thread IDs isolated across two real databases.

Two of these relations are still application-created lazily rather than
guaranteed by the migration chain: the vector store creates `mastra_vectors` and
the workflow store creates `mastra_workflow_snapshot`, so a never-used assistant
can legitimately lack either. Migration 117 (BST-1651) moved the four MEMORY
relations — threads, messages, resources, observational memory — into the chain,
though `PgliteMemoryStore.initialize()` still applies the same contract DDL
idempotently because standing its own schema up is Mastra's storage contract.
Every table-enumerating reset path must still PROBE each relation before deleting
it; absence is the only tolerated case, and every genuine probe or delete failure
stays visible.

`mastra_workflow_snapshot` has an UNBOUNDED lifetime — its only deletes are
`deleteWorkflowRunById` (no production caller) and `dangerouslyClearAll`
(tests) — and a suspended run retains its pending tool call and arguments, so it
must never survive reset (BST-558).

`mastra_vectors` receives an intentional blanket `DELETE`. Do not preserve its
`__index_metadata__` sentinel rows: they describe logical indexes owned by the
assistant session and are data, not durable schema. Mastra re-declares every
logical index through `createEmbeddingIndex` or
`createObservationEmbeddingIndex` immediately before each vector upsert/query
path; `PgliteVectorStore.createIndex` recreates the missing sentinel row and
ensures the physical per-dimension HNSW index before use. That self-healing
declaration contract is what makes a blanket delete correct. Filtering out
sentinel rows would let pre-reset logical index metadata survive a fresh start.
