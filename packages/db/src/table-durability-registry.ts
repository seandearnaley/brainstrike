/**
 * What losing each table costs the user (BST-1876).
 *
 * `reset-table-registry.ts` records only what factory reset clears. Repair,
 * snapshot verification and portable export need a different fact per table:
 * whether the rows can come back, and from where. Every table in a migrated
 * database is classified exactly once, into one of four classes:
 *
 * - `precious` — user-authored or user-intent state that cannot be recomputed
 *   deterministically: conversations, messages and threads, run history,
 *   prompts, mounted roots, user toggles (`models.is_enabled` makes `models`
 *   precious), anything LLM-generated that would cost a paid model call to
 *   reproduce (observational memory), and suspended-run snapshots (approvals
 *   waiting on the user). Automated repair NEVER truncates these, and a portable
 *   export includes them.
 * - `derived` — repopulated automatically by an EXISTING code path from files on
 *   disk or from precious tables (`file_records`/`file_chunks` by the indexing
 *   pipeline once roots are indexed). Repair may truncate and rebuild these. A
 *   `derived` entry MUST name that code path in `rebuildOwner`; a table with no
 *   automatic rebuild path is not derived, whatever it holds.
 * - `operational` — queues, leases, telemetry, diagnostics, rollups and caches
 *   whose loss costs the user nothing beyond recomputation that happens
 *   implicitly. Repair may truncate these without a rebuild. An entry whose
 *   truncation could lose user-visible work says so in `reason` and takes the
 *   class it honestly belongs to.
 * - `schema-ledger` — migration ledgers. Never truncated, always exported.
 *
 * The set of tables cannot be derived from the Drizzle schema (most tables are
 * migration-only raw DDL), so this registry is curated, and
 * `table-durability-registry.integration.test.ts` closes the drift class from the
 * other side: on a fully migrated database every table must be registered
 * exactly once, every entry must name a real table, and every `rebuildOwner`
 * must resolve to an exported symbol. A migration that adds a table without a
 * classification goes red there. The reasoning behind each call lives in
 * `docs/agents/database/table-durability-classes.md`.
 *
 * Table names are string literals, not imports of the Mastra constants: a
 * module-scope read of `@brainstrike/assistant-contract` bindings is the
 * chunk-initialization hazard `reset-table-registry.ts` documents (BST-558).
 */

export type TableDurabilityClass = 'precious' | 'derived' | 'operational' | 'schema-ledger';

type NonDerivedClass = Exclude<TableDurabilityClass, 'derived'>;

/** `repo/relative/path.ts#exportedSymbol`, resolved by the integration guard. */
export type RebuildOwner = `${string}.${'ts' | 'tsx'}#${string}`;

interface TableDurabilityEntryBase {
  /** One plain-English line: why this table has this class. */
  readonly reason: string;
  readonly table: string;
}

/** A discriminated union, so a `derived` entry without a rebuild owner does not compile. */
export type TableDurabilityEntry =
  | (TableDurabilityEntryBase & {
      readonly durability: 'derived';
      /** The existing code path that repopulates this table automatically. */
      readonly rebuildOwner: RebuildOwner;
    })
  | (TableDurabilityEntryBase & {
      readonly durability: NonDerivedClass;
      readonly rebuildOwner?: never;
    });

const classifiedAs =
  (durability: NonDerivedClass) =>
  (table: string, reason: string): TableDurabilityEntry => ({ durability, reason, table });
const precious = classifiedAs('precious');
const operational = classifiedAs('operational');
const schemaLedger = classifiedAs('schema-ledger');
const derived = (
  table: string,
  rebuildOwner: RebuildOwner,
  reason: string
): TableDurabilityEntry => ({ durability: 'derived', reason, rebuildOwner, table });

/** One import path writes the four `file_*` tables; the thread search sync owns two more. */
const SYNC_IMPORT_OWNER =
  'packages/app-shell/src/background-indexing/workspace-collection-sync-import.ts#runRootFolderCacheImport';
const THREAD_SEARCH_OWNER =
  'packages/db/src/repositories/thread-search-repository.ts#ThreadSearchRepository';

export const TABLE_DURABILITY_REGISTRY: readonly TableDurabilityEntry[] = [
  schemaLedger(
    '__drizzle_migrations',
    'The production migration ledger; truncating it makes the next start re-run every migration.'
  ),
  schemaLedger(
    '_migrations',
    'Legacy ledger created only by the test-only numbered runner; runMigrations refuses a database that has one, so it is never repaired.'
  ),
  precious(
    'brainstrike_assistant_compaction_ranges',
    'Records which messages each LLM-written compaction summary replaced; losing it re-inflates the prompt and the summary cannot be regenerated deterministically.'
  ),
  precious(
    'brainstrike_assistant_edit_checkpoints',
    'Journal of agent file edits (paths, hashes, reverted_at) that per-tool-card and per-turn Revert are built on; nothing rebuilds it.'
  ),
  precious(
    'brainstrike_assistant_message_parents',
    'Branch topology of conversations (parent links) layered over mastra_messages; user-visible structure with no other source.'
  ),
  precious(
    'brainstrike_assistant_message_tombstones',
    'Soft-rewind state (which messages the user rewound) that makes redo an exact inverse; user intent, not derivable.'
  ),
  precious(
    'brainstrike_assistant_native_runs',
    'Maps each native Mastra run to the host run that started it, the only way to resume a paused run into its generation.'
  ),
  operational(
    'brainstrike_assistant_prompt_manifests',
    'Append-only debug-pack evidence of the prompts sent; never read at runtime.'
  ),
  operational(
    'brainstrike_assistant_run_errors',
    'Provider-failure forensics read only by the thread debug export; the run header keeps the failure status.'
  ),
  precious(
    'brainstrike_assistant_run_events',
    'Durable run timeline shown in the thread, including tool.approval.requested rows for approvals still waiting on the user.'
  ),
  precious(
    'brainstrike_assistant_run_outcomes',
    'Per-run success labels, including explicit user verdicts (source = user) that cannot be recomputed.'
  ),
  operational(
    'brainstrike_assistant_run_treatments',
    'Experiment treatment evidence for analytics lenses; losing it voids past attribution but changes no behavior.'
  ),
  precious(
    'brainstrike_assistant_run_usage',
    'Per-run token counts and provider-billed cost behind cost history and the spend guardrail; not recomputable.'
  ),
  precious(
    'brainstrike_assistant_task_lists',
    'The assistant plan per thread, re-injected into every turn; LLM-authored and not recomputable.'
  ),
  precious(
    'brainstrike_assistant_thread_groups',
    'User-created thread folders (name, color, icon, order).'
  ),
  precious(
    'brainstrike_assistant_thread_placements',
    'Which folder and position each thread has in the Threads panel; user arrangement.'
  ),
  precious(
    'brainstrike_assistant_thread_runs',
    'Run history: one header per assistant run (status, model, settings) that every run-scoped sidecar references.'
  ),
  precious(
    'brainstrike_assistant_thread_workspaces',
    'Per-thread saved workspace layout (open tabs, expansions, pane state) the user arranged.'
  ),
  operational(
    'brainstrike_assistant_tool_output_artifacts',
    'Complete oversized tool outputs kept seven days by design; truncating shortens that window and older pages read as missing (the tool can be re-run).'
  ),
  derived(
    'brainstrike_assistant_tool_projection_rewrites',
    'apps/desktop/src/assistant-server/tool-projection-rewrite-repository.ts#recordSuccessfulToolProjection',
    'Prompt-time replay overlays over persisted tool results; re-detected per thread on its next tracked tool call, so an idle thread replays full results until then.'
  ),
  precious(
    'brainstrike_canvas_versions',
    'Agent-authored Canvas document versions; LLM-generated HTML that would cost a model call to reproduce.'
  ),
  precious(
    'brainstrike_delegated_continuation_decisions',
    'Exact approval and resume decisions admitted for a child continuation; stops an answered call from being answered or executed again.'
  ),
  precious(
    'brainstrike_delegated_continuations',
    'Human wake-admission ledger for delegated child threads, holding the user input text and paused state (awaiting approval or input).'
  ),
  precious(
    'brainstrike_delegated_conversations',
    'Ancestry graph of delegated child conversations (parent, root, name, color, configuration) layered over their mastra_threads.'
  ),
  precious(
    'brainstrike_delegated_invocations',
    'Identity and original tool call of each delegation, the access authority for the child conversation it created.'
  ),
  operational(
    'brainstrike_delegated_live_decisions',
    'Append-only debug-pack evidence of approval and resume decisions; never runtime authority.'
  ),
  precious(
    'brainstrike_delegated_tool_decisions',
    'Host admission of exact child tool approvals; permanent leaf uniqueness rejects repeat answers, and a retained row marks an effect that may already have run.'
  ),
  operational(
    'brainstrike_delegated_wakeups',
    'Append-only debug-pack evidence of why a parent run woke; never runtime authority.'
  ),
  precious(
    'brainstrike_delegation_budgets',
    'Per-turn delegation budget counters; a delegated turn without its row fails visibly before inference, so a paused turn could not resume.'
  ),
  precious(
    'brainstrike_delegation_child_budgets',
    'Per-child step and output-token counters under a delegation turn budget; spend already incurred cannot be rebuilt.'
  ),
  precious(
    'brainstrike_delegation_step_reservations',
    'Unsettled output-token reservations of in-flight delegated steps; settlement charges the child budget exactly once.'
  ),
  operational(
    'brainstrike_diagnostic_events',
    'Structured diagnostic log rows for the debug pack; nothing depends on them at runtime.'
  ),
  operational(
    'brainstrike_forge_prs',
    'Pull-request badge cache refreshed from gh on the next observation.'
  ),
  precious(
    'brainstrike_mcp_task_authorities',
    'Authority epochs binding MCP task handles to a live server definition; the parent of every durable task handle.'
  ),
  precious(
    'brainstrike_mcp_tasks',
    'Durable handles to remote MCP tasks that must resume after restart; the task id is the only way to reach the remote result.'
  ),
  precious(
    'brainstrike_mind_ops',
    'Append-only tombstones recording that a thread or prompt was deleted; the only record of the deletion, written for a future sync engine and read by nothing yet.'
  ),
  derived(
    'brainstrike_thread_message_index',
    THREAD_SEARCH_OWNER,
    'Search text and embeddings for threads, re-extracted from mastra_messages by the per-pass search sync.'
  ),
  precious(
    'brainstrike_thread_search_profiles',
    'Migration-seeded singleton embedding profile; no runtime path recreates it and thread search throws without it.'
  ),
  derived(
    'brainstrike_thread_search_state',
    THREAD_SEARCH_OWNER,
    'Per-thread refresh watermark; the search sync re-seeds a missing row without re-extracting messages.'
  ),
  operational(
    'brainstrike_token_estimate_calibration',
    'Estimator-versus-provider token pairs, pruned after 60 days; calibration evidence only.'
  ),
  operational(
    'brainstrike_tool_call_telemetry',
    'Counts-and-sizes-only per-tool telemetry; baselines for analytics lenses.'
  ),
  precious(
    'brainstrike_workspace_snapshots',
    'Turn-to-shadow-commit mapping that is the source of truth for rewinding workspace files; shadow refs only keep objects alive.'
  ),
  precious(
    'brainstrike_worktrees',
    'Ledger of git worktrees BrainStrike created; they outlive their threads and may hold uncommitted user work.'
  ),
  operational(
    'collection_indexing_stats',
    'Rollup recomputed from file_chunks by refreshCollectionIndexingStats; a missing row reads as unknown, not zero.'
  ),
  derived(
    'embedding_cache',
    'packages/embeddings/src/worker/embedding-worker-cache-io.ts#storeToCacheAsync',
    'Embeddings keyed by content hash and model; refilled by the embedding worker only as chunks re-embed, so truncated alone it stays cold.'
  ),
  operational(
    'embedding_dimension_index_maintenance',
    'Queue of HNSW index-build requests; a lost row delays an index rebuild.'
  ),
  operational(
    'embedding_dimension_index_suspensions',
    'Markers of suspended HNSW index builds; losing one can leave an index unbuilt until the next backfill requests it.'
  ),
  precious(
    'embedding_sets',
    'User-created collections (name, tags, model choice) and the managed workspace-index collection every indexed file points at.'
  ),
  derived(
    'file_chunks',
    SYNC_IMPORT_OWNER,
    'Chunks and embeddings of indexed files; rebuilt by re-indexing the managed collection (manual imports need a re-import; re-embedding costs provider calls on hosted models).'
  ),
  derived(
    'file_records',
    SYNC_IMPORT_OWNER,
    'Indexed copies of files under mounted roots; rebuilt from disk by background indexing (manual imports need a re-import).'
  ),
  operational(
    'file_relationships',
    'Unused: no code writes it, and it cascades from file_records so it cannot outlive a rebuild.'
  ),
  derived(
    'file_symbol_refs',
    SYNC_IMPORT_OWNER,
    'Symbol references extracted from indexed files; rebuilt together with file_records (manual imports need a re-import).'
  ),
  derived(
    'file_symbols',
    SYNC_IMPORT_OWNER,
    'Symbols extracted from indexed files; rebuilt together with file_records (manual imports need a re-import).'
  ),
  operational(
    'file_tags',
    'Unused: no code writes it, and it cascades from file_records so it cannot outlive a rebuild.'
  ),
  operational(
    'file_token_cache',
    'Token-count cache keyed by folder, path and content hash; recounted on the next lookup.'
  ),
  operational(
    'job_queue',
    "embed_chunk jobs only; sync re-enqueues unembedded chunks of the managed collection, but a manual collection's pending embeddings stay pending until a manual backfill."
  ),
  operational('job_queue_metrics', 'Lifetime queue succeeded, failed and canceled counters.'),
  precious(
    'mastra_background_tasks',
    'Native background tool tasks: a suspended task is never reaped, and an undelivered terminal result is the only copy the agent reads next turn.'
  ),
  precious('mastra_messages', 'The conversation transcript.'),
  precious(
    'mastra_observational_memory',
    'LLM-generated observations and reflections; reproducing them costs paid model calls.'
  ),
  precious('mastra_resources', 'Per-resource working memory (LLM-maintained notes) and metadata.'),
  precious(
    'mastra_threads',
    'Conversation threads: titles, metadata, and the parent every run, delegation and search sidecar hangs off.'
  ),
  precious(
    'mastra_vectors',
    'Semantic-recall embeddings written as messages are saved; nothing re-embeds existing messages, so truncation loses recall over past conversations for good.'
  ),
  precious(
    'mastra_workflow_snapshot',
    'Suspended-run snapshots holding pending tool calls and arguments for approvals waiting on the user; unbounded lifetime.'
  ),
  precious(
    'models',
    'Migration-seeded model catalog whose is_enabled toggle is user state; re-seeding is migration work.'
  ),
  precious(
    'prompt_embedding_profiles',
    'Migration-seeded singleton embedding profile for the prompt library; no runtime path recreates it.'
  ),
  precious('prompt_item_revisions', 'Revision history of user-authored prompts.'),
  precious(
    'prompt_items',
    'The user prompt library; the embedding column is derived but the authored rows are not.'
  ),
  precious(
    'providers',
    'Migration-seeded provider catalog whose is_enabled toggle is user state; re-seeding is migration work.'
  ),
  precious(
    'roots',
    'The folders the user mounted as workspace roots; every file_records row cascades from one.'
  ),
  operational(
    'selection_snapshot_files',
    'Members of an expiring file-selection snapshot; deleted with it.'
  ),
  operational(
    'selection_snapshots',
    'Expiring file-selection snapshots created per retrieval query; expired rows are deleted on the next snapshot.'
  ),
  operational(
    'token_cache',
    'Unused: no code reads or writes it (the live token cache is file_token_cache).'
  ),
  precious(
    'view_filter_presets',
    'User-authored file filter presets mixed with migration-seeded defaults that only a migration can restore.'
  ),
];

/**
 * Table to class. A table classified twice throws here, at construction, so a
 * duplicate fails the first import rather than letting one entry silently win.
 */
export function buildTableDurabilityIndex(
  entries: readonly TableDurabilityEntry[]
): ReadonlyMap<string, TableDurabilityClass> {
  const index = new Map<string, TableDurabilityClass>();
  for (const { durability, table } of entries) {
    if (index.has(table)) {
      throw new Error(`Table "${table}" is classified more than once; it must be exactly once.`);
    }
    index.set(table, durability);
  }
  return index;
}

const DURABILITY_BY_TABLE = buildTableDurabilityIndex(TABLE_DURABILITY_REGISTRY);

/**
 * The durability class of `table`. Throws for an unregistered table — a guess
 * here would let a repair truncate rows nobody classified.
 */
export function getTableDurability(table: string): TableDurabilityClass {
  const durability = DURABILITY_BY_TABLE.get(table);
  if (!durability) {
    throw new Error(
      `Table "${table}" has no durability class. Classify it in packages/db/src/table-durability-registry.ts (docs/agents/database.md § "TABLE DURABILITY CLASSES").`
    );
  }
  return durability;
}
