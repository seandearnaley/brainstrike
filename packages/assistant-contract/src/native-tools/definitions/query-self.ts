import { defineNativeTool } from '../define.js';
import { providerCompatibleInputSchema } from '../schemas/provider-compatible-input.js';
import { QuerySelfInputSchema } from '../schemas/schemas-diagnostics.js';

/**
 * Worked example queries embedded in the `querySelf` description.
 *
 * Exported as a constant rather than prose so a test can EXECUTE them against a
 * migrated database (`packages/db/__tests__/agent-sql-service.test.ts`). A
 * broken example is worse than none — it teaches the model a column that does
 * not exist and costs it a turn — and this makes drift a build failure the day a
 * migration renames something, instead of a silent regression.
 *
 * Keep them short: this text is paid for on every request that loads the tool.
 */
export const QUERY_SELF_EXAMPLE_QUERIES: readonly string[] = [
  'SELECT path, count(*) AS reverts FROM brainstrike_assistant_edit_checkpoints WHERE reverted_at IS NOT NULL GROUP BY path ORDER BY reverts DESC',
];

// Read-only SQL over Brainstrike's OWN local database (run outcomes, edit
// checkpoints, usage, queue metrics, the code index). `riskCategory` is
// PINNED rather than derived: the input is arbitrary SQL, so a reader must
// see the bucket asserted at the declaration site. `read` is justified by the
// four engine-enforced sandbox layers in `AgentSqlService` — read-only
// transaction, non-superuser role, single-statement protocol, and EXPLAIN
// cost gate. See docs/agents/agent-self-query.md before changing this.
export const querySelf = defineNativeTool({
  defaults: {
    category: 'analysis',
    estimatedTokens: 260,
    loadingTier: 'deferred',
    requiresApproval: false,
    riskCategory: 'read',
  },
  description: `Run ONE read-only SQL SELECT over Brainstrike's own local Postgres: this assistant's history (run outcomes, edit checkpoints, usage/cost, queue metrics) plus the code index (file_records, file_chunks) and symbol graph (file_symbols, file_symbol_refs joined by name). Best for aggregates, trends, and call-graph traversal; search arms join a traversal in the same statement (BM25: content <@> to_bm25query('terms','idx_file_chunks_content_bm25') ASC; vector: embedding <=> a stored embedding). ALWAYS set mode: listTables first, then describeTable with table, then query or explain with sql; unused fields ignored. Saved lenses (.brainstrike/lenses/*.sql): mode listLenses, then mode lens with lens + values. Example sql: ${QUERY_SELF_EXAMPLE_QUERIES[0]}. Costly plans are refused with the estimate — narrow and retry. Catalog/stats views readable (pg_indexes, pg_stats, pg_settings, pg_stat_user_*), but pg_stat_* counters read 0 until you run SELECT pg_stat_force_next_flush()`,
  discovery: { family: 'DB self-query', namespace: 'database' },
  history: { recencyPrunable: true },
  id: 'brainstrike.querySelf',
  inputSchema: providerCompatibleInputSchema(QuerySelfInputSchema),
  kind: 'desktop',
  returns:
    'Column names once plus rows as positional arrays, with the row count, a truncation flag, and the planner cost estimate. Schema modes return table or column listings; explain returns the query plan',
  surfaces: ['desktop'],
});
