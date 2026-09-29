# Table durability classes — evidence

Supports `docs/agents/database.md` § "TABLE DURABILITY CLASSES".

Read before reclassifying a table, changing what a class permits, or building the repair ladder, snapshot verification or portable export on the registry. The contract holds the rules; this is the record behind the calls (BST-1876, 2026-09-29).

## Scope and method

`packages/db/src/table-durability-registry.ts` has 74 entries: the 71 `public` tables of a database migrated through 144 (listed from `pg_tables`), plus `mastra_vectors` and `mastra_workflow_snapshot` (created lazily by Mastra's vector and workflow stores, so a migrated database lacks them but real profiles have them) and the legacy `_migrations` ledger (created only by the test-only numbered runner; `runMigrations` refuses a database that has it, so it is classified but never repaired). The integration guard asserts those three are ABSENT from a migrated database, so a migration that starts creating one forces the exception off the list.

Each call read the table's migration header, its repository or writers, its readers, and its foreign keys. The tiebreakers, in order:

- A table with no automatic rebuild path is not `derived`, whatever it holds.
- `derived` is rebuilt CONTENT (files, chunks, embeddings, search text); `operational` is bookkeeping or a cache whose recompute is trivial. An embedding cache is `derived` because recompute may cost a hosted-provider call; a token-count cache is `operational`.
- When a table is neither cleanly derived nor cleanly disposable, take the class that protects the rows: `precious`.

## Rebuild owners

| Table | Owner | What repopulates it |
| --- | --- | --- |
| `file_records`, `file_chunks`, `file_symbols`, `file_symbol_refs` | `workspace-collection-sync-import.ts#runRootFolderCacheImport` | Background indexing (`WorkspaceCollectionSyncService`, triggered by the provider's effects and resync-on-visibility) re-scans each mounted root and re-imports records, chunks and symbols. |
| `embedding_cache` | `embedding-worker-cache-io.ts#storeToCacheAsync` | The embedding worker writes through as chunks are embedded, so it refills fully after `file_chunks` is rebuilt; truncated alone it stays cold until chunks re-embed. |
| `brainstrike_thread_message_index`, `brainstrike_thread_search_state` | `thread-search-repository.ts#ThreadSearchRepository` | `sync()` inserts missing index rows from `mastra_messages` in bounded batches and re-seeds missing state rows without re-extraction (its own comment covers the post-reset empty-state case). |
| `brainstrike_assistant_tool_projection_rewrites` | `tool-projection-rewrite-repository.ts#recordSuccessfulToolProjection` | After the next tracked tool call, the scan re-reads the thread's persisted invocations and re-commits supersession and prune overlays. It is per thread: an idle thread replays its full tool results (larger prompts, no data loss) until its next tracked tool call. |

## Hard calls

- **`file_*` are `derived`, but only the managed collection rebuilds automatically.** Manual imports (`ExplorerImportAction`, blocked for managed collections) are files the user selected into a user-created collection; nothing re-imports them, and the collection membership is lost with the rows. A repair that truncates these tables must either scope to the managed collection or report the manual-collection loss. Flip to `precious` if manual collections are judged first-class.
- **`embedding_cache` is `derived`, not `operational`.** It is a write-through cache that refills only as chunks embed; nothing rebuilds it wholesale. Kept `derived` because the loss is content whose recompute can cost provider calls. Flip to `operational` if the ladder should never trigger a rebuild for it.
- **`mastra_vectors` is `precious`.** Semantic recall writes vectors as messages are saved (opt-in: `semanticRecall.enabled` defaults to false, and the default embedder target is the hosted `openai/text-embedding-3-small`); no code re-embeds existing messages. Truncation loses recall over past conversations permanently. It becomes `derived` the day a re-embed-from-`mastra_messages` path exists.
- **`job_queue` is `operational`.** Its only job type is `embed_chunk`. `WorkspaceCollectionSyncService.finishSyncWithoutChanges` re-enqueues unembedded chunks of the managed collection (`needsEmbeddingBackfill`), so pending work survives. A manual collection has no automatic path: its chunks stay pending and visible until a manual backfill runs. Failed-job history and priority are lost.
- **Deletion, budget and handle state is `precious` on purpose.** `brainstrike_mind_ops` is write-only today but is the only record of a deletion a future sync would replay. The three `brainstrike_delegation_*` budget tables are per-turn accounting, and a delegated turn without its row fails visibly before inference. `brainstrike_mcp_tasks` and `brainstrike_mcp_task_authorities` hold the only handle to remote Tasks work. Each could be argued `operational`; the class that protects the rows won.
- **Migration-seeded singletons are `precious`.** `brainstrike_thread_search_profiles` and `prompt_embedding_profiles` are read-only at runtime and recreated only by a migration; `getEmbeddingProfile` throws "Run database migrations" without the row. They are `precious` because repair must never truncate them, not because a user wrote them. `models`, `providers` and `view_filter_presets` are `precious` for the user-toggled or user-authored rows they mix with seeded ones.
- **Debug-only evidence is `operational`.** `brainstrike_assistant_run_errors`, `_prompt_manifests`, `brainstrike_delegated_live_decisions`, `_wakeups` and `brainstrike_diagnostic_events` are read only by the thread debug export (`thread-debug-snapshot.ts`); no runtime decision or UI reads them. `brainstrike_assistant_run_treatments` is analytics evidence whose loss voids past experiment attribution but changes no behavior.
- **`brainstrike_assistant_tool_output_artifacts` is `operational`.** Retention is seven days by design, so truncation only shortens that window; older pages read as missing and the tool can be re-run.
- **`brainstrike_assistant_edit_checkpoints` is `precious`.** Rows are identity-only since the snapshot-undo swap (paths, hashes, `reverted_at`); Revert restores from `brainstrike_workspace_snapshots` shadow commits. Both are the record of real file changes, and nothing rebuilds either.
- **`file_tags`, `file_relationships` and `token_cache` are `operational`.** No code writes any of them. The first two cascade from `file_records`, so they cannot outlive a rebuild; the registry guard rejects any foreign key from a `precious` table to a non-`precious` one, so a feature that starts writing user tags must reclassify `file_tags` AND change the cascade. Dropping the three is a separate migration.

## What repair must name before truncating a non-precious table

Truncating is safe only for what the table's rebuild path actually restores. Before truncating ANY `derived` or `operational` table, repair tells the user every scope that path cannot rebuild and any user-visible pending work the truncation would drop, and never proceeds silently. Each limit is in the entry's `reason`; the concrete cases:

- `file_*`: only the managed collection rebuilds; manual-import collections need a re-import and lose their membership.
- `job_queue`: manual-collection embed jobs are not re-enqueued; those chunks stay pending until a manual backfill.
- `embedding_cache`: refills only when `file_chunks` re-embeds; truncated alone it stays cold.
- `brainstrike_assistant_tool_projection_rewrites`: rebuilt per thread on its next tracked tool call; an idle thread replays full results until then.

## What the classes do not cover

- The class is per table. `prompt_items.embedding` and `brainstrike_thread_message_index.embedding` are derivable columns, but only the second table is `derived`; re-deriving a column inside a `precious` table is a different repair.
- Truncating a `derived` table cascades through its foreign keys (`file_records` reaches `file_chunks`, `file_symbols`, `file_symbol_refs`, `file_relationships`, `file_tags`). `TRUNCATE ... CASCADE` empties every referencing table whatever its delete rule, and `SET NULL` / `SET DEFAULT` rewrite rows under a DELETE-based repair, so the registry guard rejects ANY foreign key (cascade, restrict, no action, set null, set default) from a `precious` table to a non-`precious` one. Every existing edge passed; a ladder must still truncate parents and children together.
- `roots` is `precious` and is the cascade parent of `file_records`: never truncate `roots` to "reset" the index.
